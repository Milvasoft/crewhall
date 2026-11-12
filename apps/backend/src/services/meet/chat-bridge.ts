import { and, eq, inArray } from 'drizzle-orm';
import { conversationMembers, conversations, type DbOrTx } from '@crewhall/db';
import type { SystemEvent } from '@crewhall/shared';
import type { Deps } from '../../deps';
import { activeOrgUserIds, defaultNotify, memberIds, membershipOf } from '../chat/access';
import { publishConversation } from '../chat/conversations';
import { appendSystem, publishMessage } from '../chat/messages';
import { chatEnabled } from '../chat/module';
import { federateMeetingStatus } from '../federation/meetings';
import { reloadConversation } from '../chat/views';
import { notify, type NotifyDeps } from '../notifications/notify';
import type { MeetActor } from './access';

/**
 * The meet module's use of chat (design 07: every meeting has its own conversation,
 * conversations.type = 'meeting'; doc 17 §10 notifications). Everything here is best
 * effort: a meeting works when chat is switched off for the org or a call fails.
 */

type ChatDeps = Pick<Deps, 'db' | 'bus' | 'jobs' | 'logger'> & Partial<Pick<Deps, 'presence'>>;

/** Membership of an attached conversation; null when it does not exist. */
export async function conversationMember(
  db: DbOrTx,
  conversationId: string,
  userId: string,
): Promise<boolean | null> {
  const [conv] = await db.select().from(conversations).where(eq(conversations.id, conversationId));
  if (!conv) return null;
  return (await membershipOf(db, conv, userId)).isMember;
}

/**
 * The conversation a meeting is started from: title, space, whether the starter belongs to
 * it, and who to invite. Members of a direct or group chat are invited up front; a space
 * chat may be large, so there people join by joining.
 */
export async function conversationInfo(
  db: DbOrTx,
  orgId: string,
  conversationId: string,
  userId: string,
) {
  const [conv] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.orgId, orgId)));
  if (!conv) return null;
  const isMember = (await membershipOf(db, conv, userId)).isMember;
  const inviteIds =
    isMember && (conv.type === 'direct' || conv.type === 'group')
      ? (await memberIds(db, conv)).filter((id) => id !== userId)
      : [];
  return { title: conv.name ?? '', spaceId: conv.spaceId, type: conv.type, isMember, inviteIds };
}

/**
 * Creates the meeting conversation with these members (host first); returns its id, or
 * null when chat is off. Members are explicit rows even for space meetings: invitees and
 * whoever joins (design 13.12).
 */
export async function ensureMeetingConversation(
  deps: ChatDeps,
  a: MeetActor,
  input: { meetingId: string; title: string; spaceId: string | null; memberIds: string[] },
): Promise<string | null> {
  const { db } = deps;
  try {
    if (!(await chatEnabled(db, a.org.id))) return null;
    const [existing] = await db
      .select()
      .from(conversations)
      .where(and(eq(conversations.meetingId, input.meetingId), eq(conversations.type, 'meeting')));
    if (existing) return existing.id;
    const ids = [...(await activeOrgUserIds(db, a.org.id, [...new Set(input.memberIds)]))];
    const created = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(conversations)
        .values({
          orgId: a.org.id,
          type: 'meeting',
          meetingId: input.meetingId,
          spaceId: input.spaceId,
          name: input.title,
          createdBy: a.userId,
        })
        .returning();
      await tx
        .insert(conversationMembers)
        .values(
          ids.map((userId) => ({
            conversationId: row!.id,
            userId,
            orgId: a.org.id,
            notify: defaultNotify('meeting'),
            addedBy: a.userId,
          })),
        )
        .onConflictDoNothing();
      const line = await appendSystem(tx, row!, {
        type: 'created',
        actorId: a.userId,
        name: input.title,
      });
      return { conv: row!, line };
    });
    const conv = await reloadConversation(db, created.conv.id);
    await publishConversation(deps, a, conv);
    await publishMessage(deps, conv, 'message.created', created.line);
    return conv.id;
  } catch (err) {
    deps.logger.warn({ err, meetingId: input.meetingId }, 'meeting conversation not created');
    return null;
  }
}

/** Invitees and people who join become members of the meeting conversation. */
export async function addConversationMembers(
  deps: ChatDeps,
  a: MeetActor,
  conversationId: string,
  userIds: string[],
) {
  if (!userIds.length) return;
  const { db } = deps;
  try {
    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    if (!conv || conv.type !== 'meeting') return;
    const active = [...(await activeOrgUserIds(db, conv.orgId, userIds))];
    const fresh = await db
      .insert(conversationMembers)
      .values(
        active.map((userId) => ({
          conversationId,
          userId,
          orgId: conv.orgId,
          notify: defaultNotify('meeting'),
          addedBy: a.userId,
        })),
      )
      .onConflictDoNothing()
      .returning({ userId: conversationMembers.userId });
    if (fresh.length) {
      await publishConversation(
        deps,
        a,
        await reloadConversation(db, conversationId),
        fresh.map((r) => r.userId),
      );
    }
  } catch (err) {
    deps.logger.warn({ err, conversationId }, 'meeting conversation members not added');
  }
}

const EVENT_LINE = {
  started: 'meeting_started',
  ended: 'meeting_ended',
  recording_started: 'recording_started',
  recording_ready: 'recording_ready',
} as const;

/**
 * Meeting lines in conversations (design 13.12: "toplantıyı başlattı", "Toplantı bitti",
 * "Kayıt hazır"): written into the conversation the meeting was started from and into the
 * meeting's own conversation. Skipped while chat is off for the org.
 */
export async function postMeetingEvent(
  deps: Pick<Deps, 'db' | 'bus' | 'logger'> & Partial<Pick<Deps, 'jobs' | 'env'>>,
  input: {
    orgId: string;
    sessionId?: string | null;
    actorId?: string | null;
    conversationIds: string[];
    meetingId: string;
    event: keyof typeof EVENT_LINE;
    data: Record<string, string | number | null>;
  },
) {
  const ids = [...new Set(input.conversationIds)];
  if (!ids.length) return;
  const { db } = deps;
  try {
    if (!(await chatEnabled(db, input.orgId))) return;
    const { title, nodeId, durationSeconds } = input.data;
    const event: SystemEvent = {
      type: EVENT_LINE[input.event],
      actorId: input.actorId ?? null,
      meetingId: input.meetingId,
      ...(typeof title === 'string' && title ? { name: title } : {}),
      ...(typeof nodeId === 'string' ? { nodeId } : {}),
      ...(typeof durationSeconds === 'number' ? { durationSeconds } : {}),
    };
    await writeLines(deps, input.orgId, ids, event);
    // Shared channels 2: guest organizations of a shared channel see the meeting go on and off.
    if ((input.event === 'started' || input.event === 'ended') && deps.jobs && deps.env) {
      await federateMeetingStatus(
        { db, jobs: deps.jobs, env: deps.env },
        input.orgId,
        ids,
        input.event === 'started'
          ? { title: typeof title === 'string' ? title : '', startedAt: new Date() }
          : null,
      );
    }
  } catch (err) {
    deps.logger.warn(
      { err, meetingId: input.meetingId, event: input.event },
      'meeting line not written',
    );
  }
}

async function writeLines(
  deps: Pick<Deps, 'db' | 'bus'>,
  orgId: string,
  conversationIds: string[],
  event: SystemEvent,
) {
  const rows = await deps.db
    .select()
    .from(conversations)
    .where(and(inArray(conversations.id, conversationIds), eq(conversations.orgId, orgId)));
  for (const conv of rows) {
    if (conv.archivedAt) continue;
    const line = await appendSystem(deps.db, conv, event);
    await publishMessage(deps, conv, 'message.created', line);
  }
}

/** Call history in the conversation the call came from (H7): missed, or how long and who. */
export async function postCallLine(
  deps: Pick<Deps, 'db' | 'bus' | 'logger'>,
  input: {
    orgId: string;
    conversationId: string;
    meetingId: string;
    callerId: string | null;
    video: boolean;
    outcome: 'missed' | 'ended';
    /** Missed calls: declined, busy, cancelled or not answered. */
    callOutcome?: SystemEvent['callOutcome'];
    durationSeconds?: number;
    userIds?: string[];
  },
) {
  try {
    if (!(await chatEnabled(deps.db, input.orgId))) return;
    await writeLines(deps, input.orgId, [input.conversationId], {
      type: input.outcome === 'missed' ? 'call_missed' : 'call_ended',
      actorId: input.callerId,
      meetingId: input.meetingId,
      video: input.video,
      ...(input.callOutcome ? { callOutcome: input.callOutcome } : {}),
      ...(input.durationSeconds !== undefined ? { durationSeconds: input.durationSeconds } : {}),
      ...(input.userIds ? { userIds: input.userIds } : {}),
    });
  } catch (err) {
    deps.logger.warn({ err, meetingId: input.meetingId }, 'call line not written');
  }
}

/**
 * Notifications (category "meetings"): invitation, recording ready, missed call; `meet.call`
 * rings the phone and leaves no bell row (`pushOnly`).
 */
export async function notifyMeet(
  deps: NotifyDeps,
  input: {
    orgId: string;
    userIds: string[];
    type:
      | 'meet.invited'
      | 'meet.recording_ready'
      | 'meet.call'
      | 'meet.call_missed'
      | 'meet.updated'
      | 'meet.cancelled'
      | 'meet.ring_declined'
      | 'meet.ring_unanswered';
    pushOnly?: boolean;
    /** Rings every device (incoming calls). */
    everyDevice?: boolean;
    actorId: string | null;
    meetingId: string;
    spaceId?: string | null;
    conversationId?: string | null;
    url: string;
    data: Record<string, string | number | boolean | null>;
  },
) {
  if (!input.userIds.length) return;
  try {
    await notify(
      deps,
      input.userIds.map((userId) => ({
        orgId: input.orgId,
        userId,
        type: input.type,
        category: 'meetings' as const,
        actorId: input.actorId,
        target: {
          type: 'meeting' as const,
          id: input.meetingId,
          conversationId: input.conversationId ?? null,
          spaceId: input.spaceId ?? null,
        },
        data: input.data,
        url: input.url,
        pushOnly: input.pushOnly,
        everyDevice: input.everyDevice,
      })),
    );
  } catch (err) {
    deps.logger.warn({ err, meetingId: input.meetingId }, 'meeting notification failed');
  }
}
