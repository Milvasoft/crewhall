import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, desc, eq, gt, inArray, isNull, lt, sql } from 'drizzle-orm';
import {
  meetingLobby,
  meetingParticipants,
  meetings,
  meetingSessions,
  recordings,
  type DbOrTx,
} from '@crewhall/db';
import {
  MEET_IDENTITY,
  MEET_LIMITS,
  MeetParticipantMeta,
  type LobbyRequest,
  type MeetingConnection,
  type MeetingGrants,
  type MeetingJoinResult,
  type MeetingRole,
  type MeetRoomMeta,
  type ModerateAction,
} from '@crewhall/shared';
import type { Deps } from '../../deps';
import { AppError } from '../../http/errors';
import type { RequestInfo } from '../../http/types';
import { audit } from '../audit';
import {
  accessFor,
  ensureSession,
  liveSession,
  loadMeeting,
  loadMeetingRow,
  requireModerator,
  spaceMeetSettings,
  toMeeting,
  usersByIds,
  type MeetActor,
  type MeetingRow,
} from './access';
import { addConversationMembers } from './chat-bridge';
import { liveKit, type LiveKitGateway } from './livekit';
import { guestLinkExpiry, meetingBySlug } from './meetings';
import { meetEnabled } from './module';
import { remoteControlOn } from './remote-control';

type LobbyRow = typeof meetingLobby.$inferSelect;

export function requireLiveKit(deps: Pick<Deps, 'env' | 'db'>): LiveKitGateway {
  const gw = liveKit(deps);
  if (!gw) throw new AppError('meet_unavailable', { reason: 'not_configured' });
  return gw;
}

/** Design 07: moderators control the room, listeners only listen, guests no screen share. */
export function grantsFor(role: MeetingRole, extra: { screenShare?: boolean } = {}): MeetingGrants {
  switch (role) {
    case 'moderator':
      return {
        publish: true,
        screenShare: true,
        publishData: true,
        subscribe: true,
        roomAdmin: true,
      };
    case 'member':
      return {
        publish: true,
        screenShare: true,
        publishData: true,
        subscribe: true,
        roomAdmin: false,
      };
    case 'listener':
      return {
        publish: false,
        screenShare: false,
        publishData: true,
        subscribe: true,
        roomAdmin: false,
      };
    case 'guest':
      return {
        publish: true,
        screenShare: extra.screenShare ?? false,
        publishData: true,
        subscribe: true,
        roomAdmin: false,
      };
  }
}

export async function roomMeta(db: DbOrTx, m: MeetingRow): Promise<MeetRoomMeta> {
  const [rec] = await db
    .select()
    .from(recordings)
    .where(
      and(
        eq(recordings.meetingId, m.id),
        inArray(recordings.status, ['starting', 'recording']),
        // Stopped by a moderator: egress is only finishing the file.
        isNull(recordings.endedAt),
      ),
    )
    .orderBy(desc(recordings.startedAt))
    .limit(1);
  const by = rec?.startedBy ? (await usersByIds(db, [rec.startedBy])).get(rec.startedBy) : null;
  return {
    meetingId: m.id,
    remoteControl: await remoteControlOn(db, m),
    recording: rec
      ? {
          id: rec.id,
          startedAt: rec.startedAt.toISOString(),
          by: by?.name ?? null,
          audioOnly: rec.audioOnly,
        }
      : null,
  };
}

async function connection(
  deps: Deps,
  gw: LiveKitGateway,
  m: MeetingRow,
  who: {
    identity: string;
    name: string;
    role: MeetingRole;
    userId: string | null;
    imageUrl: string | null;
  },
  grants: MeetingGrants,
): Promise<MeetingConnection> {
  try {
    await gw.ensureRoom(m.roomName, JSON.stringify(await roomMeta(deps.db, m)));
  } catch (err) {
    deps.logger.warn({ err, room: m.roomName }, 'livekit room create failed');
    throw new AppError('meet_unavailable', { reason: 'livekit_unreachable' });
  }
  const meta: MeetParticipantMeta = {
    userId: who.userId,
    role: who.role,
    guest: who.role === 'guest',
    imageUrl: who.imageUrl,
  };
  const token = await gw.createToken({
    roomName: m.roomName,
    identity: who.identity,
    name: who.name,
    metadata: meta,
    grants,
  });
  const session = await liveSession(deps.db, m.id);
  return {
    url: gw.publicUrl,
    token,
    roomName: m.roomName,
    identity: who.identity,
    role: who.role,
    grants,
    sessionId: session?.id ?? null,
    expiresAt: new Date(Date.now() + MEET_LIMITS.tokenSeconds * 1000).toISOString(),
  };
}

async function lobbyOut(db: DbOrTx, rows: LobbyRow[]): Promise<LobbyRequest[]> {
  const people = await usersByIds(db, [
    ...rows.map((r) => r.userId),
    ...rows.map((r) => r.decidedBy),
  ]);
  return rows.map((r) => ({
    id: r.id,
    meetingId: r.meetingId,
    name: r.userId ? (people.get(r.userId)?.name ?? r.name) : r.name,
    user: r.userId ? (people.get(r.userId) ?? null) : null,
    guest: !r.userId,
    status: r.status,
    requestedAt: r.requestedAt.toISOString(),
    decidedAt: r.decidedAt?.toISOString() ?? null,
    decidedBy: r.decidedBy ? (people.get(r.decidedBy) ?? null) : null,
    retryAt:
      r.status === 'denied' && r.decidedAt
        ? new Date(r.decidedAt.getTime() + MEET_LIMITS.guestRetrySeconds * 1000).toISOString()
        : null,
  }));
}

/** Unanswered knocks drop after 10 minutes (design 7.14). */
async function expireLobby(db: DbOrTx, meetingId: string) {
  await db
    .update(meetingLobby)
    .set({ status: 'expired' })
    .where(
      and(
        eq(meetingLobby.meetingId, meetingId),
        eq(meetingLobby.status, 'waiting'),
        lt(meetingLobby.requestedAt, new Date(Date.now() - MEET_LIMITS.lobbyWaitSeconds * 1000)),
      ),
    );
}

async function waitingCount(db: DbOrTx, meetingId: string) {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(meetingLobby)
    .where(and(eq(meetingLobby.meetingId, meetingId), eq(meetingLobby.status, 'waiting')));
  return row?.n ?? 0;
}

/** Moderators refetch the lobby when this arrives (design 7.15); best effort. */
async function nudgeLobby(deps: Deps, m: MeetingRow) {
  const gw = liveKit(deps);
  if (!gw) return;
  const waiting = await waitingCount(deps.db, m.id);
  await gw
    .sendSignal(m.roomName, { type: 'lobby', waiting })
    .catch((err: unknown) => deps.logger.debug({ err }, 'lobby signal not delivered'));
}

// ---- Members ----------------------------------------------------------------------------

export async function joinMeeting(
  deps: Deps,
  a: MeetActor,
  meetingId: string,
  userImage: string | null,
  device?: 'transfer' | 'add',
): Promise<MeetingJoinResult> {
  const { db } = deps;
  const gw = requireLiveKit(deps);
  const meeting = await loadMeetingRow(db, a.org.id, meetingId);
  if (meeting.cancelledAt) throw new AppError('meet_ended');
  const access = await accessFor(db, a, meeting);
  const identity = MEET_IDENTITY.user(a.userId);
  const session = await liveSession(db, meeting.id);
  const removed = session?.removedIdentities.includes(identity) ?? false;

  if (!access.direct || removed) {
    await expireLobby(db, meeting.id);
    let [row] = await db
      .select()
      .from(meetingLobby)
      .where(
        and(
          eq(meetingLobby.meetingId, meeting.id),
          eq(meetingLobby.userId, a.userId),
          inArray(meetingLobby.status, ['waiting', 'admitted', 'denied']),
        ),
      )
      .orderBy(desc(meetingLobby.requestedAt))
      .limit(1);
    // An admission is for one visit: removed again means knocking again.
    const stale = row && (row.status === 'denied' || (row.status === 'admitted' && removed));
    if (row?.status === 'denied' && row.decidedAt) {
      const retry = row.decidedAt.getTime() + MEET_LIMITS.guestRetrySeconds * 1000;
      if (retry > Date.now())
        throw new AppError('meet_lobby_retry_later', { retryAt: new Date(retry).toISOString() });
    }
    if (row?.status === 'admitted' && !stale) {
      return admittedJoin(deps, gw, a, meeting, row, userImage, device);
    }
    if (!row || stale) {
      [row] = await db
        .insert(meetingLobby)
        .values({ orgId: a.org.id, meetingId: meeting.id, userId: a.userId, name: a.userName })
        .returning();
      await nudgeLobby(deps, meeting);
    }
    const [request] = await lobbyOut(db, [row!]);
    return {
      status: 'lobby',
      meeting: await toMeeting(db, a, meeting, deps.env.HUB_URL),
      request: request!,
    };
  }

  // Whoever joins can follow the meeting chat afterwards (design 13.12).
  if (meeting.chatConversationId) {
    await addConversationMembers(deps, a, meeting.chatConversationId, [a.userId]);
  }
  await moveFromOtherDevices(deps, gw, meeting, a.userId, device);
  return {
    status: 'joined',
    meeting: await toMeeting(db, a, meeting, deps.env.HUB_URL),
    connection: await connection(
      deps,
      gw,
      meeting,
      {
        identity: connectionIdentity(a.userId, device),
        name: a.userName,
        role: access.role,
        userId: a.userId,
        imageUrl: userImage,
      },
      grantsFor(access.role),
    ),
  };
}

/** A person's connection: their one identity, or one of its own for a device they add. */
const connectionIdentity = (userId: string, device?: 'transfer' | 'add') =>
  MEET_IDENTITY.user(userId, device === 'add' ? randomBytes(6).toString('hex') : undefined);

/**
 * "Bu cihaza aktar": the person's other connections are told to leave, each with its own goodbye
 * screen. The one with their plain identity would be dropped by LiveKit anyway when this device
 * connects; one added earlier would stay, so the signal covers them all.
 */
async function moveFromOtherDevices(
  deps: Pick<Deps, 'logger'>,
  gw: LiveKitGateway,
  meeting: MeetingRow,
  userId: string,
  device?: 'transfer' | 'add',
) {
  if (device !== 'transfer') return;
  try {
    const live = await gw.listParticipants(meeting.roomName);
    const mine = live
      .map((p) => p.identity)
      .filter((i) => {
        const who = MEET_IDENTITY.parse(i);
        return who?.kind === 'user' && who.id === userId;
      });
    if (mine.length) await gw.sendSignal(meeting.roomName, { type: 'transferred' }, mine);
  } catch (err) {
    deps.logger.warn({ err, meetingId: meeting.id }, 'other devices not told about the transfer');
  }
}

/** The meetings this person is in now, on any device. */
export async function listActiveMeetings(deps: Pick<Deps, 'db'>, a: MeetActor) {
  const rows = await deps.db
    .select({
      meetingId: meetings.id,
      slug: meetings.joinSlug,
      title: meetings.title,
      devices: sql<number>`count(distinct ${meetingParticipants.identity})::int`,
      since: sql<Date>`min(${meetingParticipants.joinedAt})`,
    })
    .from(meetingParticipants)
    .innerJoin(meetingSessions, eq(meetingSessions.id, meetingParticipants.sessionId))
    .innerJoin(meetings, eq(meetings.id, meetingParticipants.meetingId))
    .where(
      and(
        eq(meetingParticipants.orgId, a.org.id),
        eq(meetingParticipants.userId, a.userId),
        isNull(meetingParticipants.leftAt),
        isNull(meetingSessions.endedAt),
        isNull(meetings.cancelledAt),
      ),
    )
    .groupBy(meetings.id);
  return {
    items: rows.map((r) => ({ ...r, since: new Date(r.since).toISOString() })),
  };
}

async function admittedJoin(
  deps: Deps,
  gw: LiveKitGateway,
  a: MeetActor,
  meeting: MeetingRow,
  _row: LobbyRow,
  userImage: string | null,
  device?: 'transfer' | 'add',
): Promise<MeetingJoinResult> {
  const access = await accessFor(deps.db, a, meeting);
  const role: MeetingRole = access.role;
  // Someone let in from the lobby follows the meeting chat afterwards too (design 13.12).
  if (meeting.chatConversationId) {
    await addConversationMembers(deps, a, meeting.chatConversationId, [a.userId]);
  }
  await moveFromOtherDevices(deps, gw, meeting, a.userId, device);
  return {
    status: 'joined',
    meeting: await toMeeting(deps.db, a, meeting, deps.env.HUB_URL),
    connection: await connection(
      deps,
      gw,
      meeting,
      {
        identity: connectionIdentity(a.userId, device),
        name: a.userName,
        role,
        userId: a.userId,
        imageUrl: userImage,
      },
      grantsFor(role),
    ),
  };
}

/** A member's own knock: waiting, or admitted → connection. */
export async function getLobbyRequest(
  deps: Deps,
  a: MeetActor,
  requestId: string,
  userImage: string | null,
): Promise<MeetingJoinResult> {
  const { db } = deps;
  const [row] = await db
    .select()
    .from(meetingLobby)
    .where(and(eq(meetingLobby.id, requestId), eq(meetingLobby.userId, a.userId)));
  if (!row) throw new AppError('not_found');
  const meeting = await loadMeetingRow(db, a.org.id, row.meetingId);
  await expireLobby(db, meeting.id);
  const [fresh] = await db.select().from(meetingLobby).where(eq(meetingLobby.id, row.id));
  if (fresh!.status === 'admitted') {
    return admittedJoin(deps, requireLiveKit(deps), a, meeting, fresh!, userImage);
  }
  const [request] = await lobbyOut(db, [fresh!]);
  return {
    status: 'lobby',
    meeting: await toMeeting(db, a, meeting, deps.env.HUB_URL),
    request: request!,
  };
}

// ---- Guests -----------------------------------------------------------------------------

const hashSecret = (s: string) => createHash('sha256').update(s).digest('hex');

/** IP → recent knocks, against link guessing and spam (design 19 "Paylaşım linki güvenliği"). */
const knocks = new Map<string, number[]>();
function knockAllowed(key: string, perTenMinutes = 10) {
  const now = Date.now();
  const recent = (knocks.get(key) ?? []).filter((t) => now - t < 600_000);
  if (recent.length >= perTenMinutes) {
    knocks.set(key, recent);
    return false;
  }
  recent.push(now);
  knocks.set(key, recent);
  if (knocks.size > 5000) knocks.clear();
  return true;
}

async function guestAllowed(db: DbOrTx, m: MeetingRow) {
  if (m.cancelledAt) throw new AppError('meet_ended');
  const expiry = guestLinkExpiry(m);
  if (expiry && expiry < new Date()) throw new AppError('meet_link_expired');
  const spaceOk = m.spaceId
    ? (await spaceMeetSettings(db, [m.spaceId])).get(m.spaceId)!.guestsAllowed
    : true;
  if (!m.settings.guestsAllowed || !spaceOk) throw new AppError('meet_guests_disabled');
}

function guestConnection(
  deps: Deps,
  gw: LiveKitGateway,
  m: MeetingRow,
  row: LobbyRow,
  screenShare = false,
) {
  return connection(
    deps,
    gw,
    m,
    {
      identity: MEET_IDENTITY.guest(row.id),
      name: row.name,
      role: 'guest',
      userId: null,
      imageUrl: null,
    },
    grantsFor('guest', { screenShare }),
  );
}

export async function requestGuestJoin(deps: Deps, slug: string, name: string, req: RequestInfo) {
  const { db } = deps;
  const m = await meetingBySlug(db, slug);
  if (!m) throw new AppError('not_found');
  if (!(await meetEnabled(db, m.orgId)))
    throw new AppError('meet_unavailable', { reason: 'module_disabled' });
  await guestAllowed(db, m);
  const gw = requireLiveKit(deps);
  const ip = req.ip ?? 'unknown';
  const [denied] = await db
    .select()
    .from(meetingLobby)
    .where(
      and(
        eq(meetingLobby.meetingId, m.id),
        eq(meetingLobby.ip, ip),
        eq(meetingLobby.status, 'denied'),
        gt(meetingLobby.decidedAt, new Date(Date.now() - MEET_LIMITS.guestRetrySeconds * 1000)),
      ),
    )
    .limit(1);
  if (denied?.decidedAt) {
    const retryAt = new Date(denied.decidedAt.getTime() + MEET_LIMITS.guestRetrySeconds * 1000);
    throw new AppError('meet_lobby_retry_later', { retryAt: retryAt.toISOString() });
  }
  if (!knockAllowed(`${m.id}:${ip}`)) throw new AppError('rate_limited');

  const secret = randomBytes(24).toString('base64url');
  const direct = !m.settings.lobby;
  const [row] = await db
    .insert(meetingLobby)
    .values({
      orgId: m.orgId,
      meetingId: m.id,
      userId: null,
      name: name.trim(),
      secretHash: hashSecret(secret),
      status: direct ? 'admitted' : 'waiting',
      decidedAt: direct ? new Date() : null,
      ip,
    })
    .returning();
  if (!direct) await nudgeLobby(deps, m);
  const [request] = await lobbyOut(db, [row!]);
  return {
    request: request!,
    secret,
    connection: direct ? await guestConnection(deps, gw, m, row!) : null,
  };
}

export async function guestRow(db: DbOrTx, requestId: string, secret: string) {
  const [row] = await db
    .select()
    .from(meetingLobby)
    .where(and(eq(meetingLobby.id, requestId), isNull(meetingLobby.userId)));
  if (!row?.secretHash) throw new AppError('not_found');
  const a = Buffer.from(row.secretHash, 'hex');
  const b = Buffer.from(hashSecret(secret), 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new AppError('not_found');
  return row;
}

export async function pollGuestRequest(deps: Deps, requestId: string, secret: string) {
  const { db } = deps;
  const row = await guestRow(db, requestId, secret);
  await expireLobby(db, row.meetingId);
  const [fresh] = await db.select().from(meetingLobby).where(eq(meetingLobby.id, row.id));
  const [m] = await db.select().from(meetings).where(eq(meetings.id, row.meetingId));
  if (!m) throw new AppError('not_found');
  if (!(await meetEnabled(db, m.orgId)))
    throw new AppError('meet_unavailable', { reason: 'module_disabled' });
  const [request] = await lobbyOut(db, [fresh!]);
  let conn: MeetingConnection | null = null;
  if (fresh!.status === 'admitted' && !m.cancelledAt) {
    const session = await liveSession(db, m.id);
    const allowed = (m.settings.screenShareGuests ?? []).includes(fresh!.id);
    if (!session?.removedIdentities.includes(MEET_IDENTITY.guest(fresh!.id))) {
      conn = await guestConnection(deps, requireLiveKit(deps), m, fresh!, allowed);
    }
  }
  return { request: request!, connection: conn, meetingTitle: m.title };
}

export async function cancelGuestRequest(deps: Deps, requestId: string, secret: string) {
  const row = await guestRow(deps.db, requestId, secret);
  if (row.status === 'waiting') {
    await deps.db
      .update(meetingLobby)
      .set({ status: 'cancelled' })
      .where(eq(meetingLobby.id, row.id));
  }
}

// ---- Moderators -------------------------------------------------------------------------

export async function listLobby(deps: Deps, a: MeetActor, meetingId: string) {
  const { meeting } = await requireModerator(deps.db, a, meetingId);
  await expireLobby(deps.db, meeting.id);
  const rows = await deps.db
    .select()
    .from(meetingLobby)
    .where(and(eq(meetingLobby.meetingId, meeting.id), eq(meetingLobby.status, 'waiting')))
    .orderBy(meetingLobby.requestedAt);
  return lobbyOut(deps.db, rows);
}

export async function decideLobby(
  deps: Deps,
  a: MeetActor,
  meetingId: string,
  input: { requestIds: string[]; admit: boolean },
) {
  const { db } = deps;
  const { meeting } = await requireModerator(db, a, meetingId);
  await expireLobby(db, meeting.id);
  const rows = await db
    .update(meetingLobby)
    .set({
      status: input.admit ? 'admitted' : 'denied',
      decidedAt: new Date(),
      decidedBy: a.userId,
    })
    .where(
      and(
        eq(meetingLobby.meetingId, meeting.id),
        eq(meetingLobby.status, 'waiting'),
        inArray(meetingLobby.id, input.requestIds),
      ),
    )
    .returning();
  if (input.admit) {
    const session = await liveSession(db, meeting.id);
    if (session) {
      const back = new Set(
        rows.map((r) => (r.userId ? MEET_IDENTITY.user(r.userId) : MEET_IDENTITY.guest(r.id))),
      );
      await db
        .update(meetingSessions)
        .set({ removedIdentities: session.removedIdentities.filter((i) => !back.has(i)) })
        .where(eq(meetingSessions.id, session.id));
    }
  }
  await nudgeLobby(deps, meeting);
  return lobbyOut(db, rows);
}

/** Who is in right now (webhooks) and, for moderators, who waits. */
export async function liveParticipants(deps: Deps, a: MeetActor, meetingId: string) {
  const { db } = deps;
  const { meeting, access } = await loadMeeting(db, a, meetingId);
  if (!access.direct) throw new AppError('not_found');
  const session = await liveSession(db, meeting.id);
  const rows = session
    ? await db
        .select()
        .from(meetingParticipants)
        .where(
          and(eq(meetingParticipants.sessionId, session.id), isNull(meetingParticipants.leftAt)),
        )
        .orderBy(meetingParticipants.joinedAt)
    : [];
  const people = await usersByIds(
    db,
    rows.map((r) => r.userId),
  );
  const now = Date.now();
  const byIdentity = new Map(rows.map((r) => [r.identity, r]));
  const items = [...byIdentity.values()].map((r) => {
    const user = r.userId ? (people.get(r.userId) ?? null) : null;
    return {
      identity: r.identity,
      name: user?.name ?? r.guestName ?? '',
      user,
      guest: !r.userId,
      role: r.role,
      joinedAt: r.joinedAt.toISOString(),
      leftAt: null,
      seconds: Math.round((now - r.joinedAt.getTime()) / 1000),
    };
  });
  return { items, lobby: access.moderator ? await listLobby(deps, a, meetingId) : [] };
}

function parseMeta(raw: string): MeetParticipantMeta | null {
  try {
    const parsed = MeetParticipantMeta.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function moderate(
  deps: Deps,
  a: MeetActor,
  meetingId: string,
  input: { identity: string; action: ModerateAction },
  req: RequestInfo,
) {
  const { db } = deps;
  const { meeting } = await requireModerator(db, a, meetingId);
  const gw = requireLiveKit(deps);
  const target = MEET_IDENTITY.parse(input.identity);
  if (!target) throw new AppError('bad_request', { reason: 'identity' });
  const room = meeting.roomName;
  const live = await gw.listParticipants(room).catch(() => {
    throw new AppError('meet_unavailable', { reason: 'livekit_unreachable' });
  });
  const p = live.find((x) => x.identity === input.identity);
  if (!p) throw new AppError('not_found');
  const meta = parseMeta(p.metadata);
  const muteSources = async (sources: string[]) => {
    for (const t of p.tracks) {
      if (sources.includes(t.source) && !t.muted) await gw.muteTrack(room, p.identity, t.sid);
    }
  };

  switch (input.action) {
    case 'mute':
      await muteSources(['microphone']);
      break;
    case 'stop_camera':
      await muteSources(['camera']);
      break;
    case 'stop_screen_share':
      await muteSources(['screen_share', 'screen_share_audio']);
      break;
    case 'lower_hand':
      await gw.updateParticipant(room, p.identity, { attributes: { hand: '' } });
      break;
    case 'remove': {
      // Webhooks may lag: open the session here so the removal is remembered.
      const { session } = await ensureSession(db, meeting, null, new Date());
      // A person, not one of their devices: joinMeeting looks for their plain identity.
      const removedAs = target.kind === 'user' ? MEET_IDENTITY.user(target.id) : p.identity;
      if (!session.removedIdentities.includes(removedAs)) {
        await db
          .update(meetingSessions)
          .set({ removedIdentities: [...session.removedIdentities, removedAs] })
          .where(eq(meetingSessions.id, session.id));
      }
      if (target.kind === 'guest') {
        await db
          .update(meetingLobby)
          .set({ status: 'denied', decidedAt: new Date(), decidedBy: a.userId })
          .where(eq(meetingLobby.id, target.id));
      } else {
        // Their admission was for this visit only.
        await db
          .update(meetingLobby)
          .set({ status: 'cancelled' })
          .where(
            and(
              eq(meetingLobby.meetingId, meeting.id),
              eq(meetingLobby.userId, target.id),
              eq(meetingLobby.status, 'admitted'),
            ),
          );
      }
      for (const other of live) {
        const who = MEET_IDENTITY.parse(other.identity);
        if (who?.kind === target.kind && who.id === target.id) {
          await gw.removeParticipant(room, other.identity);
        }
      }
      await audit(
        db,
        {
          orgId: a.org.id,
          actorId: a.userId,
          action: 'meet.participant.remove',
          targetType: 'meeting',
          targetId: meeting.id,
          meta: { identity: p.identity },
        },
        req,
      );
      return;
    }
    case 'make_moderator': {
      if (target.kind !== 'user') throw new AppError('bad_request', { reason: 'guest' });
      const ids = new Set(meeting.settings.moderatorIds ?? []);
      ids.add(target.id);
      await db
        .update(meetings)
        .set({ settings: { ...meeting.settings, moderatorIds: [...ids] } })
        .where(eq(meetings.id, meeting.id));
      await gw.updateParticipant(room, p.identity, {
        metadata: JSON.stringify({
          ...(meta ?? { userId: target.id, guest: false, imageUrl: null }),
          role: 'moderator',
        }),
        grants: grantsFor('moderator'),
      });
      break;
    }
    case 'allow_screen_share': {
      const role = meta?.role ?? 'member';
      if (role === 'guest') {
        const allowed = new Set(meeting.settings.screenShareGuests ?? []);
        allowed.add(target.id);
        await db
          .update(meetings)
          .set({ settings: { ...meeting.settings, screenShareGuests: [...allowed] } })
          .where(eq(meetings.id, meeting.id));
      }
      await gw.updateParticipant(room, p.identity, {
        grants: {
          ...grantsFor(role === 'listener' ? 'member' : role, { screenShare: true }),
          screenShare: true,
        },
      });
      break;
    }
    case 'allow_publish': {
      const role = meta?.role === 'listener' ? 'member' : (meta?.role ?? 'member');
      await gw.updateParticipant(room, p.identity, {
        metadata: JSON.stringify({
          ...(meta ?? { userId: null, guest: false, imageUrl: null }),
          role,
        }),
        grants: grantsFor(role),
      });
      break;
    }
  }
  await gw
    .sendSignal(room, { type: 'moderated', action: input.action }, [p.identity])
    .catch(() => undefined);
}

export async function muteAll(
  deps: Deps,
  a: MeetActor,
  meetingId: string,
  exceptModerators: boolean,
) {
  const { meeting } = await requireModerator(deps.db, a, meetingId);
  const gw = requireLiveKit(deps);
  const live = await gw.listParticipants(meeting.roomName).catch(() => {
    throw new AppError('meet_unavailable', { reason: 'livekit_unreachable' });
  });
  for (const p of live) {
    if (p.identity === MEET_IDENTITY.user(a.userId)) continue;
    if (exceptModerators && parseMeta(p.metadata)?.role === 'moderator') continue;
    for (const t of p.tracks) {
      if (t.source === 'microphone' && !t.muted)
        await gw.muteTrack(meeting.roomName, p.identity, t.sid);
    }
  }
}

// ---- Federation ---------------------------------------------------------------------------

/**
 * Shared channels 2 (kararlar.md): a person of a peer organization joins the channel meeting
 * as an admitted guest; their installation vouched for them, so there is no lobby. Removal,
 * guest grants and the meeting's history work as for any guest.
 */
export async function federatedGuestJoin(deps: Deps, m: MeetingRow, name: string) {
  if (m.cancelledAt) throw new AppError('meet_ended');
  if (!(await meetEnabled(deps.db, m.orgId))) {
    throw new AppError('meet_unavailable', { reason: 'module_disabled' });
  }
  const gw = requireLiveKit(deps);
  const [row] = await deps.db
    .insert(meetingLobby)
    .values({
      orgId: m.orgId,
      meetingId: m.id,
      userId: null,
      name: name.slice(0, 200),
      secretHash: hashSecret(randomBytes(24).toString('base64url')),
      status: 'admitted',
      decidedAt: new Date(),
    })
    .returning();
  return guestConnection(deps, gw, m, row!);
}
