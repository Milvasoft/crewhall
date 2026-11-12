import { and, eq, inArray, isNull, ne } from 'drizzle-orm';
import {
  calendarAttendees,
  calendarEvents,
  calendars,
  meetings,
  orgMembers,
  users,
  type DbOrTx,
} from '@crewhall/db';
import {
  parseRRule,
  weekdayOfDay,
  zonedDay,
  type MeetingRecurrence,
  paths,
} from '@crewhall/shared';
import type { Deps } from '../../deps';
import { AppError } from '../../http/errors';
import { isModuleEnabled } from '../identity/modules';
import { toActor } from '../membership';
import { meetingUrl, type MeetActor } from '../meet/access';
import { cancelMeeting, createMeeting, updateMeeting } from '../meet/meetings';
import type { CalActor, EventRow } from './access';

/**
 * "Crewhall toplantısı ekle" (roadmap 14 follow-up): a timed event may carry a scheduled
 * meeting of the meet module. Meet owns the meeting (room, lobby, recording); the calendar
 * keeps it in step with the event's title and time, and sends its link with the invitation
 * and the .ics. The calendar sends the invitations itself, so meet gets no invitees.
 */

/** The closest meet repetition of an RRULE; anything meet cannot express is a single meeting. */
export function meetRecurrence(
  row: Pick<EventRow, 'rrule' | 'startsAt' | 'timeZone'>,
): MeetingRecurrence {
  if (!row.rrule) return 'none';
  const r = parseRRule(row.rrule);
  if (!r || r.interval !== 1 || r.count !== null || r.until !== null) return 'none';
  if (r.byMonth.length || r.byMonthDay.length || r.bySetPos.length) return 'none';
  const days = r.byDay.map((d) => d.weekday).sort();
  if (r.freq === 'DAILY' && !days.length) return 'daily';
  if (r.freq !== 'WEEKLY') return 'none';
  if (days.join() === '1,2,3,4,5') return 'weekdays';
  const startWeekday = weekdayOfDay(zonedDay(row.startsAt, row.timeZone));
  if (!days.length || (days.length === 1 && days[0] === startWeekday)) return 'weekly';
  return 'none';
}

const durationOf = (row: Pick<EventRow, 'startsAt' | 'endsAt'>) =>
  Math.max(
    5,
    Math.min(24 * 60, Math.round((row.endsAt.getTime() - row.startsAt.getTime()) / 60_000)),
  );

async function spaceOfCalendar(db: DbOrTx, calendarId: string) {
  const [cal] = await db
    .select({ spaceId: calendars.spaceId, kind: calendars.kind })
    .from(calendars)
    .where(eq(calendars.id, calendarId));
  return cal?.kind === 'space' ? cal.spaceId : null;
}

/** The meeting's host acts for the calendar's changes (only moderators may change a meeting). */
async function hostActor(db: DbOrTx, a: CalActor, meetingId: string): Promise<MeetActor | null> {
  const [m] = await db.select().from(meetings).where(eq(meetings.id, meetingId));
  if (!m?.hostUserId) return null;
  if (m.hostUserId === a.userId) return a;
  const [row] = await db
    .select({ member: orgMembers, name: users.name })
    .from(orgMembers)
    .innerJoin(users, eq(users.id, orgMembers.userId))
    .where(and(eq(orgMembers.organizationId, a.org.id), eq(orgMembers.userId, m.hostUserId)));
  if (!row) return null;
  return { org: a.org, actor: toActor(row.member), userId: m.hostUserId, userName: row.name };
}

/** Creates the meeting for an event and links it. */
export async function attachMeeting(deps: Deps, a: CalActor, row: EventRow) {
  if (row.allDay)
    throw new AppError('validation_failed', { field: 'onlineMeeting', reason: 'all_day' });
  if (!(await isModuleEnabled(deps.db, a.org.id, 'meet')))
    throw new AppError('module_disabled', { module: 'meet' });
  const outside = await deps.db
    .select({ id: calendarAttendees.id })
    .from(calendarAttendees)
    .where(and(eq(calendarAttendees.eventId, row.id), isNull(calendarAttendees.userId)));
  const spaceId = await spaceOfCalendar(deps.db, row.calendarId);
  const meeting = await createMeeting(
    deps,
    a,
    {
      mode: 'scheduled',
      title: row.title.slice(0, 120),
      description: row.description?.slice(0, 2000),
      spaceId: spaceId ?? undefined,
      startsAt: row.startsAt.toISOString(),
      durationMinutes: durationOf(row),
      recurrence: meetRecurrence(row),
      invitees: { userIds: [], emails: [] },
      settings: { guestsAllowed: outside.length > 0, lobby: true, autoRecord: false },
    },
    { notify: false },
  );
  await deps.db
    .update(calendarEvents)
    .set({ meetingId: meeting.id })
    .where(eq(calendarEvents.id, row.id));
  return meeting.id;
}

/** Keeps the meeting's title and time with the event's (best effort: the event is the truth). */
export async function syncMeeting(deps: Deps, a: CalActor, row: EventRow) {
  if (!row.meetingId) return;
  try {
    const host = await hostActor(deps.db, a, row.meetingId);
    if (!host) return;
    const outside = await deps.db
      .select({ id: calendarAttendees.id })
      .from(calendarAttendees)
      .where(and(eq(calendarAttendees.eventId, row.id), isNull(calendarAttendees.userId)));
    await updateMeeting(deps, host, row.meetingId, {
      title: row.title.slice(0, 120),
      startsAt: row.startsAt.toISOString(),
      durationMinutes: durationOf(row),
      recurrence: meetRecurrence(row),
      settings: outside.length ? { guestsAllowed: true } : undefined,
    });
  } catch (err) {
    deps.logger.warn({ err, eventId: row.id }, 'calendar meeting sync failed');
  }
}

/** Unlinks and cancels the meeting unless another live event still uses it. */
export async function detachMeeting(deps: Deps, a: CalActor, row: EventRow) {
  if (!row.meetingId) return;
  const meetingId = row.meetingId;
  await deps.db
    .update(calendarEvents)
    .set({ meetingId: null })
    .where(eq(calendarEvents.id, row.id));
  const [other] = await deps.db
    .select({ id: calendarEvents.id })
    .from(calendarEvents)
    .where(
      and(
        eq(calendarEvents.meetingId, meetingId),
        ne(calendarEvents.id, row.id),
        isNull(calendarEvents.deletedAt),
      ),
    );
  if (other) return;
  try {
    const host = await hostActor(deps.db, a, meetingId);
    if (host) await cancelMeeting(deps, host, meetingId);
  } catch (err) {
    deps.logger.warn({ err, eventId: row.id }, 'calendar meeting cancel failed');
  }
}

/** Link facts of the meetings of some events. */
export async function meetingLinks(db: DbOrTx, hubUrl: string, ids: (string | null)[]) {
  const unique = [...new Set(ids.filter((x): x is string => Boolean(x)))];
  const out = new Map<string, { id: string; slug: string; url: string; path: string }>();
  if (!unique.length) return out;
  const rows = await db
    .select({ id: meetings.id, slug: meetings.joinSlug, cancelledAt: meetings.cancelledAt })
    .from(meetings)
    .where(inArray(meetings.id, unique));
  for (const r of rows) {
    if (r.cancelledAt) continue;
    out.set(r.id, {
      id: r.id,
      slug: r.slug,
      url: meetingUrl(hubUrl, r.slug),
      path: paths.meetingRoom(r.slug),
    });
  }
  return out;
}
