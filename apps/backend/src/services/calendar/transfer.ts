import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { calendarAttendees, calendarEvents, orgMembers, users, type DbOrTx } from '@crewhall/db';
import { formatRRule, parseRRule, type ImportIcsResult } from '@crewhall/shared';
import type { Deps } from '../../deps';
import { AppError } from '../../http/errors';
import {
  loadCalendar,
  requireWrite,
  touchCalendars,
  type CalActor,
  type CalendarAccess,
  type EventRow,
} from './access';
import { computeSeriesEnd, timesOf } from './events';
import { buildIcs, parseIcs, type ParsedEvent } from './ics';
import { announceChange, type Recipient } from './notify';
import { calendarSeries, icsEventsFor } from './resources';
import { settingsFor } from './settings';

/** Wire times of a parsed VEVENT. */
const timesOfParsed = (e: ParsedEvent) =>
  timesOf(
    e.allDay,
    e.allDay ? (e.start as string) : (e.start as Date).toISOString(),
    e.allDay ? (e.end as string) : (e.end as Date).toISOString(),
  );

function columnsOf(e: ParsedEvent) {
  return {
    title: e.title,
    description: e.description,
    location: e.location,
    ...timesOfParsed(e),
    timeZone: e.timeZone,
    status: e.status,
    busy: e.busy,
    visibility: e.visibility,
    reminders: e.reminders,
    extra: Object.keys(e.extra).length ? e.extra : null,
  };
}

async function orgUsersByEmail(db: DbOrTx, orgId: string, emails: string[]) {
  if (!emails.length) return new Map<string, { id: string; name: string }>();
  const rows = await db
    .select({ id: users.id, email: users.email, name: users.name })
    .from(orgMembers)
    .innerJoin(users, eq(users.id, orgMembers.userId))
    .where(
      and(
        eq(orgMembers.organizationId, orgId),
        eq(orgMembers.status, 'active'),
        inArray(sql`lower(${users.email})`, emails),
      ),
    );
  return new Map(rows.map((r) => [r.email.toLowerCase(), { id: r.id, name: r.name }]));
}

export interface UpsertResult {
  series: EventRow;
  created: boolean;
  invited: Recipient[];
}

/**
 * Writes one iCalendar object (a series and its changed occurrences, same UID) into a
 * calendar: new UIDs are created, known ones replaced. Attendees follow the object; answers
 * of people who stay are kept unless the object says otherwise.
 */
export async function upsertObject(
  db: DbOrTx,
  a: CalActor,
  cal: CalendarAccess,
  group: ParsedEvent[],
  opts: { uid?: string } = {},
): Promise<UpsertResult> {
  const masterIn = group.find((e) => e.recurrenceId === null) ?? {
    ...group[0]!,
    recurrenceId: null,
    rrule: null,
  };
  const uid = opts.uid ?? masterIn.uid;
  const overridesIn = group.filter((e) => e.recurrenceId !== null && e !== masterIn);
  const [existing] = await db
    .select()
    .from(calendarEvents)
    .where(
      and(
        eq(calendarEvents.calendarId, cal.calendar.id),
        eq(calendarEvents.uid, uid),
        isNull(calendarEvents.parentId),
        isNull(calendarEvents.deletedAt),
      ),
    );
  const rrule = masterIn.rrule ? formatRRule(parseRRule(masterIn.rrule)!) : null;
  const cols = { ...columnsOf(masterIn), rrule, exdates: masterIn.exdates };
  const seriesEndsAt = computeSeriesEnd(cols);
  let series: EventRow;
  if (existing) {
    const [row] = await db
      .update(calendarEvents)
      .set({
        ...cols,
        seriesEndsAt,
        sequence: Math.max(existing.sequence + 1, masterIn.sequence),
        updatedAt: new Date(),
      })
      .where(eq(calendarEvents.id, existing.id))
      .returning();
    series = row!;
  } else {
    const [row] = await db
      .insert(calendarEvents)
      .values({
        orgId: a.org.id,
        calendarId: cal.calendar.id,
        uid,
        ...cols,
        seriesEndsAt,
        sequence: masterIn.sequence,
        organizerId: a.userId,
        createdBy: a.userId,
      })
      .returning();
    series = row!;
  }
  // Changed occurrences: replaced as a whole.
  await db
    .update(calendarEvents)
    .set({ deletedAt: new Date() })
    .where(and(eq(calendarEvents.parentId, series.id), isNull(calendarEvents.deletedAt)));
  const seen = new Set<string>();
  for (const o of overridesIn) {
    if (!rrule || seen.has(o.recurrenceId!)) continue;
    seen.add(o.recurrenceId!);
    const c = columnsOf(o);
    await db.insert(calendarEvents).values({
      orgId: a.org.id,
      calendarId: cal.calendar.id,
      uid,
      parentId: series.id,
      recurrenceId: o.recurrenceId,
      ...c,
      seriesEndsAt: c.endsAt,
      organizerId: series.organizerId,
      createdBy: a.userId,
    });
  }

  // Attendees: everybody listed except the organizer (ourselves).
  const self = a.userEmail.toLowerCase();
  const wanted = new Map(
    masterIn.attendees
      .filter((x) => x.email !== self && x.email !== masterIn.organizerEmail)
      .map((x) => [x.email, x]),
  );
  const members = await orgUsersByEmail(db, a.org.id, [...wanted.keys()]);
  const current = await db
    .select()
    .from(calendarAttendees)
    .where(eq(calendarAttendees.eventId, series.id));
  const gone = current.filter((x) => !wanted.has(x.email.toLowerCase()));
  if (gone.length) {
    await db.delete(calendarAttendees).where(
      inArray(
        calendarAttendees.id,
        gone.map((x) => x.id),
      ),
    );
  }
  const invited: Recipient[] = [];
  for (const [email, x] of wanted) {
    const m = members.get(email);
    const old = current.find((c) => c.email.toLowerCase() === email);
    if (old) {
      const response = x.partstat !== 'needs_action' ? x.partstat : old.response;
      await db
        .update(calendarAttendees)
        .set({ optional: x.optional, response, name: x.name ?? old.name })
        .where(eq(calendarAttendees.id, old.id));
      continue;
    }
    await db.insert(calendarAttendees).values({
      orgId: a.org.id,
      eventId: series.id,
      userId: m?.id ?? null,
      email,
      name: x.name ?? m?.name ?? null,
      response: x.partstat,
      optional: x.optional,
    });
    invited.push({
      userId: m?.id ?? null,
      email,
      name: x.name ?? m?.name ?? null,
      optional: x.optional,
    });
  }
  return { series, created: !existing, invited };
}

export async function importIcs(
  deps: Deps,
  a: CalActor,
  calendarId: string,
  text: string,
): Promise<ImportIcsResult> {
  const cal = await loadCalendar(deps.db, a, calendarId);
  // A mirrored calendar takes its events from the provider only.
  if (cal.calendar.kind === 'external') {
    throw new AppError('calendar_external_unsupported', { reason: 'import' });
  }
  requireWrite(cal);
  const tz = (await settingsFor(deps.db, a.org.id, a.userId)).timeZone;
  const parsed = parseIcs(text, tz);
  if (!parsed || (!parsed.events.length && !parsed.errors.length)) {
    throw new AppError('calendar_ics_invalid');
  }
  const groups = new Map<string, ParsedEvent[]>();
  for (const e of parsed.events) groups.set(e.uid, [...(groups.get(e.uid) ?? []), e]);
  const result: ImportIcsResult = { created: 0, updated: 0, skipped: 0, errors: parsed.errors };
  for (const [uid, group] of groups) {
    if (group.every((e) => e.status === 'cancelled')) {
      result.skipped++;
      continue;
    }
    try {
      // An import never mails anybody: the events already exist elsewhere.
      const r = await deps.db.transaction((tx) => upsertObject(tx, a, cal, group));
      if (r.created) result.created++;
      else result.updated++;
    } catch (err) {
      deps.logger.warn({ err, uid }, 'ics import failed for one event');
      result.errors.push({ uid, reason: 'write_failed' });
    }
  }
  result.skipped += parsed.errors.length;
  await touchCalendars(deps.db, [cal.calendar.id]);
  return result;
}

/** The whole calendar as one .ics (series, changed occurrences, zones). */
export async function exportIcs(deps: Deps, a: CalActor, calendarId: string) {
  const cal = await loadCalendar(deps.db, a, calendarId);
  const rows = await calendarSeries(deps.db, cal.calendar.id);
  const visible = rows.filter(
    (r) => r.visibility !== 'private' || cal.role === 'owner' || r.organizerId === a.userId,
  );
  const map = await icsEventsFor(deps.db, visible, deps.env.HUB_URL);
  const name = cal.space?.name ?? cal.calendar.name;
  return {
    name,
    ics: buildIcs({ events: [...map.values()].flat(), method: 'PUBLISH', name }),
  };
}

/** After a CalDAV or web write: invitations to the people the object added. */
export async function announceInvited(deps: Deps, a: CalActor, r: UpsertResult) {
  if (r.invited.length) await announceChange(deps, a, r.series, 'invited', r.invited);
}
