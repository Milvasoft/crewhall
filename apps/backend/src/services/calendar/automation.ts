import { and, eq, gt, inArray, isNull, lt, ne, or } from 'drizzle-orm';
import {
  automationRules,
  calendarEvents,
  calendarReminderLog,
  calendars,
  type Db,
} from '@crewhall/db';
import { z } from 'zod';
import type { Jobs } from '../../jobs/queue';
import type { Logger } from '../../logger';
import { emitAutomationEvent } from '../automations/emit';
import { registerTrigger } from '../automations/registry';
import { calendarEnabled, type EventRow } from './access';
import { expandSeries } from './occurrences';
import { paths, withQuery } from '@crewhall/shared';

/**
 * The calendar's automation trigger (roadmap 17 plugin registry): "Etkinlik yaklaştı". Rules
 * belong to a space, so events of that space's calendar fire them; the reminder job emits
 * `calendar.event_upcoming` once per occurrence and lead time (minutesBefore).
 */

export const EVENT_UPCOMING = 'calendar.event_upcoming';

registerTrigger({
  type: EVENT_UPCOMING,
  module: 'calendar',
  config: z.object({ minutesBefore: z.coerce.number().int().min(1).max(10080).default(15) }),
  fields: [{ key: 'minutesBefore', kind: 'number', required: true, options: [], dependsOn: null }],
  variables: [
    'event.title',
    'event.startsAt',
    'event.endsAt',
    'event.allDay',
    'event.location',
    'event.url',
    'calendar.name',
    'minutesBefore',
  ],
  matches: (c, e) => Number(e.match?.minutesBefore) === c.minutesBefore,
  sample: (c) => ({
    event: {
      title: 'Örnek etkinlik',
      startsAt: new Date(Date.now() + c.minutesBefore * 60_000).toISOString(),
      endsAt: new Date(Date.now() + (c.minutesBefore + 30) * 60_000).toISOString(),
      allDay: false,
      location: null,
      url: paths.calendar(),
    },
    calendar: { name: 'Space' },
    minutesBefore: c.minutesBefore,
  }),
});

export interface UpcomingOccurrence {
  row: EventRow;
  series: EventRow;
  key: string;
  start: string;
  end: string;
}

/** Lead times (minutes) of enabled "event upcoming" rules per space. */
export async function upcomingRuleLeads(db: Db, orgId: string) {
  const rules = await db
    .select({ spaceId: automationRules.spaceId, trigger: automationRules.trigger })
    .from(automationRules)
    .where(
      and(
        eq(automationRules.orgId, orgId),
        eq(automationRules.triggerType, EVENT_UPCOMING),
        eq(automationRules.enabled, true),
      ),
    );
  const out = new Map<string, Set<number>>();
  for (const r of rules) {
    const m = Number((r.trigger.config as { minutesBefore?: unknown }).minutesBefore ?? 15);
    if (!Number.isInteger(m) || m < 1) continue;
    out.set(r.spaceId, (out.get(r.spaceId) ?? new Set()).add(m));
  }
  return out;
}

/**
 * Emits `calendar.event_upcoming` for space-calendar occurrences whose start minus a rule's
 * lead time has just passed (within the grace window). Each (occurrence, lead) goes out once:
 * the reminder log row uses the negative lead and the event's creator as its person.
 */
export async function emitUpcoming(
  deps: { db: Db; jobs: Jobs; logger: Logger },
  orgId: string,
  occurrences: UpcomingOccurrence[],
  now: Date,
  graceMs: number,
) {
  const leads = await upcomingRuleLeads(deps.db, orgId);
  if (!leads.size) return 0;
  const calIds = [...new Set(occurrences.map((o) => o.series.calendarId))];
  if (!calIds.length) return 0;
  const spaceCals = await deps.db
    .select({ id: calendars.id, spaceId: calendars.spaceId, name: calendars.name })
    .from(calendars)
    .where(
      and(inArray(calendars.id, calIds), eq(calendars.kind, 'space'), isNull(calendars.deletedAt)),
    );
  let emitted = 0;
  for (const o of occurrences) {
    const cal = spaceCals.find((c) => c.id === o.series.calendarId);
    const minutes = cal?.spaceId ? leads.get(cal.spaceId) : undefined;
    const person = o.series.createdBy ?? o.series.organizerId;
    if (!cal?.spaceId || !minutes || !person) continue;
    const startMs = o.row.allDay ? Date.parse(`${o.start}T00:00:00Z`) : Date.parse(o.start);
    for (const m of minutes) {
      const fireAt = startMs - m * 60_000;
      if (fireAt > now.getTime() || fireAt < now.getTime() - graceMs) continue;
      const [logged] = await deps.db
        .insert(calendarReminderLog)
        .values({ orgId, eventId: o.series.id, userId: person, occurrence: o.key, minutes: -m })
        .onConflictDoNothing()
        .returning();
      if (!logged) continue;
      await emitAutomationEvent(deps, {
        orgId,
        spaceId: cal.spaceId,
        type: EVENT_UPCOMING,
        data: {
          event: {
            title: o.row.title,
            startsAt: o.start,
            endsAt: o.end,
            allDay: o.row.allDay,
            location: o.row.location,
            url: withQuery(paths.calendar(), { event: o.series.id }),
          },
          calendar: { name: cal.name },
          minutesBefore: m,
        },
        match: { minutesBefore: m, calendarId: cal.id },
      });
      emitted++;
    }
  }
  return emitted;
}

/** Every org with "event upcoming" rules: expand their space calendars and emit what is due. */
export async function emitUpcomingAll(
  deps: { db: Db; jobs: Jobs; logger: Logger },
  now: Date,
  graceMs: number,
) {
  const orgs = await deps.db
    .selectDistinct({ orgId: automationRules.orgId, spaceId: automationRules.spaceId })
    .from(automationRules)
    .where(and(eq(automationRules.triggerType, EVENT_UPCOMING), eq(automationRules.enabled, true)));
  const bySpace = new Map<string, string[]>();
  for (const r of orgs) bySpace.set(r.orgId, [...(bySpace.get(r.orgId) ?? []), r.spaceId]);
  let total = 0;
  for (const [orgId, spaceIds] of bySpace) {
    if (!(await calendarEnabled(deps.db, orgId))) continue;
    const leads = await upcomingRuleLeads(deps.db, orgId);
    const maxLead = Math.max(0, ...[...leads.values()].flatMap((s) => [...s]));
    const cals = await deps.db
      .select({ id: calendars.id })
      .from(calendars)
      .where(
        and(
          inArray(calendars.spaceId, spaceIds),
          eq(calendars.kind, 'space'),
          isNull(calendars.deletedAt),
        ),
      );
    if (!cals.length) continue;
    const from = new Date(now.getTime() - graceMs);
    const to = new Date(now.getTime() + maxLead * 60_000 + 2 * 86_400_000);
    const rows = await deps.db
      .select()
      .from(calendarEvents)
      .where(
        and(
          inArray(
            calendarEvents.calendarId,
            cals.map((c) => c.id),
          ),
          isNull(calendarEvents.parentId),
          isNull(calendarEvents.deletedAt),
          ne(calendarEvents.status, 'cancelled'),
          lt(calendarEvents.startsAt, to),
          or(isNull(calendarEvents.seriesEndsAt), gt(calendarEvents.seriesEndsAt, from)),
        ),
      )
      .limit(5000);
    const occurrences = await expandSeries(deps.db, rows, from, to);
    try {
      total += await emitUpcoming(deps, orgId, occurrences, now, graceMs);
    } catch (err) {
      deps.logger.warn({ err, orgId }, 'calendar automation events failed');
    }
  }
  return total;
}
