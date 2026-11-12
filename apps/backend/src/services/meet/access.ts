import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  calendarEvents,
  meetingInvitees,
  meetingParticipants,
  meetings,
  meetingSessions,
  meetSpaceSettings,
  recordings,
  spaceMembers,
  spaces,
  users,
  type DbOrTx,
  type MeetingSettingsData,
} from '@crewhall/db';
import {
  canMeet,
  MEET_LIMITS,
  type Actor,
  type Meeting,
  type MeetingRole,
  type MeetSpaceSettings,
  type OrgSettings,
  type SpaceRole,
  type UserSummary,
  paths,
} from '@crewhall/shared';
import { AppError } from '../../http/errors';
import type { OrgRow } from '../../http/types';
import { conversationMember } from './chat-bridge';
import { meetingAllowsRemoteControl, orgAllowsRemoteControl } from './remote-control';
import { nextOccurrence } from './schedule';

export type MeetingRow = typeof meetings.$inferSelect;
export type SessionRow = typeof meetingSessions.$inferSelect;
export type RecordingRow = typeof recordings.$inferSelect;

/** Who is asking, in the active org. */
export interface MeetActor {
  org: OrgRow;
  actor: Actor;
  userId: string;
  userName: string;
}

export interface MeetingAccess {
  spaceRole: SpaceRole | null;
  invited: boolean;
  moderator: boolean;
  /** May connect without the lobby. */
  direct: boolean;
  role: MeetingRole;
  editorsCanRecord: boolean;
  guestsAllowedBySpace: boolean;
}

type UserRow = { id: string; name: string; email: string; image: string | null };
export const toSummary = (u: UserRow): UserSummary => ({
  id: u.id,
  name: u.name,
  email: u.email,
  imageUrl: u.image && /^https?:\/\//.test(u.image) ? u.image : null,
});

export async function usersByIds(db: DbOrTx, ids: (string | null | undefined)[]) {
  const unique = [...new Set(ids.filter((x): x is string => Boolean(x)))];
  if (!unique.length) return new Map<string, UserSummary>();
  const rows = await db
    .select({ id: users.id, name: users.name, email: users.email, image: users.image })
    .from(users)
    .where(inArray(users.id, unique));
  return new Map(rows.map((r) => [r.id, toSummary(r)]));
}

export const DEFAULT_SPACE_MEET_SETTINGS = {
  guestsAllowed: true,
  editorsCanRecord: true,
  recordingRetentionDays: MEET_LIMITS.defaultRetentionDays as number | null,
};

export async function spaceMeetSettings(
  db: DbOrTx,
  spaceIds: (string | null)[],
): Promise<Map<string, Omit<MeetSpaceSettings, 'spaceId'>>> {
  const ids = [...new Set(spaceIds.filter((x): x is string => Boolean(x)))];
  const out = new Map<string, Omit<MeetSpaceSettings, 'spaceId'>>();
  if (!ids.length) return out;
  const rows = await db
    .select()
    .from(meetSpaceSettings)
    .where(inArray(meetSpaceSettings.spaceId, ids));
  for (const id of ids) out.set(id, { ...DEFAULT_SPACE_MEET_SETTINGS });
  for (const r of rows) {
    out.set(r.spaceId, {
      guestsAllowed: r.guestsAllowed,
      editorsCanRecord: r.editorsCanRecord,
      recordingRetentionDays: r.recordingRetentionDays,
    });
  }
  return out;
}

const RANK: Record<SpaceRole, number> = { viewer: 0, editor: 1, admin: 2, owner: 3 };

/**
 * Doc 17 §5 "Toplantı başlatma / katılma" and design 07 rules:
 * - host, invitees, people made moderator and members of the meeting's space join directly;
 * - a conversation-attached meeting without a space follows the conversation's members;
 * - a meeting with neither (personal room, ad hoc call) is open to the org's members;
 * - everybody else knocks (lobby). Moderators: host, space Admin/Owner, made moderator.
 */
export async function accessFor(
  db: DbOrTx,
  a: MeetActor,
  m: MeetingRow,
  pre?: {
    spaceRole?: SpaceRole | null;
    invited?: boolean;
    space?: Omit<MeetSpaceSettings, 'spaceId'>;
  },
): Promise<MeetingAccess> {
  const spaceRole =
    pre?.spaceRole !== undefined
      ? pre.spaceRole
      : m.spaceId
        ? (((
            await db
              .select({ role: spaceMembers.role })
              .from(spaceMembers)
              .where(and(eq(spaceMembers.spaceId, m.spaceId), eq(spaceMembers.userId, a.userId)))
          )[0]?.role ?? null) as SpaceRole | null)
        : null;
  const invited =
    pre?.invited ??
    (
      await db
        .select({ id: meetingInvitees.id })
        .from(meetingInvitees)
        .where(and(eq(meetingInvitees.meetingId, m.id), eq(meetingInvitees.userId, a.userId)))
    ).length > 0;
  const space =
    pre?.space ??
    (m.spaceId
      ? (await spaceMeetSettings(db, [m.spaceId])).get(m.spaceId)!
      : DEFAULT_SPACE_MEET_SETTINGS);
  const isHost = m.hostUserId === a.userId;
  const madeModerator = (m.settings.moderatorIds ?? []).includes(a.userId);
  const moderator =
    isHost || madeModerator || (spaceRole !== null && RANK[spaceRole] >= RANK.admin);

  let direct = isHost || invited || madeModerator;
  if (!direct && m.spaceId) direct = spaceRole !== null;
  else if (!direct && m.conversationId) {
    const member = await conversationMember(db, m.conversationId, a.userId);
    // Without chat there is nothing to check against: org members are in.
    direct = member === null ? a.actor.orgRole !== 'guest' : member;
  } else if (!direct) direct = a.actor.orgRole !== 'guest';

  const publish = canMeet('publish', {
    spaceRole: invited ? null : spaceRole,
    moderator,
    guest: false,
    editorsCanRecord: space.editorsCanRecord,
  });
  const role: MeetingRole = moderator ? 'moderator' : publish ? 'member' : 'listener';
  return {
    spaceRole,
    invited,
    moderator,
    direct,
    role,
    editorsCanRecord: space.editorsCanRecord,
    guestsAllowedBySpace: space.guestsAllowed,
  };
}

export function canRecord(acc: MeetingAccess) {
  return canMeet('record', {
    spaceRole: acc.spaceRole,
    moderator: acc.moderator,
    guest: false,
    editorsCanRecord: acc.editorsCanRecord,
  });
}

export async function loadMeetingRow(db: DbOrTx, orgId: string, meetingId: string) {
  const [row] = await db
    .select()
    .from(meetings)
    .where(and(eq(meetings.id, meetingId), eq(meetings.orgId, orgId)));
  if (!row) throw new AppError('not_found');
  return row;
}

/**
 * A meeting the caller may see: direct access, or a knock of theirs. Without either
 * it does not exist for them (404), like nodes (design 1.18).
 */
export async function loadMeeting(db: DbOrTx, a: MeetActor, meetingId: string) {
  const meeting = await loadMeetingRow(db, a.org.id, meetingId);
  const access = await accessFor(db, a, meeting);
  return { meeting, access };
}

export async function requireModerator(db: DbOrTx, a: MeetActor, meetingId: string) {
  const loaded = await loadMeeting(db, a, meetingId);
  if (!loaded.access.direct) throw new AppError('not_found');
  if (!loaded.access.moderator) throw new AppError('meet_not_moderator');
  return loaded;
}

export async function liveSession(db: DbOrTx, meetingId: string) {
  const [row] = await db
    .select()
    .from(meetingSessions)
    .where(and(eq(meetingSessions.meetingId, meetingId), isNull(meetingSessions.endedAt)));
  return row ?? null;
}

/** The open session of a meeting, created when LiveKit has not told us yet. */
export async function ensureSession(db: DbOrTx, m: MeetingRow, roomSid: string | null, at: Date) {
  const open = await liveSession(db, m.id);
  if (open) {
    if (roomSid && !open.roomSid) {
      await db.update(meetingSessions).set({ roomSid }).where(eq(meetingSessions.id, open.id));
    }
    return { session: open, created: false };
  }
  const [created] = await db
    .insert(meetingSessions)
    .values({ orgId: m.orgId, meetingId: m.id, roomSid, startedAt: at })
    .onConflictDoNothing()
    .returning();
  if (created) return { session: created, created: true };
  return { session: (await liveSession(db, m.id))!, created: false };
}

export function meetingUrl(hubUrl: string, slug: string) {
  return new URL(paths.meetingJoin(slug), hubUrl).toString();
}

export function settingsOut(s: MeetingSettingsData): Meeting['settings'] {
  return {
    guestsAllowed: s.guestsAllowed,
    lobby: s.lobby,
    autoRecord: s.autoRecord,
    guestLinkHours: s.guestLinkHours,
    remoteControl: s.remoteControl !== false,
  };
}

/** Meeting rows → contract shape with live state, invitees and the caller's rights. */
export async function toMeetings(
  db: DbOrTx,
  a: MeetActor,
  rows: MeetingRow[],
  hubUrl: string,
  now = new Date(),
  timeZone = 'UTC',
): Promise<Meeting[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const spaceIds = rows.map((r) => r.spaceId);
  const realSpaceIds = [...new Set(spaceIds.filter((x): x is string => Boolean(x)))];

  const [spaceRows, myRoles, invitees, sessions, activeRecs, settings, events] = await Promise.all([
    realSpaceIds.length
      ? db.select().from(spaces).where(inArray(spaces.id, realSpaceIds))
      : Promise.resolve([]),
    realSpaceIds.length
      ? db
          .select({ spaceId: spaceMembers.spaceId, role: spaceMembers.role })
          .from(spaceMembers)
          .where(
            and(inArray(spaceMembers.spaceId, realSpaceIds), eq(spaceMembers.userId, a.userId)),
          )
      : Promise.resolve([]),
    db.select().from(meetingInvitees).where(inArray(meetingInvitees.meetingId, ids)),
    db
      .select()
      .from(meetingSessions)
      .where(and(inArray(meetingSessions.meetingId, ids), isNull(meetingSessions.endedAt))),
    db
      .select()
      .from(recordings)
      .where(
        and(
          inArray(recordings.meetingId, ids),
          inArray(recordings.status, ['starting', 'recording']),
          // Stopped by a moderator: egress is only finishing the file.
          isNull(recordings.endedAt),
        ),
      ),
    spaceMeetSettings(db, spaceIds),
    db
      .select({ id: calendarEvents.id, meetingId: calendarEvents.meetingId })
      .from(calendarEvents)
      .where(and(inArray(calendarEvents.meetingId, ids), isNull(calendarEvents.deletedAt))),
  ]);
  const eventByMeeting = new Map(events.map((e) => [e.meetingId, e.id]));
  const sessionIds = sessions.map((s) => s.id);
  const live = sessionIds.length
    ? await db
        .select()
        .from(meetingParticipants)
        .where(
          and(
            inArray(meetingParticipants.sessionId, sessionIds),
            isNull(meetingParticipants.leftAt),
          ),
        )
        .orderBy(meetingParticipants.joinedAt)
    : [];
  const people = await usersByIds(db, [
    ...rows.map((r) => r.hostUserId),
    ...invitees.map((i) => i.userId),
    ...sessions.map((s) => s.startedBy),
    ...live.map((p) => p.userId),
    ...activeRecs.map((r) => r.startedBy),
  ]);
  const spaceById = new Map(spaceRows.map((s) => [s.id, s]));
  const roleBySpace = new Map(myRoles.map((r) => [r.spaceId, r.role as SpaceRole]));

  const out: Meeting[] = [];
  for (const m of rows) {
    const mine = invitees.filter((i) => i.meetingId === m.id);
    const space = m.spaceId ? spaceById.get(m.spaceId) : undefined;
    const access = await accessFor(db, a, m, {
      spaceRole: m.spaceId ? (roleBySpace.get(m.spaceId) ?? null) : null,
      invited: mine.some((i) => i.userId === a.userId),
      space: m.spaceId ? settings.get(m.spaceId) : undefined,
    });
    const session = sessions.find((s) => s.meetingId === m.id);
    const inside = session ? live.filter((p) => p.sessionId === session.id) : [];
    // People, not connections: someone on two devices counts once.
    const distinct = [...new Map(inside.map((p) => [p.userId ?? p.identity, p])).values()];
    const rec = activeRecs.find((r) => r.meetingId === m.id);
    const startsAt =
      m.startsAt && m.durationMinutes
        ? (nextOccurrence(m.startsAt, m.durationMinutes, m.recurrence, now, timeZone) ?? m.startsAt)
        : m.startsAt;
    out.push({
      id: m.id,
      kind: m.kind,
      title: m.title,
      description: m.description,
      spaceId: m.spaceId,
      spaceName: space?.name ?? null,
      spaceColor: space?.color ?? null,
      conversationId: m.conversationId,
      chatConversationId: m.chatConversationId,
      slug: m.joinSlug,
      url: meetingUrl(hubUrl, m.joinSlug),
      host: m.hostUserId ? (people.get(m.hostUserId) ?? null) : null,
      startsAt: startsAt?.toISOString() ?? null,
      durationMinutes: m.durationMinutes,
      recurrence: m.recurrence,
      settings: settingsOut(m.settings),
      invitees: mine.map((i) => ({
        id: i.id,
        user: i.userId ? (people.get(i.userId) ?? null) : null,
        email: i.userId ? null : i.email,
        guest: !i.userId,
      })),
      live: session
        ? {
            sessionId: session.id,
            startedAt: session.startedAt.toISOString(),
            startedBy: session.startedBy ? (people.get(session.startedBy) ?? null) : null,
            participantCount: distinct.length,
            participants: distinct.slice(0, 6).map((p) => ({
              name: p.userId
                ? (people.get(p.userId)?.name ?? p.guestName ?? '')
                : (p.guestName ?? ''),
              user: p.userId ? (people.get(p.userId) ?? null) : null,
            })),
            recording: rec
              ? {
                  id: rec.id,
                  startedAt: rec.startedAt.toISOString(),
                  startedBy: rec.startedBy ? (people.get(rec.startedBy) ?? null) : null,
                  audioOnly: rec.audioOnly,
                }
              : null,
          }
        : null,
      cancelledAt: m.cancelledAt?.toISOString() ?? null,
      createdAt: m.createdAt.toISOString(),
      calendarEventId: eventByMeeting.get(m.id) ?? null,
      myRole: access.direct ? access.role : null,
      permissions: {
        join: !m.cancelledAt,
        moderate: access.direct && access.moderator,
        record: access.direct && canRecord(access),
        inviteGuests: access.moderator && access.guestsAllowedBySpace,
        remoteControl:
          orgAllowsRemoteControl(a.org.settings as OrgSettings) && meetingAllowsRemoteControl(m),
      },
    });
  }
  return out;
}

export async function toMeeting(db: DbOrTx, a: MeetActor, row: MeetingRow, hubUrl: string) {
  const [m] = await toMeetings(db, a, [row], hubUrl);
  return m!;
}

/** Meetings the caller sees in lists: hosted, invited, or in one of their spaces. */
export function visibleTo(a: MeetActor) {
  return sql`(${meetings.hostUserId} = ${a.userId}
    or ${meetings.id} in (select ${meetingInvitees.meetingId} from ${meetingInvitees} where ${meetingInvitees.userId} = ${a.userId})
    or ${meetings.spaceId} in (select ${spaceMembers.spaceId} from ${spaceMembers} where ${spaceMembers.userId} = ${a.userId}))`;
}
