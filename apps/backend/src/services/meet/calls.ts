import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  conversations,
  meetingCalls,
  meetingInvitees,
  meetingParticipants,
  meetings,
  meetingSessions,
  type CallMemberData,
  type DbOrTx,
} from '@crewhall/db';
import {
  CALL_RING_SECONDS,
  MEET_IDENTITY,
  type Call,
  type CallEndReason,
  type ConversationLive,
  type StartCall,
  type SystemEvent,
  type UserSummary,
  paths,
  withQuery,
} from '@crewhall/shared';
import type { Deps } from '../../deps';
import { AppError } from '../../http/errors';
import { publishToUsers } from '../../realtime';
import { activeOrgUserIds } from '../chat/access';
import { liveSession, loadMeeting, usersByIds, type MeetActor } from './access';
import {
  addConversationMembers,
  conversationInfo,
  conversationMember,
  ensureMeetingConversation,
  notifyMeet,
  postCallLine,
} from './chat-bridge';
import { requireLiveKit } from './join';
import { liveKit } from './livekit';
import { createMeeting } from './meetings';
import { meetEnabled } from './module';

/**
 * Calls from a direct or group chat (H7, Teams-like): the other members ring (WS call.ringing,
 * push meet.call), answer or decline (or say busy); nobody answering within CALL_RING_SECONDS
 * makes a missed call (chat line, notification). The call happens in the conversation's
 * meeting room; a third person rung during the call turns it into a meeting (`upgraded`).
 */

export type CallRow = typeof meetingCalls.$inferSelect;
type CallDeps = Pick<Deps, 'db' | 'bus' | 'jobs' | 'logger'> &
  Partial<Pick<Deps, 'presence' | 'env'>>;

const LIVE = ['ringing', 'active'] as const;

const audience = (row: CallRow) =>
  [row.callerId, ...row.members.map((m) => m.userId)].filter((x): x is string => Boolean(x));

const ringingIds = (row: CallRow) =>
  row.members.filter((m) => m.state === 'ringing').map((m) => m.userId);

async function toCall(db: DbOrTx, row: CallRow): Promise<Call> {
  const people = await usersByIds(db, [
    row.callerId,
    ...row.members.flatMap((m) => [m.userId, ...(m.by ? [m.by] : [])]),
  ]);
  const [m] = await db
    .select({ slug: meetings.joinSlug })
    .from(meetings)
    .where(eq(meetings.id, row.meetingId));
  const [conv] = await db
    .select({ type: conversations.type, name: conversations.name })
    .from(conversations)
    .where(eq(conversations.id, row.conversationId));
  const end = row.endedAt ?? null;
  return {
    id: row.id,
    meetingId: row.meetingId,
    slug: m?.slug ?? '',
    conversationId: row.conversationId,
    conversationTitle: conv && conv.type !== 'direct' ? (conv.name ?? null) : null,
    caller: row.callerId ? (people.get(row.callerId) ?? null) : null,
    video: row.video,
    status: row.status,
    members: row.members.flatMap((x) => {
      const user = people.get(x.userId);
      const by = x.by ? people.get(x.by) : undefined;
      return user ? [{ user, state: x.state, at: x.at, ...(by ? { by } : {}) }] : [];
    }),
    upgraded: row.upgraded,
    ...(conv?.type === 'meeting' ? { invite: true } : {}),
    startedAt: row.startedAt.toISOString(),
    answeredAt: row.answeredAt?.toISOString() ?? null,
    endedAt: end?.toISOString() ?? null,
    durationSeconds:
      row.answeredAt && end
        ? Math.max(0, Math.round((end.getTime() - row.answeredAt.getTime()) / 1000))
        : null,
  };
}

/** Everybody in the call gets call.updated; `ring` get call.ringing instead. */
async function publish(deps: CallDeps, row: CallRow, ring: string[] = []) {
  const call = await toCall(deps.db, row);
  const ringSet = new Set(ring);
  publishToUsers(
    deps.bus,
    audience(row).filter((id) => !ringSet.has(id)),
    { type: 'call.updated', call },
  );
  if (ring.length) publishToUsers(deps.bus, ring, { type: 'call.ringing', call });
  return call;
}

/** Rings phones (push only, no bell row; the web rings over the WebSocket). */
async function pushRing(
  deps: CallDeps,
  row: CallRow,
  call: Call,
  userIds: string[],
  ringer: UserSummary | null = call.caller,
) {
  await notifyMeet(deps, {
    orgId: row.orgId,
    userIds,
    type: 'meet.call',
    pushOnly: true,
    // A call rings the phone even while the chat is open on another device.
    everyDevice: true,
    actorId: ringer?.id ?? row.callerId,
    meetingId: row.meetingId,
    conversationId: row.conversationId,
    url: withQuery(paths.meetingRoom(call.slug), { call: row.id }),
    data: {
      callId: row.id,
      actorName: ringer?.name ?? '',
      actorImageUrl: ringer?.imageUrl ?? null,
      video: row.video,
      conversationTitle: call.conversationTitle,
      // "X seni toplantıya çağırıyor" (push.ts, the apps' call screens).
      invite: call.invite === true,
    },
  });
}

/** A ring into a meeting going on: its conversation is the meeting's own chat. */
async function isInvite(db: DbOrTx, row: Pick<CallRow, 'conversationId'>) {
  const [conv] = await db
    .select({ type: conversations.type })
    .from(conversations)
    .where(eq(conversations.id, row.conversationId));
  return conv?.type === 'meeting';
}

/** Tells the person who rang people into a meeting that some did not come. */
async function notifyRinger(
  deps: CallDeps,
  row: CallRow,
  userIds: string[],
  type: 'meet.ring_declined' | 'meet.ring_unanswered',
) {
  const call = await toCall(deps.db, row);
  const names = new Map(call.members.map((m) => [m.user.id, m.user.name]));
  for (const id of userIds) {
    const ringer = row.members.find((m) => m.userId === id)?.by ?? row.callerId;
    if (!ringer) continue;
    await notifyMeet(deps, {
      orgId: row.orgId,
      userIds: [ringer],
      type,
      actorId: id,
      meetingId: row.meetingId,
      conversationId: row.conversationId,
      url: withQuery(paths.meetingRoom(call.slug), {}),
      data: { actorName: names.get(id) ?? '', title: call.conversationTitle },
    });
  }
}

async function notifyMissed(deps: CallDeps, row: CallRow, userIds: string[]) {
  if (!userIds.length) return;
  const call = await toCall(deps.db, row);
  await notifyMeet(deps, {
    orgId: row.orgId,
    userIds,
    type: 'meet.call_missed',
    actorId: row.callerId,
    meetingId: row.meetingId,
    conversationId: row.conversationId,
    url: paths.chatConversation(row.conversationId),
    data: {
      actorName: call.caller?.name ?? '',
      video: row.video,
      conversationTitle: call.conversationTitle,
    },
  });
}

/** People in another live call or in a meeting right now. */
async function busyUsers(db: DbOrTx, orgId: string, userIds: string[], exceptCall?: string) {
  if (!userIds.length) return new Set<string>();
  const busy = new Set<string>();
  const inRooms = await db
    .select({ userId: meetingParticipants.userId })
    .from(meetingParticipants)
    .innerJoin(meetingSessions, eq(meetingSessions.id, meetingParticipants.sessionId))
    .where(
      and(
        eq(meetingParticipants.orgId, orgId),
        inArray(meetingParticipants.userId, userIds),
        isNull(meetingParticipants.leftAt),
        isNull(meetingSessions.endedAt),
      ),
    );
  for (const r of inRooms) if (r.userId) busy.add(r.userId);
  const calls = await db
    .select()
    .from(meetingCalls)
    .where(and(eq(meetingCalls.orgId, orgId), inArray(meetingCalls.status, [...LIVE])));
  for (const c of calls) {
    if (c.id === exceptCall) continue;
    if (c.callerId && userIds.includes(c.callerId)) busy.add(c.callerId);
    for (const m of c.members) {
      if ((m.state === 'accepted' || m.state === 'ringing') && userIds.includes(m.userId)) {
        busy.add(m.userId);
      }
    }
  }
  return busy;
}

async function liveCallOf(db: DbOrTx, conversationId: string) {
  const [row] = await db
    .select()
    .from(meetingCalls)
    .where(
      and(eq(meetingCalls.conversationId, conversationId), inArray(meetingCalls.status, [...LIVE])),
    );
  return row ?? null;
}

/** The live call of a meeting room, if one is going on there. */
export async function liveCallOfMeeting(db: DbOrTx, meetingId: string) {
  const [row] = await db
    .select()
    .from(meetingCalls)
    .where(and(eq(meetingCalls.meetingId, meetingId), inArray(meetingCalls.status, [...LIVE])));
  return row ?? null;
}

/** Seconds an answered call may stay with an empty room before a new call replaces it. */
const ABANDONED_SECONDS = 30;

async function abandoned(db: DbOrTx, row: CallRow) {
  if (row.status !== 'active') return false;
  const since = (row.answeredAt ?? row.startedAt).getTime();
  if (Date.now() - since < ABANDONED_SECONDS * 1000) return false;
  return !(await liveSession(db, row.meetingId));
}

/** Phones that rang for these people stop ringing (data-only meet.call_end, H7). */
async function stopRinging(deps: CallDeps, row: CallRow, userIds: string[], reason: CallEndReason) {
  if (!userIds.length) return;
  await deps.jobs.send('meet.call_end', { orgId: row.orgId, callId: row.id, userIds, reason });
}

async function scheduleTimeout(deps: CallDeps, callId: string) {
  await deps.jobs.send(
    'meet.call_timeout',
    { callId },
    { startAfterSeconds: CALL_RING_SECONDS, singletonKey: `call:${callId}:${Date.now()}` },
  );
}

export async function startCall(deps: Deps, a: MeetActor, input: StartCall): Promise<Call> {
  const { db } = deps;
  if (a.actor.orgRole === 'guest') throw new AppError('forbidden');
  requireLiveKit(deps);
  const info = await conversationInfo(db, a.org.id, input.conversationId, a.userId);
  if (!info || !info.isMember) throw new AppError('not_found');
  if ((info.type !== 'direct' && info.type !== 'group') || info.inviteIds.length === 0) {
    throw new AppError('meet_call_unavailable');
  }
  // A call already going on in the conversation: join it. One answered but with nobody in its
  // room for a while (nobody could connect) is over: start a new one.
  const live = await liveCallOf(db, input.conversationId);
  if (live && !(await abandoned(db, live))) return toCall(db, live);
  if (live) await endCallsOfMeeting(deps, live.meetingId);

  const meeting = await createMeeting(
    deps,
    a,
    { mode: 'instant', conversationId: input.conversationId },
    { notify: false },
  );
  const now = new Date();
  const busy = await busyUsers(db, a.org.id, info.inviteIds);
  const members: CallMemberData[] = info.inviteIds.map((userId) => ({
    userId,
    state: busy.has(userId) ? 'busy' : 'ringing',
    at: now.toISOString(),
  }));
  const anyRinging = members.some((m) => m.state === 'ringing');
  let row: CallRow;
  try {
    [row] = (await db
      .insert(meetingCalls)
      .values({
        orgId: a.org.id,
        meetingId: meeting.id,
        conversationId: input.conversationId,
        callerId: a.userId,
        video: input.video,
        status: anyRinging ? 'ringing' : 'declined',
        members,
        endedAt: anyRinging ? null : now,
      })
      .returning()) as [CallRow];
  } catch (err) {
    // Two people calling at once: the other call won.
    const other = await liveCallOf(db, input.conversationId);
    if (other) return toCall(db, other);
    throw err;
  }
  const ring = ringingIds(row);
  const call = await publish(deps, row, ring);
  if (ring.length) {
    await pushRing(deps, row, call, ring);
    await scheduleTimeout(deps, row.id);
  } else {
    await postCallLine(deps, {
      orgId: row.orgId,
      conversationId: row.conversationId,
      meetingId: row.meetingId,
      callerId: row.callerId,
      video: row.video,
      outcome: 'missed',
      // Nobody to ring: everyone is in another call.
      callOutcome: 'busy',
    });
  }
  return call;
}

/** Caller, people rung and members of the conversation may see the call. */
async function loadCall(db: DbOrTx, a: MeetActor, callId: string) {
  const [row] = await db
    .select()
    .from(meetingCalls)
    .where(and(eq(meetingCalls.id, callId), eq(meetingCalls.orgId, a.org.id)));
  if (!row) throw new AppError('not_found');
  if (!audience(row).includes(a.userId)) {
    const member = await conversationMember(db, row.conversationId, a.userId);
    if (!member) throw new AppError('not_found');
  }
  return row;
}

async function save(db: DbOrTx, row: CallRow, patch: Partial<CallRow>) {
  const [next] = await db
    .update(meetingCalls)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(meetingCalls.id, row.id))
    .returning();
  return next!;
}

const setState = (
  row: CallRow,
  userIds: Set<string>,
  state: CallMemberData['state'],
  only?: CallMemberData['state'][],
): CallMemberData[] => {
  const at = new Date().toISOString();
  return row.members.map((m) =>
    userIds.has(m.userId) && (!only || only.includes(m.state)) ? { ...m, state, at } : m,
  );
};

export async function getCall(deps: Deps, a: MeetActor, callId: string) {
  return toCall(deps.db, await loadCall(deps.db, a, callId));
}

/** The call ringing or going on in a conversation, and its room while people are in it. */
export async function conversationLive(
  deps: Deps,
  a: MeetActor,
  conversationId: string,
): Promise<ConversationLive> {
  const { db } = deps;
  const member = await conversationMember(db, conversationId, a.userId);
  if (!member) throw new AppError('not_found');
  const row = await liveCallOf(db, conversationId);
  const call = row && row.orgId === a.org.id && !(await abandoned(db, row)) ? row : null;
  const [room] = await db
    .select()
    .from(meetings)
    .where(
      and(
        eq(meetings.orgId, a.org.id),
        eq(meetings.conversationId, conversationId),
        eq(meetings.kind, 'chat'),
        isNull(meetings.cancelledAt),
      ),
    );
  const session = room ? await liveSession(db, room.id) : null;
  let meeting: ConversationLive['meeting'] = null;
  if (room && session) {
    const [inside] = await db
      .select({ n: sql<number>`count(distinct ${meetingParticipants.identity})::int` })
      .from(meetingParticipants)
      .where(
        and(eq(meetingParticipants.sessionId, session.id), isNull(meetingParticipants.leftAt)),
      );
    const participantCount = inside?.n ?? 0;
    if (participantCount > 0) {
      meeting = {
        id: room.id,
        slug: room.joinSlug,
        startedAt: session.startedAt.toISOString(),
        participantCount,
      };
    }
  }
  return { call: call ? await toCall(db, call) : null, meeting };
}

export async function listIncoming(deps: Deps, a: MeetActor): Promise<{ items: Call[] }> {
  const rows = await deps.db
    .select()
    .from(meetingCalls)
    .where(and(eq(meetingCalls.orgId, a.org.id), inArray(meetingCalls.status, [...LIVE])));
  const mine = rows.filter((r) =>
    r.members.some((m) => m.userId === a.userId && m.state === 'ringing'),
  );
  return { items: await Promise.all(mine.map((r) => toCall(deps.db, r))) };
}

export async function answerCall(deps: Deps, a: MeetActor, callId: string): Promise<Call> {
  const { db } = deps;
  let row = await loadCall(db, a, callId);
  if (!(LIVE as readonly string[]).includes(row.status)) throw new AppError('meet_call_over');
  const me = new Set([a.userId]);
  const members = row.members.some((m) => m.userId === a.userId)
    ? setState(row, me, 'accepted')
    : // A member of the conversation joining a call they were not rung for.
      [
        ...row.members,
        { userId: a.userId, state: 'accepted' as const, at: new Date().toISOString() },
      ];
  row = await save(db, row, {
    members,
    status: 'active',
    answeredAt: row.answeredAt ?? new Date(),
  });
  // The person's other devices stop ringing.
  await stopRinging(deps, row, [a.userId], 'answered_elsewhere');
  return publish(deps, row);
}

/** Why a call nobody answered ended, for its chat line ("Reddedilen arama", "Meşgul"). */
function unansweredOutcome(
  row: CallRow,
  status: 'missed' | 'declined' | 'cancelled',
): NonNullable<SystemEvent['callOutcome']> {
  if (status !== 'declined') return status;
  const rung = row.members.filter((m) => m.userId !== row.callerId);
  return rung.length > 0 && rung.every((m) => m.state === 'busy') ? 'busy' : 'declined';
}

/** Ends ringing without an answer: missed for whoever was still ringing. */
async function finishUnanswered(
  deps: CallDeps,
  row: CallRow,
  status: 'missed' | 'declined' | 'cancelled',
) {
  const missed = ringingIds(row);
  const next = await save(deps.db, row, {
    status,
    endedAt: new Date(),
    members: setState(row, new Set(missed), 'missed', ['ringing']),
  });
  await stopRinging(deps, next, missed, status === 'cancelled' ? 'cancelled' : 'missed');
  await publish(deps, next);
  await postCallLine(deps, {
    orgId: next.orgId,
    conversationId: next.conversationId,
    meetingId: next.meetingId,
    callerId: next.callerId,
    video: next.video,
    outcome: 'missed',
    callOutcome: unansweredOutcome(next, status),
  });
  await notifyMissed(deps, next, missed);
  // A one-to-one call nobody answered leaves no room open behind it.
  await closeIfOneToOne(deps, next);
  return next;
}

/** Two people, never turned into a meeting: the call is the room. */
function oneToOne(row: Pick<CallRow, 'upgraded' | 'members'>) {
  return !row.upgraded && row.members.length === 1;
}

async function closeIfOneToOne(deps: CallDeps, row: CallRow) {
  if (!oneToOne(row) || !deps.env) return;
  // webhook.ts imports this module: loaded when needed.
  const { closeCallSession } = await import('./webhook');
  await closeCallSession({ ...deps, env: deps.env }, row.meetingId).catch((err: unknown) =>
    deps.logger.warn({ err, callId: row.id }, 'call room not closed'),
  );
}

/**
 * "Ayrıl" in a call's room. A caller hanging up while it rings cancels it; in a one-to-one call
 * that is going on it ends for both and the room closes at once (without waiting for LiveKit's
 * webhooks). In a group call the person just leaves.
 */
export async function hangUpCall(deps: Deps, a: MeetActor, callId: string): Promise<Call> {
  const { db } = deps;
  const row = await loadCall(db, a, callId);
  if (row.status === 'ringing' && row.callerId === a.userId) {
    return toCall(db, await finishUnanswered(deps, row, 'cancelled'));
  }
  const inCall =
    row.callerId === a.userId ||
    row.members.some((m) => m.userId === a.userId && m.state === 'accepted');
  if (row.status === 'active' && inCall && oneToOne(row)) {
    await endCallsOfMeeting(deps, row.meetingId);
    const { closeCallSession } = await import('./webhook');
    await closeCallSession(deps, row.meetingId);
    const [after] = await db.select().from(meetingCalls).where(eq(meetingCalls.id, row.id));
    return toCall(db, after ?? row);
  }
  return toCall(db, row);
}

export async function declineCall(
  deps: Deps,
  a: MeetActor,
  callId: string,
  busy: boolean,
): Promise<Call> {
  const { db } = deps;
  let row = await loadCall(db, a, callId);
  if (!(LIVE as readonly string[]).includes(row.status)) return toCall(db, row);
  row = await save(db, row, {
    members: setState(row, new Set([a.userId]), busy ? 'busy' : 'declined', ['ringing']),
  });
  await stopRinging(deps, row, [a.userId], 'declined');
  if (await isInvite(db, row)) await notifyRinger(deps, row, [a.userId], 'meet.ring_declined');
  const waiting = row.members.some((m) => m.state === 'ringing' || m.state === 'accepted');
  if (row.status === 'ringing' && !waiting) {
    row = await finishUnanswered(deps, row, 'declined');
    return toCall(db, row);
  }
  return publish(deps, row);
}

export async function cancelCall(deps: Deps, a: MeetActor, callId: string): Promise<Call> {
  const { db } = deps;
  const row = await loadCall(db, a, callId);
  if (row.callerId !== a.userId) throw new AppError('forbidden');
  if (row.status !== 'ringing') return toCall(db, row);
  return toCall(db, await finishUnanswered(deps, row, 'cancelled'));
}

export async function ringCall(
  deps: Deps,
  a: MeetActor,
  callId: string,
  userIds: string[],
): Promise<Call> {
  const row = await loadCall(deps.db, a, callId);
  if (!audience(row).includes(a.userId)) throw new AppError('forbidden');
  return ringMore(deps, a, row, userIds);
}

/**
 * "Toplantıya davet = çaldırma": rings people into the meeting going on in the actor's room. In
 * a call's room it rings into that call; otherwise the meeting gets a ringing record of its own
 * in its chat (no call lines there; the meeting keeps its own).
 */
export async function ringToMeeting(
  deps: Deps,
  a: MeetActor,
  meetingId: string,
  userIds: string[],
): Promise<Call> {
  const { db } = deps;
  const { meeting, access } = await loadMeeting(db, a, meetingId);
  if (!access.direct && !access.moderator) throw new AppError('not_found');
  if (meeting.cancelledAt) throw new AppError('meet_ended');
  const live = await liveCallOfMeeting(db, meeting.id);
  if (live) return ringMore(deps, a, live, userIds);
  // The session row comes with LiveKit's webhook: a room with people in it is live already.
  if (!(await liveSession(db, meeting.id)) && !(await peopleInRoom(deps, meeting.roomName))?.size) {
    throw new AppError('meet_not_live');
  }
  const chatId =
    meeting.chatConversationId ??
    (await ensureMeetingConversation(deps, a, {
      meetingId: meeting.id,
      title: meeting.title,
      spaceId: meeting.spaceId,
      memberIds: [a.userId],
    }));
  if (!chatId) throw new AppError('meet_call_unavailable');
  if (!meeting.chatConversationId) {
    await db
      .update(meetings)
      .set({ chatConversationId: chatId })
      .where(eq(meetings.id, meeting.id));
  }
  const [row] = (await db
    .insert(meetingCalls)
    .values({
      orgId: a.org.id,
      meetingId: meeting.id,
      conversationId: chatId,
      callerId: a.userId,
      video: true,
      status: 'active',
      members: [],
      upgraded: true,
      answeredAt: new Date(),
    })
    .returning()) as [CallRow];
  return ringMore(deps, a, row, userIds);
}

/** The people (user ids) in a LiveKit room right now; null when LiveKit cannot say. */
async function peopleInRoom(deps: Pick<Deps, 'env' | 'db' | 'logger'>, roomName: string) {
  try {
    const live = await requireLiveKit(deps).listParticipants(roomName);
    return new Set(
      live.flatMap((p) => {
        const who = MEET_IDENTITY.parse(p.identity);
        return who?.kind === 'user' ? [who.id] : [];
      }),
    );
  } catch (err) {
    deps.logger.warn({ err, room: roomName }, 'room participants not available');
    return null;
  }
}

/** Long enough to get from "Katıl" into the room: not rung again meanwhile. */
const JOINING_MS = 30_000;

async function ringMore(deps: Deps, a: MeetActor, start: CallRow, userIds: string[]) {
  const { db } = deps;
  let row = start;
  if (!(LIVE as readonly string[]).includes(row.status)) throw new AppError('meet_call_over');
  const [m] = await db.select().from(meetings).where(eq(meetings.id, row.meetingId));
  const inside = m ? await peopleInRoom(deps, m.roomName) : null;
  const active = [...(await activeOrgUserIds(db, row.orgId, userIds))].filter(
    (id) => id !== a.userId && !inside?.has(id),
  );
  // Rings anyone not in the room: not in the call yet, rung earlier, or joined and left since.
  // The one who started the call too, once they left it.
  const toRing = active.filter((id) => {
    const x = row.members.find((y) => y.userId === id);
    if (x?.state !== 'accepted') return inside !== null || id !== row.callerId;
    return inside !== null && Date.now() - Date.parse(x.at) > JOINING_MS;
  });
  if (!toRing.length) return toCall(db, row);
  const busy = await busyUsers(db, row.orgId, toRing, row.id);
  const at = new Date().toISOString();
  const state = (id: string) => (busy.has(id) ? ('busy' as const) : ('ringing' as const));
  const by = a.userId === row.callerId ? {} : { by: a.userId };
  const members = [
    ...row.members.map((x) =>
      toRing.includes(x.userId) ? { ...x, state: state(x.userId), at, ...by } : x,
    ),
    ...toRing
      .filter((id) => !row.members.some((x) => x.userId === id))
      .map((userId) => ({ userId, state: state(userId), at, ...by })),
  ];
  await db
    .insert(meetingInvitees)
    .values(
      toRing.map((userId) => ({
        orgId: row.orgId,
        meetingId: row.meetingId,
        userId,
        invitedBy: a.userId,
      })),
    )
    .onConflictDoNothing();
  if (m?.chatConversationId) await addConversationMembers(deps, a, m.chatConversationId, toRing);
  row = await save(db, row, { members, upgraded: row.upgraded || members.length + 1 > 2 });
  const ring = toRing.filter((id) => !busy.has(id));
  const call = await publish(deps, row, ring);
  if (ring.length) {
    const ringer = call.members.find((x) => x.user.id === ring[0])?.by ?? call.caller;
    await pushRing(deps, row, call, ring, ringer);
    await scheduleTimeout(deps, row.id);
  }
  return call;
}

/** Job: CALL_RING_SECONDS later, whoever is still ringing missed it. */
export async function timeoutCall(deps: CallDeps, callId: string, now = new Date()) {
  const { db } = deps;
  const [row] = await db.select().from(meetingCalls).where(eq(meetingCalls.id, callId));
  if (!row || !(LIVE as readonly string[]).includes(row.status)) return;
  if (!(await meetEnabled(db, row.orgId))) return;
  const due = new Set(
    row.members
      .filter(
        (m) =>
          m.state === 'ringing' &&
          now.getTime() - new Date(m.at).getTime() >= (CALL_RING_SECONDS - 1) * 1000,
      )
      .map((m) => m.userId),
  );
  if (!due.size) return;
  if (row.status === 'ringing' && row.members.every((m) => m.state !== 'accepted')) {
    const stillRinging = row.members.filter((m) => m.state === 'ringing' && !due.has(m.userId));
    if (!stillRinging.length) {
      await finishUnanswered(deps, row, 'missed');
      return;
    }
  }
  const next = await save(db, row, { members: setState(row, due, 'missed', ['ringing']) });
  await stopRinging(deps, next, [...due], 'missed');
  await publish(deps, next);
  if (await isInvite(db, next)) await notifyRinger(deps, next, [...due], 'meet.ring_unanswered');
  else await notifyMissed(deps, next, [...due]);
}

/**
 * The meeting session of a call ended (room finished or ended for all): an answered call
 * becomes history (duration, who took part), an unanswered one a missed call.
 * Returns true when a call was live there (the meeting's own "bitti" line is skipped).
 */
export async function endCallsOfMeeting(deps: CallDeps, meetingId: string, at = new Date()) {
  const row = await liveCallOfMeeting(deps.db, meetingId);
  if (!row) return false;
  if (await isInvite(deps.db, row)) {
    const ringing = ringingIds(row);
    const next = await save(deps.db, row, {
      status: 'ended',
      endedAt: at,
      members: setState(row, new Set(ringing), 'missed', ['ringing']),
    });
    await stopRinging(deps, next, ringing, 'missed');
    await publish(deps, next);
    // Not a call's room: the meeting writes its own "bitti" line.
    return false;
  }
  if (row.status === 'ringing') {
    await finishUnanswered(deps, row, 'cancelled');
    return true;
  }
  const missed = ringingIds(row);
  // LiveKit stamps webhooks in whole seconds: never before the answer.
  if (row.answeredAt && at < row.answeredAt) at = row.answeredAt;
  const talk = await talkTime(deps.db, row, at);
  const next = await save(deps.db, row, {
    status: 'ended',
    endedAt: talk.reached ? talk.end : at,
    members: setState(row, new Set(missed), 'missed', ['ringing']),
  });
  await stopRinging(deps, next, missed, 'missed');
  await publish(deps, next);
  await postCallLine(deps, {
    orgId: next.orgId,
    conversationId: next.conversationId,
    meetingId: next.meetingId,
    callerId: next.callerId,
    video: next.video,
    // Answered somewhere but nobody reached the room: for the chat it was a missed call.
    ...(talk.reached
      ? { outcome: 'ended' as const, durationSeconds: talk.seconds }
      : { outcome: 'missed' as const, callOutcome: 'missed' as const }),
    userIds: [
      ...(next.callerId ? [next.callerId] : []),
      ...next.members.filter((m) => m.state === 'accepted').map((m) => m.userId),
    ],
  });
  await notifyMissed(deps, next, missed);
  return true;
}

/**
 * How long an answered call lasted: from the answer to the last one leaving its room, not to
 * when the room finally closed. A call
 * left "active" with an empty room for hours used to read "Sesli arama · 23:28:02".
 */
export async function talkTime(
  db: DbOrTx,
  row: Pick<CallRow, 'meetingId' | 'callerId' | 'answeredAt'>,
  at: Date,
): Promise<{ seconds: number; reached: boolean; end: Date }> {
  if (!row.answeredAt) return { seconds: 0, reached: false, end: at };
  const answered = row.answeredAt;
  const rows = await db
    .select({
      userId: meetingParticipants.userId,
      joinedAt: meetingParticipants.joinedAt,
      leftAt: meetingParticipants.leftAt,
    })
    .from(meetingParticipants)
    .innerJoin(meetingSessions, eq(meetingSessions.id, meetingParticipants.sessionId))
    .where(eq(meetingSessions.meetingId, row.meetingId));
  // Visits during this call (not earlier meetings in the same room).
  // LiveKit stamps its webhooks in whole seconds: a little slack around the answer.
  const since = answered.getTime() - 5_000;
  const visits = rows.filter((r) => !r.leftAt || r.leftAt.getTime() >= since);
  const others = visits.filter((r) => r.userId && r.userId !== row.callerId);
  if (!others.length) return { seconds: 0, reached: false, end: at };
  const lastLeft = visits.some((r) => !r.leftAt)
    ? at
    : new Date(Math.max(...visits.map((r) => r.leftAt!.getTime())));
  const end = lastLeft < at ? lastLeft : at;
  return {
    seconds: Math.max(0, Math.round((end.getTime() - answered.getTime()) / 1000)),
    reached: true,
    end,
  };
}

/**
 * Someone left the room of an answered call. A one-to-one call ends when either side hangs up,
 * once both sides were in the room together: a reconnect (same person) or leaving before the
 * other side arrived does not end it. A caller hanging up while it rings cancels it through
 * cancelCall; a closed tab lets it ring out (missed). Returns true when the room should close.
 */
export async function callAfterLeave(
  deps: Pick<Deps, 'db'>,
  meetingId: string,
  sessionId: string,
  inRoom: number,
) {
  const row = await liveCallOfMeeting(deps.db, meetingId);
  if (!row || row.status !== 'active') return false;
  if (row.upgraded || 1 + row.members.length > 2 || inRoom > 1) return false;
  const [met] = await deps.db
    .select({ n: sql<number>`count(distinct ${meetingParticipants.identity})::int` })
    .from(meetingParticipants)
    .where(eq(meetingParticipants.sessionId, sessionId));
  return (met?.n ?? 0) >= 2;
}

/** Closes the room of a finished one-to-one call (everybody is sent to the summary). */
export async function closeCallRoom(deps: Pick<Deps, 'env' | 'db' | 'logger'>, roomName: string) {
  const gw = liveKit(deps);
  if (!gw) return;
  await gw.sendSignal(roomName, { type: 'ended' }).catch(() => undefined);
  await gw.deleteRoom(roomName).catch((err: unknown) => {
    deps.logger.warn({ err, room: roomName }, 'livekit room delete failed');
  });
}

/** Push guard: a ring that is no longer ringing for this person is not sent (push.ts). */
export async function stillRinging(db: DbOrTx, callId: string, userId: string) {
  const [row] = await db.select().from(meetingCalls).where(eq(meetingCalls.id, callId));
  return Boolean(
    row &&
    (LIVE as readonly string[]).includes(row.status) &&
    row.members.some((m) => m.userId === userId && m.state === 'ringing'),
  );
}
