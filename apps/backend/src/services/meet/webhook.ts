import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  meetingParticipants,
  meetings,
  meetingSessions,
  recordings,
  users,
  type DbOrTx,
} from '@crewhall/db';
import { MEET_IDENTITY, MeetParticipantMeta, type MeetingRole } from '@crewhall/shared';
import type { Deps } from '../../deps';
import { AppError } from '../../http/errors';
import { publishToUsers } from '../../realtime';
import {
  ensureSession,
  liveSession,
  requireModerator,
  type MeetActor,
  type MeetingRow,
  type SessionRow,
} from './access';
import { callAfterLeave, closeCallRoom, endCallsOfMeeting, liveCallOfMeeting } from './calls';
import { postMeetingEvent } from './chat-bridge';
import { requireLiveKit, roomMeta } from './join';
import { liveKit, type LiveParticipant, type LiveRoom, type MeetWebhookEvent } from './livekit';
import { startRecordingFor, stopRecordingRow, type MeetSessionDeps } from './recordings';
import { meetEnabled } from './module';
import { refreshMeetingPresence, screenSharePresence } from './presence';

/**
 * LiveKit → api webhooks (doc 17 §2): participant_joined/left fill meeting_participants,
 * room_started/finished open and close sessions, egress_* drive recordings.
 * LiveKit retries deliveries, so every step is idempotent.
 */

async function meetingByRoom(db: DbOrTx, roomName: string) {
  const [m] = await db.select().from(meetings).where(eq(meetings.roomName, roomName));
  return m ?? null;
}

async function activeCount(db: DbOrTx, sessionId: string) {
  const [row] = await db
    // People, not connections: someone on two devices is one person.
    .select({
      n: sql<number>`count(distinct coalesce(${meetingParticipants.userId}::text, ${meetingParticipants.identity}))::int`,
    })
    .from(meetingParticipants)
    .where(and(eq(meetingParticipants.sessionId, sessionId), isNull(meetingParticipants.leftAt)));
  return row?.n ?? 0;
}

function metaRole(raw: string): MeetingRole {
  try {
    const parsed = MeetParticipantMeta.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data.role : 'member';
  } catch {
    return 'member';
  }
}

async function activeRecordings(db: DbOrTx, meetingId: string) {
  return db
    .select()
    .from(recordings)
    .where(
      and(
        eq(recordings.meetingId, meetingId),
        inArray(recordings.status, ['starting', 'recording']),
        // Stopped by a moderator: egress is only finishing the file.
        isNull(recordings.endedAt),
      ),
    );
}

/** Closes a session: open joins end now, recordings stop, chat gets the "bitti" line. */
export async function endSession(
  deps: MeetSessionDeps,
  m: MeetingRow,
  session: SessionRow,
  at = new Date(),
  /** A call's room closing: the call wrote its own line already. */
  opts: { quiet?: boolean } = {},
) {
  const { db } = deps;
  const [ended] = await db
    .update(meetingSessions)
    .set({ endedAt: at })
    .where(and(eq(meetingSessions.id, session.id), isNull(meetingSessions.endedAt)))
    .returning();
  if (!ended) return;
  const inside = await db
    .selectDistinct({ userId: meetingParticipants.userId })
    .from(meetingParticipants)
    .where(and(eq(meetingParticipants.sessionId, session.id), isNull(meetingParticipants.leftAt)));
  publishToUsers(
    deps.bus,
    inside.flatMap((p) => (p.userId ? [p.userId] : [])),
    { type: 'meet.active' },
  );
  await db
    .update(meetingParticipants)
    .set({ leftAt: at })
    .where(and(eq(meetingParticipants.sessionId, session.id), isNull(meetingParticipants.leftAt)));
  await db.update(meetings).set({ endedAt: at }).where(eq(meetings.id, m.id));
  for (const r of await activeRecordings(db, m.id)) await stopRecordingRow(deps, r, m);
  // A call's room: the call's own history line replaces the meeting's "bitti" (H7).
  if (await endCallsOfMeeting(deps, m.id, at)) return;
  if (opts.quiet) return;
  const conversationIds = [m.conversationId, m.chatConversationId].filter((x): x is string =>
    Boolean(x),
  );
  await postMeetingEvent(deps, {
    orgId: m.orgId,
    conversationIds,
    meetingId: m.id,
    sessionId: session.id,
    event: 'ended',
    actorId: null,
    data: { durationSeconds: Math.round((at.getTime() - session.startedAt.getTime()) / 1000) },
  });
}

async function participantJoined(deps: Deps, m: MeetingRow, e: MeetWebhookEvent) {
  const { db } = deps;
  const p = e.participant!;
  const id = MEET_IDENTITY.parse(p.identity);
  // Egress and other server participants are not people.
  if (!id) return;
  const at = p.joinedAt ?? e.createdAt;
  const { session } = await ensureSession(db, m, e.room?.sid ?? null, at);
  const userId = id.kind === 'user' ? id.id : null;
  const exists = userId
    ? (await db.select({ id: users.id }).from(users).where(eq(users.id, userId))).length > 0
    : false;
  const role = metaRole(p.metadata);
  const inserted = await db
    .insert(meetingParticipants)
    .values({
      orgId: m.orgId,
      meetingId: m.id,
      sessionId: session.id,
      identity: p.identity,
      participantSid: p.sid || null,
      userId: exists ? userId : null,
      guestName: exists ? null : p.name,
      role,
      joinedAt: at,
    })
    .onConflictDoNothing()
    .returning({ id: meetingParticipants.id });
  // The first person in starts the session for chat; room_started may have opened it already.
  const first =
    inserted.length > 0 &&
    (
      await db
        .select({ n: sql<number>`count(*)::int` })
        .from(meetingParticipants)
        .where(eq(meetingParticipants.sessionId, session.id))
    )[0]!.n === 1;
  const count = await activeCount(db, session.id);
  await db
    .update(meetingSessions)
    .set({
      peakParticipants: sql`greatest(${meetingSessions.peakParticipants}, ${count})`,
      startedBy: session.startedBy ?? (exists ? userId : null),
    })
    .where(eq(meetingSessions.id, session.id));

  if (first && !(await liveCallOfMeeting(db, m.id))) {
    const conversationIds = [m.conversationId, m.chatConversationId].filter((x): x is string =>
      Boolean(x),
    );
    await postMeetingEvent(deps, {
      orgId: m.orgId,
      conversationIds,
      meetingId: m.id,
      sessionId: session.id,
      event: 'started',
      actorId: exists ? userId : null,
      data: { title: m.title },
    });
  }
  // Design 7.2 "Otomatik kaydet": the first moderator in starts it.
  if (m.settings.autoRecord && role === 'moderator' && exists && userId) {
    if ((await activeRecordings(db, m.id)).length === 0) {
      await startRecordingFor(deps, m, { id: userId, name: p.name }, false).catch((err: unknown) =>
        deps.logger.warn({ err, meetingId: m.id }, 'auto-record did not start'),
      );
    }
  }
}

async function participantLeft(deps: Deps, m: MeetingRow, e: MeetWebhookEvent) {
  const { db } = deps;
  const p = e.participant!;
  if (!MEET_IDENTITY.parse(p.identity)) return;
  const session = await liveSession(db, m.id);
  if (!session) return;
  await db
    .update(meetingParticipants)
    .set({ leftAt: e.createdAt })
    .where(
      and(
        eq(meetingParticipants.sessionId, session.id),
        isNull(meetingParticipants.leftAt),
        p.sid
          ? eq(meetingParticipants.participantSid, p.sid)
          : eq(meetingParticipants.identity, p.identity),
      ),
    );
  // Design 7.11: recording stops when the last moderator leaves.
  const recs = await activeRecordings(db, m.id);
  if (recs.length) {
    const [mods] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(meetingParticipants)
      .where(
        and(
          eq(meetingParticipants.sessionId, session.id),
          isNull(meetingParticipants.leftAt),
          eq(meetingParticipants.role, 'moderator'),
        ),
      );
    if ((mods?.n ?? 0) === 0) for (const r of recs) await stopRecordingRow(deps, r, m);
  }
  const left = await activeCount(db, session.id);
  // The last one out: the room closes shortly (a reconnect or a quick return keeps it).
  if (left === 0) {
    await deps.jobs.send(
      'meet.room_empty',
      { meetingId: m.id, sessionId: session.id },
      {
        startAfterSeconds: EMPTY_ROOM_GRACE_SECONDS,
        singletonKey: `empty:${session.id}:${Date.now()}`,
      },
    );
  }
  // H7: a one-to-one call ends when either side hangs up; a reconnect gets a few seconds.
  if (await callAfterLeave(deps, m.id, session.id, left)) {
    await deps.jobs.send(
      'meet.call_hangup',
      { meetingId: m.id, sessionId: session.id },
      { startAfterSeconds: HANGUP_GRACE_SECONDS, singletonKey: `hangup:${session.id}` },
    );
  }
}

/**
 * Seconds an empty room stays open before its session ends and it moves to the history. LiveKit's
 * own departure timeout (MEET_LIMITS.emptyRoomSeconds) is longer and stays as the fallback.
 */
export const EMPTY_ROOM_GRACE_SECONDS = 30;

/** Job: nobody came back to the room, so it closes and the meeting moves to the history. */
export async function emptyRoomCheck(deps: MeetSessionDeps, meetingId: string, sessionId: string) {
  const { db } = deps;
  const session = await liveSession(db, meetingId);
  if (!session || session.id !== sessionId) return;
  if ((await activeCount(db, sessionId)) > 0) return;
  const [m] = await db.select().from(meetings).where(eq(meetings.id, meetingId));
  if (!m) return;
  await closeCallRoom(deps, m.roomName);
  await endSession(deps, m, session);
}

/**
 * Closes a call's room now (one-to-one call missed, declined, cancelled or hung up): everyone in
 * it is told and LiveKit drops the room, and the session ends here instead of waiting for
 * LiveKit's webhooks, which a proxy or a wrong webhook address may never deliver.
 */
export async function closeCallSession(deps: MeetSessionDeps, meetingId: string) {
  const [m] = await deps.db.select().from(meetings).where(eq(meetings.id, meetingId));
  if (!m) return;
  await closeCallRoom(deps, m.roomName);
  const session = await liveSession(deps.db, meetingId);
  if (session) await endSession(deps, m, session, new Date(), { quiet: true });
}

/** Seconds a one-to-one call waits for the other side to come back before it ends. */
export const HANGUP_GRACE_SECONDS = 4;

/** Job: the other side did not come back, so the call ends for both (room closed). */
export async function hangupCheck(deps: MeetSessionDeps, meetingId: string, sessionId: string) {
  const { db } = deps;
  const session = await liveSession(db, meetingId);
  if (!session || session.id !== sessionId) return;
  if (!(await callAfterLeave(deps, meetingId, sessionId, await activeCount(db, sessionId)))) return;
  const [m] = await db.select().from(meetings).where(eq(meetings.id, meetingId));
  if (!m) return;
  await closeCallRoom(deps, m.roomName);
  await endSession(deps, m, session);
}

async function egressEvent(deps: Deps, e: MeetWebhookEvent) {
  const { db } = deps;
  const eg = e.egress!;
  const [r] = await db.select().from(recordings).where(eq(recordings.egressId, eg.egressId));
  if (!r || r.status === 'ready' || r.status === 'expired') return;
  if (!(await meetEnabled(db, r.orgId))) return;
  if (e.event === 'egress_started' || (e.event === 'egress_updated' && eg.status === 'active')) {
    if (r.status === 'starting') {
      await db.update(recordings).set({ status: 'recording' }).where(eq(recordings.id, r.id));
    }
    return;
  }
  const done = eg.status === 'complete' || eg.status === 'limit_reached';
  const failed = eg.status === 'failed' || eg.status === 'aborted';
  if (e.event === 'egress_ended' || failed) {
    if (done) {
      await db
        .update(recordings)
        .set({
          status: 'processing',
          endedAt: r.endedAt ?? e.createdAt,
          durationS: eg.durationSeconds ?? r.durationS,
          sizeBytes: eg.sizeBytes ?? r.sizeBytes,
        })
        .where(eq(recordings.id, r.id));
      await deps.jobs.send('recording.ingest', { recordingId: r.id });
    } else {
      await db
        .update(recordings)
        .set({ status: 'failed', error: eg.error ?? eg.status, endedAt: r.endedAt ?? e.createdAt })
        .where(eq(recordings.id, r.id));
    }
    const [m] = await db.select().from(meetings).where(eq(meetings.id, r.meetingId));
    const gw = liveKit(deps);
    if (m && gw) {
      // Egress may end on its own (failure, limit): the room's indicator follows.
      await gw
        .updateRoomMetadata(m.roomName, JSON.stringify(await roomMeta(db, m)))
        .catch(() => undefined);
      await gw
        .sendSignal(m.roomName, { type: 'recording', recordingId: r.id, active: false })
        .catch(() => undefined);
    }
  }
}

/** Seconds after which what LiveKit says beats what the webhooks have told us so far. */
const RECONCILE_GRACE_MS = 60_000;

/**
 * Job, every minute: makes sessions and participants match what LiveKit reports. Webhooks are
 * quick but not guaranteed: a wrong webhook address on a shared LiveKit or a proxy in between and
 * none arrive, so no session would ever open, nobody would be "in the meeting" and the history
 * would stay empty. Everything here goes through the same idempotent steps as the webhooks, so
 * with webhooks working it changes nothing.
 */
export async function reconcileRooms(deps: Deps, now = new Date()) {
  const { db } = deps;
  const gw = liveKit(deps);
  if (!gw) return;
  let rooms: LiveRoom[];
  try {
    rooms = await gw.listRooms();
  } catch (err) {
    deps.logger.warn({ err }, 'meet reconcile: rooms not available');
    return;
  }
  const byName = new Map(
    rooms.filter((r) => /^m-[0-9a-f-]{36}$/i.test(r.name)).map((r) => [r.name, r]),
  );

  for (const room of byName.values()) {
    if (!room.numParticipants) continue;
    const m = await meetingByRoom(db, room.name);
    if (!m || !(await meetEnabled(db, m.orgId))) continue;
    let people: LiveParticipant[];
    try {
      people = await gw.listParticipants(room.name);
    } catch (err) {
      deps.logger.warn({ err, room: room.name }, 'meet reconcile: participants not available');
      continue;
    }
    const session = await liveSession(db, m.id);
    const known = session
      ? await db
          .select()
          .from(meetingParticipants)
          .where(
            and(eq(meetingParticipants.sessionId, session.id), isNull(meetingParticipants.leftAt)),
          )
      : [];
    const event = (identity: string, sid: string | null, name: string, metadata: string) => ({
      id: `reconcile:${room.sid}:${identity}`,
      createdAt: now,
      room: { sid: room.sid, name: room.name },
      participant: { sid: sid ?? '', identity, name, metadata, joinedAt: null },
      track: null,
      egress: null,
    });
    const inside = new Set(known.map((p) => p.identity));
    const changed: string[] = [];
    for (const p of people) {
      if (inside.has(p.identity) || !MEET_IDENTITY.parse(p.identity)) continue;
      const e = event(p.identity, p.sid ?? null, p.name, p.metadata);
      await participantJoined(deps, m, {
        ...e,
        event: 'participant_joined',
        participant: { ...e.participant, joinedAt: p.joinedAt ?? null },
      });
      changed.push(p.identity);
    }
    const here = new Set(people.map((p) => p.identity));
    for (const p of known) {
      if (here.has(p.identity)) continue;
      if (now.getTime() - p.joinedAt.getTime() < RECONCILE_GRACE_MS) continue;
      await participantLeft(deps, m, {
        ...event(p.identity, p.participantSid, '', ''),
        event: 'participant_left',
      });
      changed.push(p.identity);
    }
    if (changed.length) await meetingPresence(deps, m.orgId, changed);
  }

  // Sessions whose room is gone or has stood empty past the grace time.
  const open = await db
    .select({ session: meetingSessions, meeting: meetings })
    .from(meetingSessions)
    .innerJoin(meetings, eq(meetings.id, meetingSessions.meetingId))
    .where(isNull(meetingSessions.endedAt));
  for (const { session, meeting } of open) {
    if (now.getTime() - session.startedAt.getTime() < RECONCILE_GRACE_MS) continue;
    if (byName.get(meeting.roomName)?.numParticipants) continue;
    if (!(await meetEnabled(db, meeting.orgId))) continue;
    const inside = await db
      .select({ identity: meetingParticipants.identity, joinedAt: meetingParticipants.joinedAt })
      .from(meetingParticipants)
      .where(
        and(eq(meetingParticipants.sessionId, session.id), isNull(meetingParticipants.leftAt)),
      );
    await closeCallRoom(deps, meeting.roomName);
    await endSession(deps, meeting, session, now);
    if (inside.length) {
      await meetingPresence(
        deps,
        meeting.orgId,
        inside.map((p) => p.identity),
      );
    }
  }
}

export async function handleWebhook(deps: Deps, body: string, authorization: string | undefined) {
  const gw = liveKit(deps);
  if (!gw) throw new AppError('meet_unavailable', { reason: 'not_configured' });
  let event: MeetWebhookEvent;
  try {
    event = await gw.receiveWebhook(body, authorization);
  } catch (err) {
    deps.logger.warn({ err }, 'livekit webhook rejected');
    throw new AppError('meet_webhook_invalid');
  }
  deps.logger.debug({ event: event.event, room: event.room?.name }, 'livekit webhook');

  if (event.event.startsWith('egress_') && event.egress) return egressEvent(deps, event);
  const roomName = event.room?.name;
  if (!roomName) return;
  const m = await meetingByRoom(deps.db, roomName);
  // Meetings switched off for the org: LiveKit events are ignored.
  if (!m || !(await meetEnabled(deps.db, m.orgId))) return;
  switch (event.event) {
    case 'room_started':
      await ensureSession(deps.db, m, event.room!.sid, event.createdAt);
      return;
    case 'participant_joined':
      if (event.participant) {
        await participantJoined(deps, m, event);
        await meetingPresence(deps, m.orgId, [event.participant.identity]);
      }
      return;
    case 'participant_left':
    case 'participant_connection_aborted':
      if (event.participant) {
        await participantLeft(deps, m, event);
        // Leaving this room ends whatever was shared in it.
        const id = MEET_IDENTITY.parse(event.participant.identity);
        if (id?.kind === 'user') screenSharePresence(deps, id.id, null, false);
        await meetingPresence(deps, m.orgId, [event.participant.identity]);
      }
      return;
    case 'track_published':
    case 'track_unpublished': {
      const id = event.participant ? MEET_IDENTITY.parse(event.participant.identity) : null;
      if (id?.kind === 'user' && event.track?.source === 'screen_share') {
        screenSharePresence(deps, id.id, event.track.sid, event.event === 'track_published');
      }
      return;
    }
    case 'room_finished': {
      const session = await liveSession(deps.db, m.id);
      if (
        session &&
        (!session.roomSid || !event.room!.sid || session.roomSid === event.room!.sid)
      ) {
        const inside = await deps.db
          .select({ identity: meetingParticipants.identity })
          .from(meetingParticipants)
          .where(
            and(eq(meetingParticipants.sessionId, session.id), isNull(meetingParticipants.leftAt)),
          );
        await endSession(deps, m, session, event.createdAt);
        await meetingPresence(
          deps,
          m.orgId,
          inside.map((p) => p.identity),
        );
      }
      return;
    }
  }
}

/** Presence "Toplantıda" follows the people who joined or left (best effort). */
async function meetingPresence(deps: Deps, orgId: string, identities: string[]) {
  for (const identity of identities) {
    const id = MEET_IDENTITY.parse(identity);
    if (id?.kind !== 'user') continue;
    await refreshMeetingPresence(deps, orgId, id.id).catch((err: unknown) =>
      deps.logger.warn({ err }, 'meeting presence refresh failed'),
    );
    // Their other devices show "Şu an bu toplantıdasın".
    publishToUsers(deps.bus, [id.id], { type: 'meet.active' });
  }
}

/** "Herkes için bitir" (design 7.17). */
export async function endForAll(deps: Deps, a: MeetActor, meetingId: string) {
  const { meeting } = await requireModerator(deps.db, a, meetingId);
  const gw = requireLiveKit(deps);
  await gw.sendSignal(meeting.roomName, { type: 'ended' }).catch(() => undefined);
  await gw.deleteRoom(meeting.roomName).catch((err: unknown) => {
    deps.logger.warn({ err, room: meeting.roomName }, 'livekit room delete failed');
  });
  const session = await liveSession(deps.db, meeting.id);
  if (session) await endSession(deps, meeting, session);
}
