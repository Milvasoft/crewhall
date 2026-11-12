import { and, desc, eq, notInArray, or, sql } from 'drizzle-orm';
import {
  calendarEvents,
  calendarEventVersions,
  type CalendarEventVersionData,
  type DbOrTx,
} from '@crewhall/db';
import type { CalendarEventVersion } from '@crewhall/shared';
import { wireTimes } from '../events';
import type { ExtEvent } from './types';
import { wireOf } from './wall';

/**
 * The event's history on mirrored calendars (sonraki-isler): "the last writer wins, the
 * overwritten version stays in the event's history". Two versions can be lost:
 * - `provider`: a Crewhall write found the event changed at the provider (If-Match failed); what
 *   the provider held is saved, then the write goes through.
 * - `crewhall`: a change at the provider replaces what was last written from Crewhall.
 * Changes made only at the provider are not kept: nothing of Crewhall's was lost, and the
 * provider has its own history. The latest few versions per event stay.
 */

const KEEP_PER_EVENT = 20;

type RowFields = Pick<
  typeof calendarEvents.$inferSelect,
  | 'title'
  | 'description'
  | 'location'
  | 'allDay'
  | 'startsAt'
  | 'endsAt'
  | 'startDate'
  | 'endDate'
  | 'external'
>;

export function versionOfRow(row: RowFields): CalendarEventVersionData {
  const { start, end } = wireTimes(row);
  return {
    title: row.title,
    description: row.description,
    location: row.location,
    allDay: row.allDay,
    start,
    end,
    attendees: (row.external?.attendees ?? []).map((a) => ({ email: a.email, name: a.name })),
  };
}

export function versionOfExt(ev: ExtEvent): CalendarEventVersionData {
  return {
    title: ev.title,
    description: ev.description,
    location: ev.location,
    allDay: ev.start.allDay,
    start: wireOf(ev.start),
    end: wireOf(ev.end),
    attendees: ev.data.attendees.map((a) => ({ email: a.email, name: a.name })),
  };
}

/** Same content? People's answers change the provider's version but overwrite nothing. */
export function sameVersion(a: CalendarEventVersionData, b: CalendarEventVersionData) {
  const emails = (v: CalendarEventVersionData) =>
    v.attendees
      .map((x) => x.email.toLowerCase())
      .sort()
      .join();
  return (
    a.title === b.title &&
    (a.description ?? '') === (b.description ?? '') &&
    (a.location ?? '') === (b.location ?? '') &&
    a.allDay === b.allDay &&
    Date.parse(a.start) === Date.parse(b.start) &&
    Date.parse(a.end) === Date.parse(b.end) &&
    emails(a) === emails(b)
  );
}

export async function recordVersion(
  db: DbOrTx,
  input: {
    orgId: string;
    eventId: string;
    source: 'provider' | 'crewhall';
    data: CalendarEventVersionData;
    etag: string | null;
  },
) {
  await db.insert(calendarEventVersions).values(input);
  const keep = await db
    .select({ id: calendarEventVersions.id })
    .from(calendarEventVersions)
    .where(eq(calendarEventVersions.eventId, input.eventId))
    .orderBy(desc(calendarEventVersions.createdAt), desc(calendarEventVersions.id))
    .limit(KEEP_PER_EVENT);
  await db.delete(calendarEventVersions).where(
    and(
      eq(calendarEventVersions.eventId, input.eventId),
      notInArray(
        calendarEventVersions.id,
        keep.map((k) => k.id),
      ),
    ),
  );
}

export async function listVersions(
  db: DbOrTx,
  eventId: string,
): Promise<{ items: CalendarEventVersion[] }> {
  const rows = await db
    .select()
    .from(calendarEventVersions)
    .where(eq(calendarEventVersions.eventId, eventId))
    .orderBy(desc(calendarEventVersions.createdAt), desc(calendarEventVersions.id));
  return {
    items: rows.map((r) => ({
      id: r.id,
      overwritten: r.source,
      replacedAt: r.createdAt.toISOString(),
      ...r.data,
    })),
  };
}

/**
 * Remembers on the rows of a provider event that their current version was written from Crewhall
 * (off before a write, so the sync it triggers does not save our own previous version).
 */
export async function markWritten(
  db: DbOrTx,
  calendarId: string,
  externalId: string,
  written: boolean,
) {
  await db
    .update(calendarEvents)
    .set({
      external: sql`coalesce(${calendarEvents.external}, '{}'::jsonb) || ${JSON.stringify({ writtenHere: written })}::jsonb`,
    })
    .where(
      and(
        eq(calendarEvents.calendarId, calendarId),
        or(
          eq(calendarEvents.externalId, externalId),
          sql`${calendarEvents.external}->>'seriesMasterId' = ${externalId}`,
        ),
      ),
    );
}
