import { randomBytes } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import {
  calendarEvents,
  meetingCalls,
  meetingInvitees,
  meetingParticipants,
  meetings,
  meetingSessions,
  newId,
  orgMembers,
  organizations,
  recordings,
  spaces,
  users,
  type DbOrTx,
  type MeetingSettingsData,
} from '@crewhall/db';
import { resources, type AppLocale } from '@crewhall/i18n';
import {
  canMeet,
  DEFAULT_MEETING_SETTINGS,
  MEET_IDENTITY,
  type CreateMeeting,
  type Meeting,
  type MeetHome,
  type MeetingLinkPreview,
  type MeetingParticipantRecord,
  type MeetingRecording,
  type MeetingSessionDetail,
  type MeetingSessionSummary,
  type SpaceRole,
  type UpdateMeeting,
  paths,
} from '@crewhall/shared';
import type { Deps } from '../../deps';
import { AppError } from '../../http/errors';
import { slugify } from '../spaces';
import {
  accessFor,
  loadMeeting,
  liveSession,
  loadMeetingRow,
  requireModerator,
  spaceMeetSettings,
  toMeeting,
  toMeetings,
  usersByIds,
  visibleTo,
  type MeetActor,
  type MeetingRow,
  type RecordingRow,
} from './access';
import {
  addConversationMembers,
  conversationInfo,
  ensureMeetingConversation,
  notifyMeet,
} from './chat-bridge';
import { sendMeetingMails, type MailRecipient } from './mail';
import { recordingOut } from './recordings-out';
import { nextOccurrence, safeTimeZone, sameLocalDay } from './schedule';
import { meetEnabled } from './module';
import { roomMeta } from './join';
import { liveKit } from './livekit';

const suffix = () =>
  Array.from(randomBytes(5), (b) => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('');

async function slugTaken(db: DbOrTx, slug: string) {
  return (
    (await db.select({ id: meetings.id }).from(meetings).where(eq(meetings.joinSlug, slug)))
      .length > 0
  );
}

/** `opsiyon-demo-7k2xq`: readable and hard to guess (the lobby guards the rest). */
async function newSlug(db: DbOrTx, title: string, kind: Meeting['kind'], wanted?: string) {
  if (wanted) {
    if (await slugTaken(db, wanted)) throw new AppError('meet_slug_taken');
    return wanted;
  }
  const base = slugify(title).slice(0, 30).replace(/-+$/g, '') || 'toplanti';
  if (kind === 'room' && !(await slugTaken(db, base))) return base;
  for (let i = 0; i < 10; i++) {
    const candidate = `${base}-${suffix()}`;
    if (!(await slugTaken(db, candidate))) return candidate;
  }
  throw new AppError('internal', { reason: 'slug_exhausted' });
}

async function spaceRoleFor(db: DbOrTx, a: MeetActor, spaceId: string) {
  const [row] = await db
    .select({
      space: spaces,
      role: sql<SpaceRole | null>`(select role from space_members where space_id = ${spaces.id} and user_id = ${a.userId})`,
    })
    .from(spaces)
    .where(and(eq(spaces.id, spaceId), eq(spaces.orgId, a.org.id)));
  if (!row || row.role === null) throw new AppError('not_found');
  if (row.space.archivedAt) throw new AppError('forbidden', { reason: 'archived' });
  return { space: row.space, role: row.role };
}

/** Invitees: org members by id or e-mail; other e-mails are guests. */
async function resolveInvitees(
  db: DbOrTx,
  orgId: string,
  input: { userIds: string[]; emails: string[] },
) {
  const emails = [...new Set(input.emails.map((e) => e.trim().toLowerCase()))];
  const byEmail = emails.length
    ? await db
        .select({ id: users.id, email: users.email })
        .from(users)
        .innerJoin(orgMembers, eq(orgMembers.userId, users.id))
        .where(
          and(
            eq(orgMembers.organizationId, orgId),
            eq(orgMembers.status, 'active'),
            inArray(sql`lower(${users.email})`, emails),
          ),
        )
    : [];
  const memberEmails = new Set(byEmail.map((u) => u.email.toLowerCase()));
  const wantedIds = [...new Set([...input.userIds, ...byEmail.map((u) => u.id)])];
  const members = wantedIds.length
    ? await db
        .select({ id: orgMembers.userId })
        .from(orgMembers)
        .where(
          and(
            eq(orgMembers.organizationId, orgId),
            eq(orgMembers.status, 'active'),
            inArray(orgMembers.userId, wantedIds),
          ),
        )
    : [];
  if (members.length !== wantedIds.length) throw new AppError('member_not_found');
  return { userIds: wantedIds, guestEmails: emails.filter((e) => !memberEmails.has(e)) };
}

async function orgLocale(db: DbOrTx, orgId: string): Promise<AppLocale> {
  const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId));
  return org?.settings.defaultLocale ?? 'tr';
}

/** Recipients and ATTENDEE lines of a meeting's invitees (optionally only some rows). */
async function mailTargets(db: DbOrTx, m: MeetingRow, onlyIds?: Set<string>) {
  const rows = await db
    .select({ invitee: meetingInvitees, user: users })
    .from(meetingInvitees)
    .leftJoin(users, eq(users.id, meetingInvitees.userId))
    .where(eq(meetingInvitees.meetingId, m.id));
  const locale = await orgLocale(db, m.orgId);
  const attendees = rows.map((r) => ({
    name: r.user?.name ?? null,
    email: r.user?.email ?? r.invitee.email ?? '',
  }));
  const recipients: MailRecipient[] = rows
    .filter((r) => !onlyIds || onlyIds.has(r.invitee.id))
    .map((r) => ({
      email: r.user?.email ?? r.invitee.email ?? '',
      name: r.user?.name ?? null,
      guest: !r.user,
      locale: (r.user?.locale as AppLocale | undefined) ?? locale,
    }))
    .filter((r) => r.email);
  return { attendees: attendees.filter((x) => x.email), recipients };
}

async function insertInvitees(
  db: DbOrTx,
  m: MeetingRow,
  invitedBy: string,
  userIds: string[],
  emails: string[],
) {
  const values = [
    ...userIds.map((userId) => ({ userId, email: null })),
    ...emails.map((email) => ({ userId: null, email })),
  ].map((v) => ({ id: newId(), orgId: m.orgId, meetingId: m.id, invitedBy, ...v }));
  if (!values.length) return [];
  return db.insert(meetingInvitees).values(values).onConflictDoNothing().returning();
}

async function assertGuestsAllowed(db: DbOrTx, spaceId: string | null) {
  if (!spaceId) return;
  const s = (await spaceMeetSettings(db, [spaceId])).get(spaceId)!;
  if (!s.guestsAllowed) throw new AppError('meet_guests_disabled');
}

export async function createMeeting(
  deps: Deps,
  a: MeetActor,
  input: CreateMeeting,
  /** Calls ring instead of sending meet.invited (calls.ts). */
  opts: { notify?: boolean } = {},
) {
  const { db } = deps;
  if (a.actor.orgRole === 'guest') throw new AppError('forbidden');
  const locale = await orgLocale(db, a.org.id);

  let spaceId: string | null = input.spaceId ?? null;
  let conversationId: string | null = null;
  let title = input.title ?? '';
  let sourceInvitees: string[] = [];

  if (input.mode !== 'room' && input.conversationId) {
    conversationId = input.conversationId;
    if (input.mode === 'instant') {
      // One room per conversation (design 07): reuse it.
      const [existing] = await db
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
      if (existing) {
        const { access } = await loadMeeting(db, a, existing.id);
        if (!access.direct) throw new AppError('not_found');
        return toMeeting(db, a, existing, deps.env.HUB_URL);
      }
    }
    const info = await conversationInfo(db, a.org.id, conversationId, a.userId);
    if (info) {
      if (!info.isMember) throw new AppError('not_found');
      title ||= info.title;
      spaceId ??= info.spaceId;
      if (input.mode === 'instant') sourceInvitees = info.inviteIds;
    }
  }
  if (spaceId) await assertCanStartIn(db, a, spaceId);
  title ||= resources[locale].email.meet.quickMeetingTitle;

  const settings: MeetingSettingsData = {
    ...DEFAULT_MEETING_SETTINGS,
    ...(input.mode !== 'instant' ? input.settings : {}),
  };
  let invitees = { userIds: [] as string[], guestEmails: [] as string[] };
  if (input.mode === 'scheduled') {
    invitees = await resolveInvitees(db, a.org.id, input.invitees);
    invitees.userIds = invitees.userIds.filter((id) => id !== a.userId);
    if (invitees.guestEmails.length) settings.guestsAllowed = true;
  }
  // Instant meetings from a direct or group chat invite its members (design 13.12).
  if (input.mode === 'instant') invitees.userIds = sourceInvitees;
  if (settings.guestsAllowed) await assertGuestsAllowed(db, spaceId);

  const kind = input.mode === 'instant' ? 'chat' : input.mode;
  const id = newId();
  const [row] = await db
    .insert(meetings)
    .values({
      id,
      orgId: a.org.id,
      kind,
      title,
      description: input.mode === 'scheduled' ? (input.description ?? null) : null,
      spaceId,
      conversationId,
      roomName: `m-${id}`,
      joinSlug: await newSlug(db, title, kind, input.mode === 'room' ? input.slug : undefined),
      hostUserId: a.userId,
      startsAt: input.mode === 'scheduled' ? new Date(input.startsAt) : null,
      durationMinutes: input.mode === 'scheduled' ? input.durationMinutes : null,
      recurrence: input.mode === 'scheduled' ? input.recurrence : 'none',
      settings,
    })
    .returning();
  const meeting = row!;
  await insertInvitees(db, meeting, a.userId, invitees.userIds, invitees.guestEmails);

  const chatId = await ensureMeetingConversation(deps, a, {
    meetingId: meeting.id,
    title,
    spaceId,
    memberIds: [a.userId, ...invitees.userIds],
  });
  if (chatId) {
    await db
      .update(meetings)
      .set({ chatConversationId: chatId })
      .where(eq(meetings.id, meeting.id));
    meeting.chatConversationId = chatId;
  }

  if (input.mode === 'instant' && invitees.userIds.length && opts.notify !== false) {
    await notifyMeet(deps, {
      orgId: a.org.id,
      userIds: invitees.userIds,
      type: 'meet.invited',
      actorId: a.userId,
      meetingId: meeting.id,
      conversationId,
      url: paths.meetingJoin(meeting.joinSlug),
      data: { title, startsAt: null },
    });
  }
  if (input.mode === 'scheduled') {
    const targets = await mailTargets(db, meeting);
    await sendMeetingMails(deps, {
      meeting,
      kind: 'invite',
      ...targets,
      inviter: { name: a.userName },
    });
    if (invitees.userIds.length) {
      await notifyMeet(deps, {
        orgId: a.org.id,
        userIds: invitees.userIds,
        type: 'meet.invited',
        actorId: a.userId,
        meetingId: meeting.id,
        url: paths.meetingJoin(meeting.joinSlug),
        data: { title, startsAt: meeting.startsAt?.toISOString() ?? null },
      });
    }
  }
  return toMeeting(db, a, meeting, deps.env.HUB_URL);
}

export async function getMeeting(deps: Deps, a: MeetActor, meetingId: string) {
  const { meeting, access } = await loadMeeting(deps.db, a, meetingId);
  if (!access.direct) {
    // A member waiting in the lobby may see what they knocked on.
    throw new AppError('not_found');
  }
  return toMeeting(deps.db, a, meeting, deps.env.HUB_URL);
}

/** Starting (or moving) a meeting in a space needs the space's start right. */
async function assertCanStartIn(db: DbOrTx, a: MeetActor, spaceId: string) {
  const { role } = await spaceRoleFor(db, a, spaceId);
  if (
    !canMeet('start', {
      spaceRole: role,
      moderator: false,
      guest: false,
      editorsCanRecord: false,
    })
  ) {
    throw new AppError('forbidden');
  }
}

const TIME_FIELDS = ['startsAt', 'durationMinutes', 'recurrence', 'title', 'description'] as const;

export async function updateMeeting(
  deps: Deps,
  a: MeetActor,
  meetingId: string,
  input: UpdateMeeting,
) {
  const { db } = deps;
  const { meeting } = await requireModerator(db, a, meetingId);
  if (meeting.cancelledAt) throw new AppError('meet_ended');
  const settings: MeetingSettingsData = { ...meeting.settings, ...input.settings };
  // Another space: the same rule as starting a meeting there.
  const spaceId = input.spaceId !== undefined ? input.spaceId : meeting.spaceId;
  if (spaceId && spaceId !== meeting.spaceId) await assertCanStartIn(db, a, spaceId);
  let added: string[] = [];

  let removedTargets: Awaited<ReturnType<typeof mailTargets>> | null = null;

  if (input.invitees) {
    const resolved = await resolveInvitees(db, a.org.id, input.invitees);
    if (resolved.guestEmails.length) settings.guestsAllowed = true;
    const current = await db
      .select()
      .from(meetingInvitees)
      .where(eq(meetingInvitees.meetingId, meeting.id));
    const keepUsers = new Set(resolved.userIds);
    const keepEmails = new Set(resolved.guestEmails);
    const removedRows = current.filter((r) =>
      r.userId ? !keepUsers.has(r.userId) : !keepEmails.has((r.email ?? '').toLowerCase()),
    );
    if (removedRows.length) {
      removedTargets = await mailTargets(db, meeting, new Set(removedRows.map((r) => r.id)));
      await db.delete(meetingInvitees).where(
        inArray(
          meetingInvitees.id,
          removedRows.map((r) => r.id),
        ),
      );
    }
    const existingUsers = new Set(current.map((r) => r.userId).filter(Boolean));
    const existingEmails = new Set(current.map((r) => (r.email ?? '').toLowerCase()));
    const inserted = await insertInvitees(
      db,
      meeting,
      a.userId,
      resolved.userIds.filter((id) => !existingUsers.has(id) && id !== meeting.hostUserId),
      resolved.guestEmails.filter((e) => !existingEmails.has(e)),
    );
    added = inserted.map((r) => r.id);
    if (inserted.some((r) => r.userId) && meeting.chatConversationId) {
      await addConversationMembers(
        deps,
        a,
        meeting.chatConversationId,
        inserted.map((r) => r.userId).filter((x): x is string => Boolean(x)),
      );
    }
  }
  if (settings.guestsAllowed && (!meeting.settings.guestsAllowed || spaceId !== meeting.spaceId)) {
    await assertGuestsAllowed(db, spaceId);
  }

  const timeChanged = TIME_FIELDS.some((k) => input[k] !== undefined);
  const [row] = await db
    .update(meetings)
    .set({
      title: input.title ?? meeting.title,
      description: input.description !== undefined ? input.description : meeting.description,
      startsAt: input.startsAt ? new Date(input.startsAt) : meeting.startsAt,
      durationMinutes: input.durationMinutes ?? meeting.durationMinutes,
      recurrence: input.recurrence ?? meeting.recurrence,
      spaceId,
      settings,
      icsSequence: timeChanged ? meeting.icsSequence + 1 : meeting.icsSequence,
    })
    .where(eq(meetings.id, meeting.id))
    .returning();
  const updated = row!;

  if (updated.kind === 'scheduled') {
    const inviter = { name: a.userName };
    await notifyChanged(deps, a, updated, added, timeChanged);
    if (removedTargets?.recipients.length) {
      await sendMeetingMails(deps, {
        meeting: { ...updated, icsSequence: updated.icsSequence + 1 },
        kind: 'cancel',
        ...removedTargets,
        inviter,
      });
    }
    const all = await mailTargets(db, updated);
    if (added.length) {
      const fresh = await mailTargets(db, updated, new Set(added));
      await sendMeetingMails(deps, {
        meeting: updated,
        kind: 'invite',
        recipients: fresh.recipients,
        attendees: all.attendees,
        inviter,
      });
    }
    if (timeChanged) {
      const addedSet = new Set(added);
      const rest = await db
        .select({ id: meetingInvitees.id })
        .from(meetingInvitees)
        .where(eq(meetingInvitees.meetingId, updated.id));
      const ids = new Set(rest.map((r) => r.id).filter((id) => !addedSet.has(id)));
      if (ids.size) {
        const others = await mailTargets(db, updated, ids);
        await sendMeetingMails(deps, {
          meeting: updated,
          kind: 'update',
          recipients: others.recipients,
          attendees: all.attendees,
          inviter,
        });
      }
    }
  }
  // A moderator turning remote control off: sharers in the room stop at once (room metadata).
  if (input.settings?.remoteControl !== undefined) {
    const gw = liveKit(deps);
    if (gw && (await liveSession(db, updated.id))) {
      await gw
        .updateRoomMetadata(updated.roomName, JSON.stringify(await roomMeta(db, updated)))
        .catch((err: unknown) => deps.logger.warn({ err }, 'room metadata not updated'));
    }
  }
  return toMeeting(db, a, updated, deps.env.HUB_URL);
}

/** Account holders invited to a meeting. */
async function inviteeUserIds(db: DbOrTx, meetingId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: meetingInvitees.userId })
    .from(meetingInvitees)
    .where(and(eq(meetingInvitees.meetingId, meetingId), isNotNull(meetingInvitees.userId)));
  return rows.map((r) => r.userId!);
}

/**
 * The bell for a scheduled meeting that changed: people just added are invited, the others hear
 * that it moved or changed (the .ics mails go out separately).
 */
async function notifyChanged(
  deps: Deps,
  a: MeetActor,
  m: MeetingRow,
  addedInviteeIds: string[],
  changed: boolean,
) {
  const rows = await deps.db
    .select({ id: meetingInvitees.id, userId: meetingInvitees.userId })
    .from(meetingInvitees)
    .where(and(eq(meetingInvitees.meetingId, m.id), isNotNull(meetingInvitees.userId)));
  const added = new Set(addedInviteeIds);
  const fresh = rows.filter((r) => added.has(r.id)).map((r) => r.userId!);
  const others = rows.filter((r) => !added.has(r.id)).map((r) => r.userId!);
  const base = {
    orgId: a.org.id,
    actorId: a.userId,
    meetingId: m.id,
    spaceId: m.spaceId,
    url: paths.meetingJoin(m.joinSlug),
    data: { title: m.title, startsAt: m.startsAt?.toISOString() ?? null },
  };
  await notifyMeet(deps, { ...base, userIds: fresh, type: 'meet.invited' });
  if (changed) {
    await notifyMeet(deps, {
      ...base,
      userIds: others.filter((id) => id !== a.userId),
      type: 'meet.updated',
    });
  }
}

/** A meeting created from the calendar is edited and cancelled through its calendar event. */
export async function assertNotCalendarManaged(db: DbOrTx, meetingId: string) {
  const [event] = await db
    .select({ id: calendarEvents.id })
    .from(calendarEvents)
    .where(and(eq(calendarEvents.meetingId, meetingId), isNull(calendarEvents.deletedAt)));
  if (event) throw new AppError('meet_managed_by_calendar', { eventId: event.id });
}

export async function cancelMeeting(deps: Deps, a: MeetActor, meetingId: string) {
  const { db } = deps;
  const { meeting } = await requireModerator(db, a, meetingId);
  if (meeting.cancelledAt) return;
  // Cancelled or deleted soft (history and summaries stay, the link answers "ended"), but not
  // under people's feet.
  if (await liveSession(db, meeting.id)) throw new AppError('meet_room_live');
  const [row] = await db
    .update(meetings)
    .set({ cancelledAt: new Date(), icsSequence: meeting.icsSequence + 1 })
    .where(eq(meetings.id, meeting.id))
    .returning();
  if (row!.kind === 'scheduled') {
    const people = await inviteeUserIds(db, row!.id);
    await notifyMeet(deps, {
      orgId: a.org.id,
      userIds: people.filter((id) => id !== a.userId),
      type: 'meet.cancelled',
      actorId: a.userId,
      meetingId: row!.id,
      spaceId: row!.spaceId,
      url: paths.meetings(),
      data: { title: row!.title, startsAt: row!.startsAt?.toISOString() ?? null },
    });
    const targets = await mailTargets(db, row!);
    await sendMeetingMails(deps, {
      meeting: row!,
      kind: 'cancel',
      ...targets,
      inviter: { name: a.userName },
    });
  }
}

export async function inviteToMeeting(
  deps: Deps,
  a: MeetActor,
  meetingId: string,
  input: { userIds: string[]; emails: string[] },
) {
  const { db } = deps;
  const { meeting, access } = await requireModerator(db, a, meetingId);
  if (meeting.cancelledAt) throw new AppError('meet_ended');
  const resolved = await resolveInvitees(db, a.org.id, input);
  // "O an ihtiyacım var": while the meeting goes on, members are rung, not invited. Guests have
  // nothing to ring, so they still get the link by e-mail.
  if (resolved.userIds.length && (await liveSession(db, meeting.id))) {
    const { ringToMeeting } = await import('./calls');
    await ringToMeeting(deps, a, meeting.id, resolved.userIds);
    resolved.userIds = [];
  }
  if (resolved.guestEmails.length) {
    if (!access.guestsAllowedBySpace) throw new AppError('meet_guests_disabled');
    if (!meeting.settings.guestsAllowed) {
      await db
        .update(meetings)
        .set({ settings: { ...meeting.settings, guestsAllowed: true } })
        .where(eq(meetings.id, meeting.id));
      meeting.settings = { ...meeting.settings, guestsAllowed: true };
    }
  }
  const inserted = await insertInvitees(
    db,
    meeting,
    a.userId,
    resolved.userIds.filter((id) => id !== meeting.hostUserId),
    resolved.guestEmails,
  );
  const userIds = inserted.map((r) => r.userId).filter((x): x is string => Boolean(x));
  if (userIds.length && meeting.chatConversationId) {
    await addConversationMembers(deps, a, meeting.chatConversationId, userIds);
  }
  if (inserted.length) {
    const all = await mailTargets(db, meeting);
    const fresh = await mailTargets(db, meeting, new Set(inserted.map((r) => r.id)));
    if (meeting.startsAt) {
      await sendMeetingMails(deps, {
        meeting,
        kind: 'invite',
        recipients: fresh.recipients,
        attendees: all.attendees,
        inviter: { name: a.userName },
      });
    } else {
      // Rooms and instant calls have no time: send the link without a calendar entry.
      await sendLinkMails(deps, meeting, fresh.recipients, a.userName);
    }
    if (userIds.length) {
      await notifyMeet(deps, {
        orgId: a.org.id,
        userIds,
        type: 'meet.invited',
        actorId: a.userId,
        meetingId: meeting.id,
        url: paths.meetingJoin(meeting.joinSlug),
        data: { title: meeting.title, startsAt: meeting.startsAt?.toISOString() ?? null },
      });
    }
  }
  const fresh = await loadMeetingRow(db, a.org.id, meeting.id);
  return toMeeting(db, a, fresh, deps.env.HUB_URL);
}

/** Invitation without a calendar entry (room or running call): reuses the invite mail. */
async function sendLinkMails(
  deps: Deps,
  meeting: MeetingRow,
  recipients: MailRecipient[],
  inviterName: string,
) {
  const start = new Date();
  await sendMeetingMails(deps, {
    meeting: { ...meeting, startsAt: start, durationMinutes: 60, recurrence: 'none' },
    kind: 'invite',
    recipients,
    attendees: recipients.map((r) => ({ name: r.name, email: r.email })),
    inviter: { name: inviterName },
  });
}

export async function rotateLink(deps: Deps, a: MeetActor, meetingId: string) {
  const { db } = deps;
  const { meeting } = await requireModerator(db, a, meetingId);
  const base = meeting.joinSlug.replace(/-[a-z0-9]{5}$/, '');
  let slug = '';
  for (let i = 0; i < 10 && !slug; i++) {
    const candidate = `${base}-${suffix()}`;
    if (!(await slugTaken(db, candidate))) slug = candidate;
  }
  const [row] = await db
    .update(meetings)
    .set({ joinSlug: slug })
    .where(eq(meetings.id, meeting.id))
    .returning();
  return toMeeting(db, a, row!, deps.env.HUB_URL);
}

// ---- Lists ------------------------------------------------------------------------------

export async function meetHome(deps: Deps, a: MeetActor, tz?: string): Promise<MeetHome> {
  const { db } = deps;
  const timeZone = safeTimeZone(tz);
  const now = new Date();
  const rows = await db
    .select()
    .from(meetings)
    .where(and(eq(meetings.orgId, a.org.id), isNull(meetings.cancelledAt), visibleTo(a)))
    .orderBy(asc(meetings.createdAt));
  const liveIds = new Set(
    (
      await db
        .select({ meetingId: meetingSessions.meetingId })
        .from(meetingSessions)
        .where(
          and(
            isNull(meetingSessions.endedAt),
            inArray(
              meetingSessions.meetingId,
              rows.map((r) => r.id).concat('00000000-0000-0000-0000-000000000000'),
            ),
          ),
        )
    ).map((r) => r.meetingId),
  );
  const live = rows.filter((r) => liveIds.has(r.id));
  const occurrence = new Map<string, Date | null>();
  for (const r of rows) {
    if (r.kind === 'scheduled' && r.startsAt && r.durationMinutes) {
      occurrence.set(
        r.id,
        nextOccurrence(r.startsAt, r.durationMinutes, r.recurrence, now, timeZone),
      );
    }
  }
  const today = rows
    .filter((r) => {
      const at = occurrence.get(r.id);
      return at && sameLocalDay(at, now, timeZone);
    })
    .sort((x, y) => occurrence.get(x.id)!.getTime() - occurrence.get(y.id)!.getTime());
  const rooms = rows.filter((r) => r.kind === 'room');
  const upcomingCount = rows.filter((r) => occurrence.get(r.id)).length;
  const [rec] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(recordings)
    .innerJoin(meetings, eq(meetings.id, recordings.meetingId))
    .where(and(eq(recordings.orgId, a.org.id), eq(recordings.status, 'ready'), visibleTo(a)));

  const all = await toMeetings(
    db,
    a,
    [...new Set([...live, ...today, ...rooms])],
    deps.env.HUB_URL,
    now,
    timeZone,
  );
  const byId = new Map(all.map((m) => [m.id, m]));
  return {
    live: live.map((r) => byId.get(r.id)!),
    today: today.map((r) => byId.get(r.id)!),
    rooms: rooms.map((r) => byId.get(r.id)!),
    upcomingCount,
    recordingCount: rec?.n ?? 0,
  };
}

const offsetCursor = (cursor: string | undefined) => {
  const n = cursor ? Number.parseInt(cursor, 10) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
};

export async function listMeetings(
  deps: Deps,
  a: MeetActor,
  q: { view: 'upcoming' | 'rooms' | 'all'; spaceId?: string; cursor?: string; limit: number },
) {
  const { db } = deps;
  const now = new Date();
  const rows = await db
    .select()
    .from(meetings)
    .where(
      and(
        eq(meetings.orgId, a.org.id),
        isNull(meetings.cancelledAt),
        visibleTo(a),
        q.spaceId ? eq(meetings.spaceId, q.spaceId) : undefined,
        q.view === 'rooms' ? eq(meetings.kind, 'room') : undefined,
        q.view === 'upcoming' ? eq(meetings.kind, 'scheduled') : undefined,
      ),
    )
    .orderBy(desc(meetings.createdAt));
  let list = rows;
  if (q.view === 'upcoming') {
    const at = new Map(
      rows.map((r) => [
        r.id,
        r.startsAt && r.durationMinutes
          ? nextOccurrence(r.startsAt, r.durationMinutes, r.recurrence, now)
          : null,
      ]),
    );
    list = rows
      .filter((r) => at.get(r.id))
      .sort((x, y) => at.get(x.id)!.getTime() - at.get(y.id)!.getTime());
  }
  const start = offsetCursor(q.cursor);
  const slice = list.slice(start, start + q.limit);
  return {
    items: await toMeetings(db, a, slice, deps.env.HUB_URL, now),
    nextCursor: start + q.limit < list.length ? String(start + q.limit) : null,
  };
}

async function participantsBySession(db: DbOrTx, sessionIds: string[]) {
  if (!sessionIds.length) return new Map<string, (typeof meetingParticipants.$inferSelect)[]>();
  const rows = await db
    .select()
    .from(meetingParticipants)
    .where(inArray(meetingParticipants.sessionId, sessionIds))
    .orderBy(asc(meetingParticipants.joinedAt));
  const out = new Map<string, typeof rows>();
  for (const r of rows) out.set(r.sessionId, [...(out.get(r.sessionId) ?? []), r]);
  return out;
}

async function recordingsBySession(db: DbOrTx, sessionIds: string[]) {
  if (!sessionIds.length) return new Map<string, RecordingRow[]>();
  const rows = await db
    .select()
    .from(recordings)
    .where(inArray(recordings.sessionId, sessionIds))
    .orderBy(asc(recordings.startedAt));
  const out = new Map<string, RecordingRow[]>();
  for (const r of rows) out.set(r.sessionId!, [...(out.get(r.sessionId!) ?? []), r]);
  return out;
}

type ParticipantRow = typeof meetingParticipants.$inferSelect;

/** Joins of a session folded per identity (a person who rejoined counts once). */
function foldPeople(
  rows: ParticipantRow[],
  people: Map<string, Meeting['host'] & object>,
  now: Date,
): MeetingParticipantRecord[] {
  const byIdentity = new Map<string, MeetingParticipantRecord>();
  for (const p of rows) {
    const secs = Math.max(
      0,
      Math.round(((p.leftAt ?? now).getTime() - p.joinedAt.getTime()) / 1000),
    );
    const user = p.userId ? (people.get(p.userId) ?? null) : null;
    const prev = byIdentity.get(p.identity);
    if (prev) {
      prev.seconds += secs;
      prev.leftAt = p.leftAt ? p.leftAt.toISOString() : null;
      if (p.role === 'moderator') prev.role = 'moderator';
      continue;
    }
    byIdentity.set(p.identity, {
      identity: p.identity,
      name: user?.name ?? p.guestName ?? '',
      user,
      guest: !p.userId,
      role: p.role,
      joinedAt: p.joinedAt.toISOString(),
      leftAt: p.leftAt?.toISOString() ?? null,
      seconds: secs,
    });
  }
  return [...byIdentity.values()];
}

async function sessionSummaries(
  db: DbOrTx,
  rows: {
    session: typeof meetingSessions.$inferSelect;
    meeting: MeetingRow;
    spaceName: string | null;
  }[],
): Promise<MeetingSessionSummary[]> {
  const ids = rows.map((r) => r.session.id);
  const [parts, recs] = await Promise.all([
    participantsBySession(db, ids),
    recordingsBySession(db, ids),
  ]);
  const people = await usersByIds(db, [
    ...[...parts.values()].flat().map((p) => p.userId),
    ...[...recs.values()].flat().map((r) => r.startedBy),
  ]);
  const now = new Date();
  return Promise.all(
    rows.map(async ({ session, meeting, spaceName }) => {
      const folded = foldPeople(parts.get(session.id) ?? [], people, now);
      return {
        id: session.id,
        meetingId: meeting.id,
        title: meeting.title,
        kind: meeting.kind,
        spaceId: meeting.spaceId,
        spaceName,
        startedAt: session.startedAt.toISOString(),
        endedAt: session.endedAt?.toISOString() ?? null,
        durationSeconds: session.endedAt
          ? Math.round((session.endedAt.getTime() - session.startedAt.getTime()) / 1000)
          : null,
        participantCount: folded.length,
        participants: folded.slice(0, 8).map((p) => ({ name: p.name, user: p.user })),
        recordings: await Promise.all(
          (recs.get(session.id) ?? []).map((r) => recordingOut(db, r, people)),
        ),
      };
    }),
  );
}

export async function listHistory(
  deps: Deps,
  a: MeetActor,
  q: { spaceId?: string; meetingId?: string; recorded?: boolean; cursor?: string; limit: number },
) {
  const { db } = deps;
  const start = offsetCursor(q.cursor);
  const rows = await db
    .select({ session: meetingSessions, meeting: meetings, spaceName: spaces.name })
    .from(meetingSessions)
    .innerJoin(meetings, eq(meetings.id, meetingSessions.meetingId))
    .leftJoin(spaces, eq(spaces.id, meetings.spaceId))
    .where(
      and(
        eq(meetings.orgId, a.org.id),
        isNotNull(meetingSessions.endedAt),
        sql`(${visibleTo(a)} or ${meetingSessions.id} in (select ${meetingParticipants.sessionId} from ${meetingParticipants} where ${meetingParticipants.userId} = ${a.userId}))`,
        q.spaceId ? eq(meetings.spaceId, q.spaceId) : undefined,
        q.meetingId ? eq(meetings.id, q.meetingId) : undefined,
        q.recorded
          ? sql`exists (select 1 from ${recordings} where ${recordings.sessionId} = ${meetingSessions.id} and ${recordings.status} in ('ready', 'processing'))`
          : undefined,
      ),
    )
    .orderBy(desc(meetingSessions.startedAt))
    .offset(start)
    .limit(q.limit + 1);
  const pageRows = rows.slice(0, q.limit);
  const [items, rejoin] = await Promise.all([
    sessionSummaries(db, pageRows),
    rejoinSlugs(
      deps,
      a,
      pageRows.map((r) => r.meeting),
    ),
  ]);
  return {
    items: items.map((s) => ({ ...s, rejoinSlug: rejoin.get(s.id) ?? null })),
    nextCursor: rows.length > q.limit ? String(start + q.limit) : null,
  };
}

/**
 * History rows the caller can go back into (session id → room slug). A closed LiveKit room is no
 * obstacle, joining opens it again. What counts is what joinMeeting answers: not cancelled, in
 * without the lobby, not removed from the session running now. Besides that, a scheduled meeting
 * is over once its link has expired, and a call's room closes with the call (a new call rings
 * people, this would not). Older sessions of a meeting are the same room: only the newest gets it.
 */
async function rejoinSlugs(
  deps: Pick<Deps, 'db' | 'env'>,
  a: MeetActor,
  rows: MeetingRow[],
): Promise<Map<string, string>> {
  const { db } = deps;
  const now = new Date();
  const open = [...new Map(rows.map((m) => [m.id, m])).values()].filter((m) => {
    const expiry = guestLinkExpiry(m, now);
    return !m.cancelledAt && !(expiry && expiry < now);
  });
  const slugs = new Map<string, string>();
  if (!open.length) return slugs;
  const ids = open.map((m) => m.id);
  const [newest, running, calls, visible] = await Promise.all([
    db
      .selectDistinctOn([meetingSessions.meetingId], {
        id: meetingSessions.id,
        meetingId: meetingSessions.meetingId,
      })
      .from(meetingSessions)
      .where(and(inArray(meetingSessions.meetingId, ids), isNotNull(meetingSessions.endedAt)))
      .orderBy(meetingSessions.meetingId, desc(meetingSessions.startedAt)),
    db
      .select({
        meetingId: meetingSessions.meetingId,
        removed: meetingSessions.removedIdentities,
      })
      .from(meetingSessions)
      .where(and(inArray(meetingSessions.meetingId, ids), isNull(meetingSessions.endedAt))),
    db
      .selectDistinct({ meetingId: meetingCalls.meetingId })
      .from(meetingCalls)
      .where(inArray(meetingCalls.meetingId, ids)),
    toMeetings(db, a, open, deps.env.HUB_URL, now),
  ]);
  const callRooms = new Set(calls.map((c) => c.meetingId));
  const identity = MEET_IDENTITY.user(a.userId);
  const removedFrom = new Set(
    running.filter((s) => s.removed.includes(identity)).map((s) => s.meetingId),
  );
  // myRole is set only for people who connect directly.
  const direct = new Map(visible.filter((m) => m.myRole).map((m) => [m.id, m.slug]));
  for (const { id, meetingId } of newest) {
    const slug = direct.get(meetingId);
    if (slug && !callRooms.has(meetingId) && !removedFrom.has(meetingId)) slugs.set(id, slug);
  }
  return slugs;
}

/** Design 7.17: people who were in, the meeting's moderators and space members see it. */
export async function sessionDetail(
  deps: Deps,
  a: MeetActor,
  sessionId: string,
): Promise<MeetingSessionDetail> {
  const { db } = deps;
  const [row] = await db
    .select({ session: meetingSessions, meeting: meetings, spaceName: spaces.name })
    .from(meetingSessions)
    .innerJoin(meetings, eq(meetings.id, meetingSessions.meetingId))
    .leftJoin(spaces, eq(spaces.id, meetings.spaceId))
    .where(and(eq(meetingSessions.id, sessionId), eq(meetings.orgId, a.org.id)));
  if (!row) throw new AppError('not_found');
  const access = await accessFor(db, a, row.meeting);
  const parts = (await participantsBySession(db, [sessionId])).get(sessionId) ?? [];
  const wasIn = parts.some((p) => p.userId === a.userId);
  if (!wasIn && !access.direct) throw new AppError('not_found');
  const [summary] = await sessionSummaries(db, [row]);
  const people = await usersByIds(
    db,
    parts.map((p) => p.userId),
  );
  const folded = foldPeople(parts, people, new Date());
  return {
    ...summary!,
    meeting: await toMeeting(db, a, row.meeting, deps.env.HUB_URL),
    peakParticipants: row.session.peakParticipants,
    // Minutes per person are for the people who were there (mobile 13.18).
    people: wasIn || access.moderator ? folded : folded.map((p) => ({ ...p, seconds: 0 })),
    mySeconds: folded.find((p) => p.user?.id === a.userId)?.seconds ?? 0,
  };
}

// ---- Links ------------------------------------------------------------------------------

export async function meetingBySlug(db: DbOrTx, slug: string) {
  const [row] = await db.select().from(meetings).where(eq(meetings.joinSlug, slug));
  return row ?? null;
}

/** Guest link lifetime (7.12): until the scheduled end plus 1 or 24 hours. */
export function guestLinkExpiry(m: MeetingRow, now = new Date()): Date | null {
  if (m.kind !== 'scheduled' || !m.startsAt || !m.durationMinutes) return null;
  const at = nextOccurrence(m.startsAt, m.durationMinutes, m.recurrence, now) ?? m.startsAt;
  return new Date(at.getTime() + (m.durationMinutes + m.settings.guestLinkHours * 60) * 60_000);
}

export async function linkPreview(deps: Deps, slug: string): Promise<MeetingLinkPreview> {
  const { db } = deps;
  const m = await meetingBySlug(db, slug);
  if (!m) throw new AppError('not_found');
  if (!(await meetEnabled(db, m.orgId)))
    throw new AppError('meet_unavailable', { reason: 'module_disabled' });
  const [org] = await db.select().from(organizations).where(eq(organizations.id, m.orgId));
  const host = (await usersByIds(db, [m.hostUserId])).get(m.hostUserId ?? '');
  const session = await db
    .select()
    .from(meetingSessions)
    .where(and(eq(meetingSessions.meetingId, m.id), isNull(meetingSessions.endedAt)));
  const inside = session[0]
    ? await db
        .select({
          identity: meetingParticipants.identity,
          name: sql<string>`coalesce((select name from users where id = ${meetingParticipants.userId}), ${meetingParticipants.guestName}, '')`,
        })
        .from(meetingParticipants)
        .where(
          and(eq(meetingParticipants.sessionId, session[0].id), isNull(meetingParticipants.leftAt)),
        )
    : [];
  const distinct = [...new Map(inside.map((p) => [p.identity, p])).values()];
  const [rec] = await db
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
  const expiry = guestLinkExpiry(m);
  const status = m.cancelledAt ? 'ended' : expiry && expiry < new Date() ? 'expired' : 'valid';
  const initials = (name: string) =>
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0]!.toLocaleUpperCase('tr'))
      .join('');
  return {
    slug: m.joinSlug,
    meetingId: m.id,
    title: m.title,
    orgName: org?.branding.orgName ?? org?.name ?? '',
    orgLogoUrl: org?.branding.logoLightUrl ?? null,
    hostName: host?.name ?? null,
    startsAt: m.startsAt?.toISOString() ?? null,
    durationMinutes: m.durationMinutes,
    status,
    guestsAllowed: m.settings.guestsAllowed,
    lobby: m.settings.lobby,
    insideInitials: distinct.slice(0, 5).map((p) => initials(p.name)),
    insideCount: distinct.length,
    recording: Boolean(rec),
  };
}

export async function resolveLink(deps: Deps, a: MeetActor, slug: string): Promise<Meeting> {
  const m = await meetingBySlug(deps.db, slug);
  if (!m || m.orgId !== a.org.id) throw new AppError('not_found');
  return toMeeting(deps.db, a, m, deps.env.HUB_URL);
}

export type { MeetingRecording };
