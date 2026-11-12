import { and, eq, inArray, isNull } from 'drizzle-orm';
import { calendarAttendees, calendarEvents, users, type DbOrTx } from '@crewhall/db';
import { buildIcs, type IcsOutEvent } from './ics';
import type { EventRow } from './access';
import { wireTimes } from './events';
import { meetingLinks } from './meeting';

/**
 * One iCalendar resource per series: the series row and its changed occurrences share a UID
 * (CalDAV object, .ics export, invitation mail). The ETag follows the series' updated_at,
 * which every override change and answer also touches.
 */

const PARAGRAPH = String.fromCharCode(10).repeat(2);

export const etagOf = (series: Pick<EventRow, 'id' | 'updatedAt' | 'sequence'>) =>
  `"${series.updatedAt.getTime().toString(36)}-${series.sequence}"`;

export async function icsEventsFor(
  db: DbOrTx,
  seriesRows: EventRow[],
  /** With it, a series' Crewhall meeting link goes into URL and the description. */
  hubUrl?: string,
): Promise<Map<string, IcsOutEvent[]>> {
  const out = new Map<string, IcsOutEvent[]>();
  const links = hubUrl
    ? await meetingLinks(
        db,
        hubUrl,
        seriesRows.map((r) => r.meetingId),
      )
    : new Map<string, { url: string }>();
  if (!seriesRows.length) return out;
  const ids = seriesRows.map((r) => r.id);
  const [overrides, attendees] = await Promise.all([
    db
      .select()
      .from(calendarEvents)
      .where(and(inArray(calendarEvents.parentId, ids), isNull(calendarEvents.deletedAt))),
    db.select().from(calendarAttendees).where(inArray(calendarAttendees.eventId, ids)),
  ]);
  const organizerIds = [
    ...new Set(seriesRows.map((r) => r.organizerId).filter((x): x is string => Boolean(x))),
  ];
  const organizers = organizerIds.length
    ? await db
        .select({ id: users.id, name: users.name, email: users.email })
        .from(users)
        .where(inArray(users.id, organizerIds))
    : [];
  for (const s of seriesRows) {
    const org = organizers.find((o) => o.id === s.organizerId);
    const people = attendees
      .filter((a) => a.eventId === s.id)
      .map((a) => ({
        email: a.email,
        name: a.name,
        partstat: a.response,
        optional: a.optional,
      }));
    const link = s.meetingId ? (links.get(s.meetingId)?.url ?? null) : null;
    const one = (row: EventRow): IcsOutEvent => {
      const t = wireTimes(row);
      return {
        uid: s.uid,
        recurrenceId: row.parentId ? row.recurrenceId : null,
        title: row.title,
        description: link
          ? [row.description, link].filter(Boolean).join(PARAGRAPH)
          : row.description,
        location: row.location ?? link,
        allDay: row.allDay,
        start: row.allDay ? t.start : row.startsAt,
        end: row.allDay ? t.end : row.endsAt,
        timeZone: row.timeZone,
        rrule: row.parentId ? null : row.rrule,
        exdates: row.parentId ? [] : row.exdates,
        status: row.status,
        busy: row.busy,
        visibility: row.visibility,
        sequence: s.sequence,
        reminders: row.reminders ?? [],
        organizer: org && people.length ? { name: org.name, email: org.email } : null,
        attendees: people,
        created: row.createdAt,
        updated: row.updatedAt,
        extra: row.extra,
        url: link,
      };
    };
    out.set(s.id, [one(s), ...overrides.filter((o) => o.parentId === s.id).map(one)]);
  }
  return out;
}

export async function seriesIcs(
  db: DbOrTx,
  series: EventRow,
  method?: 'REQUEST' | 'CANCEL' | 'PUBLISH',
  hubUrl?: string,
): Promise<string> {
  const events = (await icsEventsFor(db, [series], hubUrl)).get(series.id) ?? [];
  return buildIcs({ events, method });
}

/** Live series rows of a calendar (CalDAV listing, export). */
export function calendarSeries(db: DbOrTx, calendarId: string) {
  return db
    .select()
    .from(calendarEvents)
    .where(
      and(
        eq(calendarEvents.calendarId, calendarId),
        isNull(calendarEvents.parentId),
        isNull(calendarEvents.deletedAt),
      ),
    );
}
