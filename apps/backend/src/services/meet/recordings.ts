import { and, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import {
  blobs,
  meetings,
  newId,
  nodes,
  nodeVersions,
  organizations,
  recordings,
  spaces,
  users,
  type Db,
  type DbOrTx,
} from '@crewhall/db';
import { resources } from '@crewhall/i18n';
import { MEET_LIMITS, type MeetingRecording, type RecordingTarget } from '@crewhall/shared';
import type { Deps } from '../../deps';
import { AppError } from '../../http/errors';
import type { RequestInfo } from '../../http/types';
import type { Logger } from '../../logger';
import type { Jobs } from '../../jobs/queue';
import type { Bus } from '../../realtime/bus';
import type { Storage } from '../../storage/s3';
import { audit } from '../audit';
import { orgLimits, orgUsedBytes } from '../drive/quota';
import { adjustSpaceBytes, childPath, findByName, freeName, positionIn } from '../drive/tree';
import { ensurePersonalSpace } from '../spaces';
import {
  canRecord,
  liveSession,
  loadMeeting,
  spaceMeetSettings,
  usersByIds,
  type MeetActor,
  type MeetingRow,
  type RecordingRow,
} from './access';
import { notifyMeet, postMeetingEvent } from './chat-bridge';
import { roomMeta } from './join';
import { liveKit } from './livekit';
import { recordingOut } from './recordings-out';
import { meetEnabled } from './module';

/**
 * Recording (design 7.10-7.11, doc 17 §2 and §4): egress writes the MP4 straight to the
 * blob store; egress_ended queues recording.ingest, which turns the object into a Drive
 * file in the space's "Toplantı kayıtları" folder. Retention is a space setting.
 */

async function targetSpace(db: DbOrTx, m: MeetingRow, starter: { id: string; name: string }) {
  if (m.spaceId) {
    const [space] = await db.select().from(spaces).where(eq(spaces.id, m.spaceId));
    if (space) return space;
  }
  // Not attached to a space: the starter's personal space (design 7.10).
  return ensurePersonalSpace(db, m.orgId, starter);
}

async function freeBytes(db: DbOrTx, orgId: string, space: typeof spaces.$inferSelect) {
  const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId));
  const limits: (number | null)[] = [];
  if (space.quotaBytes !== null) {
    const [fresh] = await db
      .select({ used: spaces.usedBytes })
      .from(spaces)
      .where(eq(spaces.id, space.id));
    limits.push(space.quotaBytes - (fresh?.used ?? 0));
  }
  const orgQuota = org ? orgLimits(org).quotaBytes : null;
  if (orgQuota !== null) limits.push(orgQuota - (await orgUsedBytes(db, orgId)));
  const known = limits.filter((x): x is number => x !== null);
  return known.length ? Math.max(0, Math.min(...known)) : null;
}

async function folderName(db: DbOrTx, orgId: string) {
  const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId));
  return resources[org?.settings.defaultLocale ?? 'tr'].email.meet.recordingsFolder;
}

export async function recordingTarget(
  deps: Deps,
  a: MeetActor,
  meetingId: string,
): Promise<RecordingTarget> {
  const { db } = deps;
  const { meeting, access } = await loadMeeting(db, a, meetingId);
  if (!access.direct) throw new AppError('not_found');
  const space = await targetSpace(db, meeting, { id: a.userId, name: a.userName });
  const free = await freeBytes(db, a.org.id, space);
  const settings = (await spaceMeetSettings(db, [space.id])).get(space.id)!;
  const gw = liveKit(deps);
  return {
    spaceId: space.id,
    spaceName: space.name,
    folderName: await folderName(db, a.org.id),
    freeBytes: free,
    canStart:
      canRecord(access) &&
      Boolean(gw?.egressEnabled) &&
      (free === null || free >= MEET_LIMITS.recordingMinFreeBytes),
    retentionDays: settings.recordingRetentionDays,
  };
}

/** What stopping a recording needs (also from jobs). */
export type MeetSessionDeps = Pick<Deps, 'db' | 'bus' | 'jobs' | 'logger' | 'env'>;

async function announce(
  deps: MeetSessionDeps,
  m: MeetingRow,
  recordingId: string,
  active: boolean,
) {
  const gw = liveKit(deps);
  if (!gw) return;
  try {
    await gw.updateRoomMetadata(m.roomName, JSON.stringify(await roomMeta(deps.db, m)));
    await gw.sendSignal(m.roomName, { type: 'recording', recordingId, active });
  } catch (err) {
    deps.logger.warn({ err, room: m.roomName }, 'recording state not sent to the room');
  }
}

/** Starts egress; used by the endpoint and by auto-record on the first moderator's join. */
export async function startRecordingFor(
  deps: Deps,
  m: MeetingRow,
  starter: { id: string; name: string },
  audioOnly: boolean,
  req?: RequestInfo,
): Promise<RecordingRow> {
  const { db } = deps;
  const gw = liveKit(deps);
  if (!gw?.egressEnabled || !deps.storage) {
    throw new AppError('meet_recording_unavailable', { reason: 'egress_disabled' });
  }
  const session = await liveSession(db, m.id);
  if (!session) throw new AppError('meet_not_live');
  const [active] = await db
    .select({ id: recordings.id })
    .from(recordings)
    .where(
      and(
        eq(recordings.meetingId, m.id),
        inArray(recordings.status, ['starting', 'recording']),
        // Stopped by a moderator: egress is only finishing the file.
        isNull(recordings.endedAt),
      ),
    );
  if (active) throw new AppError('meet_recording_active');
  const space = await targetSpace(db, m, starter);
  const free = await freeBytes(db, m.orgId, space);
  if (free !== null && free < MEET_LIMITS.recordingMinFreeBytes) {
    throw new AppError('meet_recording_unavailable', { reason: 'quota', freeBytes: free });
  }

  const id = newId();
  const [row] = await db
    .insert(recordings)
    .values({
      id,
      orgId: m.orgId,
      meetingId: m.id,
      sessionId: session.id,
      status: 'starting',
      audioOnly,
      storageKey: `meet/${m.orgId}/${id}.${audioOnly ? 'm4a' : 'mp4'}`,
      spaceId: space.id,
      startedBy: starter.id,
    })
    .returning();
  let egressId: string;
  try {
    ({ egressId } = await gw.startRecording(m.roomName, {
      storageKey: row!.storageKey,
      audioOnly,
    }));
  } catch (err) {
    deps.logger.warn({ err, meetingId: m.id }, 'egress start failed');
    await db
      .update(recordings)
      .set({ status: 'failed', error: 'egress_start_failed', endedAt: new Date() })
      .where(eq(recordings.id, id));
    throw new AppError('meet_recording_unavailable', { reason: 'egress_unreachable' });
  }
  const [started] = await db
    .update(recordings)
    .set({ egressId, status: 'recording' })
    .where(eq(recordings.id, id))
    .returning();
  await announce(deps, m, id, true);
  await audit(
    db,
    {
      orgId: m.orgId,
      actorId: starter.id,
      action: 'meet.recording.start',
      targetType: 'meeting',
      targetId: m.id,
      meta: { recordingId: id, audioOnly },
    },
    req,
  );
  const conversationIds = [m.conversationId, m.chatConversationId].filter((x): x is string =>
    Boolean(x),
  );
  await postMeetingEvent(deps, {
    orgId: m.orgId,
    conversationIds,
    meetingId: m.id,
    sessionId: session.id,
    event: 'recording_started',
    actorId: starter.id,
    data: { recordingId: id },
  });
  return started!;
}

export async function startRecording(
  deps: Deps,
  a: MeetActor,
  meetingId: string,
  audioOnly: boolean,
  req: RequestInfo,
): Promise<MeetingRecording> {
  const { meeting, access } = await loadMeeting(deps.db, a, meetingId);
  if (!access.direct) throw new AppError('not_found');
  if (meeting.cancelledAt) throw new AppError('meet_ended');
  if (!canRecord(access)) throw new AppError('meet_recording_forbidden');
  const row = await startRecordingFor(
    deps,
    meeting,
    { id: a.userId, name: a.userName },
    audioOnly,
    req,
  );
  return recordingOut(deps.db, row);
}

/** Stops egress; the file arrives with egress_ended. Also used when the room empties. */
export async function stopRecordingRow(deps: MeetSessionDeps, r: RecordingRow, m: MeetingRow) {
  const gw = liveKit(deps);
  if (r.egressId && gw) {
    await gw.stopRecording(r.egressId).catch((err: unknown) => {
      deps.logger.warn({ err, recordingId: r.id }, 'egress stop failed');
    });
  }
  const [row] = await deps.db
    .update(recordings)
    .set({ endedAt: r.endedAt ?? new Date() })
    .where(eq(recordings.id, r.id))
    .returning();
  await announce(deps, m, r.id, false);
  return row!;
}

export async function stopRecording(
  deps: Deps,
  a: MeetActor,
  recordingId: string,
  req: RequestInfo,
): Promise<MeetingRecording> {
  const { db } = deps;
  const [r] = await db
    .select()
    .from(recordings)
    .where(and(eq(recordings.id, recordingId), eq(recordings.orgId, a.org.id)));
  if (!r) throw new AppError('not_found');
  const { meeting, access } = await loadMeeting(db, a, r.meetingId);
  if (!access.direct) throw new AppError('not_found');
  if (!canRecord(access)) throw new AppError('meet_recording_forbidden');
  if (r.status !== 'starting' && r.status !== 'recording') return recordingOut(db, r);
  const row = await stopRecordingRow(deps, r, meeting);
  await audit(
    db,
    {
      orgId: a.org.id,
      actorId: a.userId,
      action: 'meet.recording.stop',
      targetType: 'meeting',
      targetId: meeting.id,
      meta: { recordingId },
    },
    req,
  );
  return recordingOut(db, row);
}

export async function listRecordings(deps: Deps, a: MeetActor, meetingId: string) {
  const { meeting, access } = await loadMeeting(deps.db, a, meetingId);
  if (!access.direct) throw new AppError('not_found');
  const rows = await deps.db
    .select()
    .from(recordings)
    .where(eq(recordings.meetingId, meeting.id))
    .orderBy(desc(recordings.startedAt));
  const people = await usersByIds(
    deps.db,
    rows.map((r) => r.startedBy),
  );
  return Promise.all(rows.map((r) => recordingOut(deps.db, r, people)));
}

// ---- Worker -----------------------------------------------------------------------------

export interface MeetJobDeps {
  db: Db;
  storage: Storage | null;
  logger: Logger;
  jobs: Jobs;
  bus: Bus;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** "Milvaion haftalık · 2026-10-19 09.42.mp4" (local wall clock of the org, Istanbul default). */
function fileName(title: string, at: Date, ext: string) {
  const local = new Date(at.toLocaleString('en-US', { timeZone: 'Europe/Istanbul' }));
  const stamp = `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())} ${pad(local.getHours())}.${pad(local.getMinutes())}`;
  const clean =
    title
      .replace(/[\\/:*?"<>|]+/g, ' ')
      .trim()
      .slice(0, 120) || 'recording';
  return `${clean} · ${stamp}.${ext}`;
}

async function ensureFolder(
  tx: DbOrTx,
  orgId: string,
  spaceId: string,
  name: string,
  by: string | null,
) {
  const existing = await findByName(tx, spaceId, null, name);
  if (existing && existing.type === 'folder') return existing.id;
  const finalName = existing ? await freeName(tx, spaceId, null, name) : name;
  const id = newId();
  await tx.insert(nodes).values({
    id,
    orgId,
    spaceId,
    parentId: null,
    type: 'folder',
    name: finalName,
    position: await positionIn(tx, spaceId, null),
    path: childPath(null, id),
    createdBy: by,
    updatedBy: by,
  });
  return id;
}

/**
 * recording.ingest: the egress file becomes a blob and a Drive file. Idempotent: a ready
 * recording is left alone, and the folder is reused.
 */
export async function ingestRecording(deps: MeetJobDeps, recordingId: string) {
  const { db, storage, logger } = deps;
  const [r] = await db.select().from(recordings).where(eq(recordings.id, recordingId));
  if (!r || r.status === 'ready' || r.status === 'expired') return;
  if (!storage) {
    logger.warn({ recordingId }, 'recording ingest skipped: storage not configured');
    return;
  }
  const [m] = await db.select().from(meetings).where(eq(meetings.id, r.meetingId));
  if (!m) return;
  if (!(await meetEnabled(db, m.orgId))) {
    logger.info({ recordingId }, 'recording ingest skipped: meetings are off for the org');
    return;
  }
  const head = await storage.head(r.storageKey);
  if (!head || head.size === 0) {
    await db
      .update(recordings)
      .set({ status: 'failed', error: 'file_missing' })
      .where(eq(recordings.id, r.id));
    logger.warn({ recordingId, key: r.storageKey }, 'recording file missing');
    return;
  }
  const starter = r.startedBy
    ? (await db.select().from(users).where(eq(users.id, r.startedBy)))[0]
    : undefined;
  const spaceId =
    r.spaceId ??
    (starter ? (await ensurePersonalSpace(db, m.orgId, starter)).id : (m.spaceId as string | null));
  if (!spaceId) {
    await db
      .update(recordings)
      .set({ status: 'failed', error: 'no_space' })
      .where(eq(recordings.id, r.id));
    return;
  }
  const mime = r.audioOnly ? 'audio/mp4' : 'video/mp4';
  const folder = await folderName(db, m.orgId);

  const result = await db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(recordings)
      .where(eq(recordings.id, r.id))
      .for('update');
    if (!locked || locked.status === 'ready') return null;
    const folderId = await ensureFolder(tx, m.orgId, spaceId, folder, r.startedBy);
    const [parent] = await tx.select().from(nodes).where(eq(nodes.id, folderId));
    const [blob] = await tx
      .insert(blobs)
      .values({
        orgId: m.orgId,
        size: head.size,
        mime,
        storageKey: r.storageKey,
        status: 'pending',
        refCount: 1,
      })
      .onConflictDoNothing({ target: blobs.storageKey })
      .returning();
    const blobRow =
      blob ?? (await tx.select().from(blobs).where(eq(blobs.storageKey, r.storageKey)))[0]!;
    const name = await freeName(
      tx,
      spaceId,
      folderId,
      fileName(m.title, r.startedAt, r.audioOnly ? 'm4a' : 'mp4'),
    );
    const nodeId = newId();
    await tx.insert(nodes).values({
      id: nodeId,
      orgId: m.orgId,
      spaceId,
      parentId: folderId,
      type: 'file',
      name,
      mime,
      sizeBytes: head.size,
      position: await positionIn(tx, spaceId, folderId),
      path: childPath(parent!.path, nodeId),
      createdBy: r.startedBy,
      updatedBy: r.startedBy,
    });
    const [version] = await tx
      .insert(nodeVersions)
      .values({
        orgId: m.orgId,
        nodeId,
        version: 1,
        blobId: blobRow.id,
        sizeBytes: head.size,
        mime,
        source: 'api',
        createdBy: r.startedBy,
      })
      .returning();
    await tx.update(nodes).set({ currentVersionId: version!.id }).where(eq(nodes.id, nodeId));
    await adjustSpaceBytes(tx, spaceId, head.size);
    await tx
      .update(recordings)
      .set({
        status: 'ready',
        blobId: blobRow.id,
        nodeId,
        spaceId,
        sizeBytes: head.size,
        endedAt: r.endedAt ?? new Date(),
        error: null,
      })
      .where(eq(recordings.id, r.id));
    return { blobId: blobRow.id, nodeId, fresh: Boolean(blob) };
  });
  if (!result) return;
  if (result.fresh) await deps.jobs.send('blob.process', { blobId: result.blobId });
  logger.info({ recordingId, nodeId: result.nodeId }, 'recording saved to Drive');
  // AI meeting notes (yol haritası #12); the job does nothing unless the org turned them on.
  await deps.jobs.send('ai.meeting_notes', { recordingId });

  const conversationIds = [m.conversationId, m.chatConversationId].filter((x): x is string =>
    Boolean(x),
  );
  await postMeetingEvent(deps, {
    orgId: m.orgId,
    conversationIds,
    meetingId: m.id,
    sessionId: r.sessionId,
    event: 'recording_ready',
    actorId: r.startedBy,
    data: { recordingId: r.id, nodeId: result.nodeId, durationSeconds: r.durationS },
  });
  if (r.startedBy) {
    await notifyMeet(deps, {
      orgId: m.orgId,
      userIds: [r.startedBy],
      type: 'meet.recording_ready',
      actorId: null,
      meetingId: m.id,
      url: `/drive/node/${result.nodeId}`,
      data: { title: m.title, nodeId: result.nodeId },
    });
  }
}

/**
 * recording.retention (nightly): ready recordings older than their space's retention go to
 * the trash (and are purged 30 days later like any file). Doc 17 §15 item 8.
 */
export async function expireRecordings(deps: Pick<MeetJobDeps, 'db' | 'logger'>, now = new Date()) {
  const { db, logger } = deps;
  const rows = await db
    .select({
      r: recordings,
      days: sql<number | null>`coalesce(
        (select recording_retention_days from meet_space_settings s where s.space_id = ${recordings.spaceId}),
        ${MEET_LIMITS.defaultRetentionDays})`,
    })
    .from(recordings)
    .where(eq(recordings.status, 'ready'));
  const due = rows.filter(
    ({ r, days }) =>
      days !== null && r.startedAt.getTime() + Number(days) * 86_400_000 < now.getTime(),
  );
  // A space that keeps recordings has its row with null; coalesce above would hide that.
  const keep = new Set(
    (
      await db.execute<{ space_id: string }>(
        sql`select space_id from meet_space_settings where recording_retention_days is null`,
      )
    ).rows.map((x) => x.space_id),
  );
  let count = 0;
  const enabled = new Map<string, boolean>();
  for (const { r } of due) {
    if (r.spaceId && keep.has(r.spaceId)) continue;
    if (!enabled.has(r.orgId)) enabled.set(r.orgId, await meetEnabled(db, r.orgId));
    if (!enabled.get(r.orgId)) continue;
    await db.transaction(async (tx) => {
      if (r.nodeId) {
        await tx
          .update(nodes)
          .set({ deletedAt: now, deletedBy: null })
          .where(and(eq(nodes.id, r.nodeId), isNull(nodes.deletedAt)));
      }
      await tx.update(recordings).set({ status: 'expired' }).where(eq(recordings.id, r.id));
    });
    count++;
  }
  if (count) logger.info({ count }, 'expired meeting recordings moved to the trash');
  return count;
}

/** Recordings stuck in "recording" for a day (lost webhook) are marked failed. */
export async function failStaleRecordings(db: DbOrTx) {
  await db
    .update(recordings)
    .set({ status: 'failed', error: 'no_egress_result' })
    .where(
      and(
        inArray(recordings.status, ['starting', 'recording', 'processing']),
        lt(recordings.startedAt, new Date(Date.now() - 24 * 3_600_000)),
      ),
    );
}
