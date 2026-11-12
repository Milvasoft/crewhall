import { and, eq, gt, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import {
  calendarAttendees,
  calendarEvents,
  calendarReminderLog,
  calendars,
  type Db,
} from '@crewhall/db';
import { CALENDAR_LIMITS, dateToDay, startOfZonedDay } from '@crewhall/shared';
import type { Jobs } from '../../jobs/queue';
import type { Logger } from '../../logger';
import type { Bus } from '../../realtime/bus';
import { notify, type NotificationInput } from '../notifications/notify';
import { calendarEnabled } from './access';
import { eventUrl } from './notify';
import { emitUpcomingAll } from './automation';
import { expandSeries } from './occurrences';
import { settingsForMany } from './settings';

export interface ReminderDeps {
  db: Db;
  jobs: Jobs;
  logger: Logger;
  bus: Bus;
}

/** A reminder up to this late still goes out (worker restarts, a slow minute). */
export const REMINDER_GRACE_MS = 15 * 60_000;
const DAY_MS = 86_400_000;

/**
 * calendar.reminders (every minute): for each occurrence starting within the longest
 * reminder lead, the organizer (or personal calendar owner) and invitees who did not decline
 * get a notification at start minus each reminder. Timed events use the instant; all-day
 * events the person's own zone at `allDayReminderMinute` of the day (or the days) before.
 * Each (event, person, occurrence, minutes) is sent once (calendar_reminder_log).
 */
export async function sendReminders(deps: ReminderDeps, now = new Date()) {
  const { db } = deps;
  // Space calendars feed the "Etkinlik yaklaştı" automation trigger.
  try {
    await emitUpcomingAll(deps, now, REMINDER_GRACE_MS);
  } catch (err) {
    deps.logger.warn({ err }, 'calendar automation trigger failed');
  }
  const lead = CALENDAR_LIMITS.maxReminderMinutes * 60_000;
  const from = new Date(now.getTime() - REMINDER_GRACE_MS);
  const to = new Date(now.getTime() + lead + DAY_MS);
  const rows = await db
    .select({ event: calendarEvents, cal: calendars })
    .from(calendarEvents)
    .innerJoin(calendars, eq(calendars.id, calendarEvents.calendarId))
    .where(
      and(
        isNull(calendarEvents.parentId),
        isNull(calendarEvents.deletedAt),
        isNull(calendars.deletedAt),
        ne(calendarEvents.status, 'cancelled'),
        lt(calendarEvents.startsAt, to),
        or(isNull(calendarEvents.seriesEndsAt), gt(calendarEvents.seriesEndsAt, from)),
        // Nobody wants anything: no reminders on the event and no default (checked below).
        sql`(${calendarEvents.reminders} is null or cardinality(${calendarEvents.reminders}) > 0)`,
      ),
    )
    .limit(5000);
  if (!rows.length) return 0;
  const byOrg = new Map<string, typeof rows>();
  for (const r of rows) byOrg.set(r.event.orgId, [...(byOrg.get(r.event.orgId) ?? []), r]);

  let sent = 0;
  for (const [orgId, list] of byOrg) {
    if (!(await calendarEnabled(db, orgId))) continue;
    const ids = list.map((r) => r.event.id);
    const attendees = await db
      .select()
      .from(calendarAttendees)
      .where(
        and(
          inArray(calendarAttendees.eventId, ids),
          ne(calendarAttendees.response, 'declined'),
          sql`${calendarAttendees.userId} is not null`,
        ),
      );
    const holders = new Map<string, Set<string>>();
    for (const r of list) {
      const set = new Set<string>();
      const owner = r.cal.kind === 'personal' ? r.cal.ownerId : r.event.organizerId;
      if (owner) set.add(owner);
      for (const x of attendees.filter((y) => y.eventId === r.event.id)) set.add(x.userId!);
      holders.set(r.event.id, set);
    }
    const settings = await settingsForMany(
      db,
      orgId,
      [...holders.values()].flatMap((s) => [...s]),
    );
    // Expand each series only as far as its longest reminder reaches (buckets keep it cheap).
    const BUCKETS = [60, 1440, 10_080, CALENDAR_LIMITS.maxReminderMinutes];
    const byLead = new Map<number, (typeof list)[number]['event'][]>();
    for (const r of list) {
      let lead = 0;
      for (const u of holders.get(r.event.id) ?? []) {
        for (const m of r.event.reminders ?? settings.get(u)?.defaultReminders ?? []) {
          lead = Math.max(lead, m);
        }
      }
      if (r.event.allDay) lead += 2 * 1440;
      const bucket = BUCKETS.find((b) => b >= lead) ?? lead;
      byLead.set(bucket, [...(byLead.get(bucket) ?? []), r.event]);
    }
    const expanded = (
      await Promise.all(
        [...byLead].map(([lead, events]) =>
          expandSeries(db, events, from, new Date(now.getTime() + lead * 60_000 + 60_000)),
        ),
      )
    ).flat();
    const inputs: NotificationInput[] = [];
    for (const e of expanded) {
      for (const userId of holders.get(e.series.id) ?? []) {
        const s = settings.get(userId);
        if (!s) continue;
        const minutes = e.row.reminders ?? s.defaultReminders;
        for (const m of minutes) {
          let fireAt: number;
          if (e.row.allDay) {
            const day = dateToDay(e.start) - Math.ceil(m / 1440);
            fireAt = startOfZonedDay(day, s.timeZone).getTime() + s.allDayReminderMinute * 60_000;
          } else fireAt = Date.parse(e.start) - m * 60_000;
          if (fireAt > now.getTime() || fireAt < now.getTime() - REMINDER_GRACE_MS) continue;
          const [logged] = await db
            .insert(calendarReminderLog)
            .values({ orgId, eventId: e.series.id, userId, occurrence: e.key, minutes: m })
            .onConflictDoNothing()
            .returning();
          if (!logged) continue;
          inputs.push({
            orgId,
            userId,
            type: 'calendar.reminder',
            category: 'meetings',
            actorId: null,
            target: { type: 'event', id: e.series.id },
            data: {
              title: e.row.title,
              start: e.start,
              allDay: e.row.allDay,
              minutes: m,
              location: e.row.location,
            },
            url: eventUrl(e.series.id),
            groupKey: null,
          });
        }
      }
    }
    if (inputs.length) {
      try {
        await notify(deps, inputs);
        sent += inputs.length;
      } catch (err) {
        deps.logger.warn({ err, orgId }, 'calendar reminders failed');
      }
    }
  }
  // The log only needs to outlive the grace window of an occurrence.
  await db
    .delete(calendarReminderLog)
    .where(lt(calendarReminderLog.sentAt, new Date(now.getTime() - 60 * DAY_MS)));
  return sent;
}
