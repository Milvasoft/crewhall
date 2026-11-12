import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';
import { calendarAccounts, calendarEvents, orgMembers, users, type DbOrTx } from '@crewhall/db';
import {
  addDaysToDate,
  dateToDay,
  formatRRule,
  zonedDay,
  parseRRule,
  type AttendeeResponse,
  type SeriesScope,
} from '@crewhall/shared';
import type { Deps } from '../../../deps';
import { AppError } from '../../../http/errors';
import { requireWrite, type CalActor, type CalendarAccess, type EventRow } from '../access';
import {
  findOccurrence,
  loadEvent,
  toEvent,
  type CreateInput,
  type EventAccess,
  type UpdateInput,
} from '../events';
import { settingsFor } from '../settings';
import { clientFor, type AccountRow } from './accounts';
import { EWS_REFUSED } from './ews/soap';
import { ProviderError } from './http';
import { refreshCalendar } from './sync';
import { markWritten, recordVersion, sameVersion, versionOfExt, versionOfRow } from './versions';
import type { ExtEventInput, ExtTime, ProviderClient } from './types';
import { attachMeeting, detachMeeting, meetingLinks } from '../meeting';

/**
 * Changes to a mirrored calendar go to the provider first; the rows follow from an immediate
 * incremental sync, so Crewhall shows exactly what the provider stored (and the provider sends
 * the invitations).
 */

const unsupported = (reason: string) => new AppError('calendar_external_unsupported', { reason });

async function accountOf(db: DbOrTx, accountId: string | null): Promise<AccountRow> {
  const [row] = accountId
    ? await db.select().from(calendarAccounts).where(eq(calendarAccounts.id, accountId))
    : [];
  if (!row) throw new AppError('not_found');
  if (row.status === 'revoked') throw new AppError('calendar_account_revoked');
  return row;
}

/** Provider refusals become calendar_external_failed (with the provider's reason). */
async function provider<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ProviderError) {
      // Exchange refused the stored sign-in; the next sync says so on the account.
      if (err.reason === EWS_REFUSED) throw new AppError('calendar_account_revoked');
      throw new AppError('calendar_external_failed', { status: err.status, reason: err.reason });
    }
    throw err;
  }
}

/** Org members by id, outsiders by address; answers already known are passed back. */
async function attendeeList(
  db: DbOrTx,
  a: CalActor,
  input: { userIds: string[]; emails: string[]; optionalUserIds?: string[] },
  known: { email: string; response: AttendeeResponse }[],
) {
  const optional = new Set(input.optionalUserIds ?? []);
  const members = input.userIds.length
    ? await db
        .select({ id: users.id, email: users.email })
        .from(orgMembers)
        .innerJoin(users, eq(users.id, orgMembers.userId))
        .where(
          and(
            eq(orgMembers.organizationId, a.org.id),
            eq(orgMembers.status, 'active'),
            inArray(users.id, input.userIds),
          ),
        )
    : [];
  const out = new Map<string, { email: string; optional: boolean }>();
  for (const id of input.userIds) {
    const m = members.find((x) => x.id === id);
    if (!m) throw new AppError('validation_failed', { field: 'attendees.userIds', id });
    out.set(m.email.toLowerCase(), { email: m.email.toLowerCase(), optional: optional.has(id) });
  }
  for (const e of input.emails) {
    const email = e.trim().toLowerCase();
    if (!out.has(email)) out.set(email, { email, optional: false });
  }
  return [...out.values()].map((x) => ({
    ...x,
    response: known.find((k) => k.email === x.email)?.response,
  }));
}

const normRule = (rrule: string | null | undefined) =>
  rrule === undefined ? undefined : rrule ? formatRRule(parseRRule(rrule)!) : null;

/** The fields of an update as the provider takes them. */
async function changesOf(
  db: DbOrTx,
  a: CalActor,
  input: UpdateInput,
  row: EventRow,
): Promise<ExtEventInput> {
  const ext: ExtEventInput = {};
  if (input.title !== undefined) ext.title = input.title;
  if (input.description !== undefined) ext.description = input.description;
  if (input.location !== undefined) ext.location = input.location;
  if (input.start !== undefined && input.end !== undefined) {
    ext.allDay = input.allDay ?? row.allDay;
    ext.start = input.start;
    ext.end = input.end;
    ext.timeZone = input.timeZone ?? row.timeZone;
  }
  if (input.rrule !== undefined) ext.rrule = normRule(input.rrule);
  if (input.busy !== undefined) ext.busy = input.busy;
  if (input.visibility !== undefined) ext.private = input.visibility === 'private';
  if (input.attendees) {
    ext.attendees = await attendeeList(db, a, input.attendees, row.external?.attendees ?? []);
  }
  return ext;
}

/** The row a provider id ended up as after the sync (Microsoft series: its first occurrence). */
async function eventFor(deps: Deps, a: CalActor, calendarId: string, externalId: string) {
  const [row] = await deps.db
    .select({ id: calendarEvents.id })
    .from(calendarEvents)
    .where(
      and(
        eq(calendarEvents.calendarId, calendarId),
        or(
          eq(calendarEvents.externalId, externalId),
          sql`${calendarEvents.external}->>'seriesMasterId' = ${externalId}`,
        ),
      ),
    )
    .orderBy(sql`${calendarEvents.parentId} is not null`, asc(calendarEvents.startsAt))
    .limit(1);
  // Outside the synced window (or not visible to the account): nothing to show yet.
  if (!row) throw new AppError('calendar_external_failed', { reason: 'not_synced' });
  return toEvent(deps, a, await loadEvent(deps.db, a, row.id));
}

/**
 * "Crewhall toplantısı ekle" on a mirrored calendar: the meeting is made for the synced row and
 * its link goes to the provider event (its own line in the notes; the place when it had none),
 * so everyone the provider invites gets it. One-off timed events only.
 */
async function addMeeting(
  deps: Deps,
  a: CalActor,
  client: ProviderClient,
  account: AccountRow,
  cal: CalendarAccess,
  externalId: string,
) {
  const [row] = await deps.db
    .select()
    .from(calendarEvents)
    .where(
      and(
        eq(calendarEvents.calendarId, cal.calendar.id),
        eq(calendarEvents.externalId, externalId),
      ),
    );
  if (!row || row.meetingId) return;
  const meetingId = await attachMeeting(deps, a, row);
  const link = (await meetingLinks(deps.db, deps.env.HUB_URL, [meetingId])).get(meetingId);
  if (!link) return;
  await provider(() =>
    client.updateEvent(cal.calendar.externalId!, externalId, {
      description: row.description ? `${row.description}\n\n${link.url}` : link.url,
      ...(row.location ? {} : { location: link.url }),
    }),
  );
  await provider(() => refreshCalendar(deps, account, cal.calendar.id));
}

/** Switching the meeting off: it is cancelled and its link leaves the provider event. */
async function removeMeeting(
  deps: Deps,
  a: CalActor,
  client: ProviderClient,
  account: AccountRow,
  cal: CalendarAccess,
  row: EventRow,
) {
  const link = (await meetingLinks(deps.db, deps.env.HUB_URL, [row.meetingId])).get(row.meetingId!);
  await detachMeeting(deps, a, row);
  if (!link || !row.externalId) return;
  const description = (row.description ?? '')
    .split('\n')
    .filter((l) => !l.includes(link.url))
    .join('\n')
    .trim();
  await provider(() =>
    client.updateEvent(cal.calendar.externalId!, row.externalId!, {
      description: description || null,
      ...(row.location === link.url ? { location: null } : {}),
    }),
  );
  await provider(() => refreshCalendar(deps, account, cal.calendar.id));
}

/**
 * Writes on the condition that the event is still the version we know. If someone changed it at
 * the provider in the meantime, the last writer still wins, but what the provider held goes to
 * the event's history first (unless only people's answers differ).
 */
async function lastWriterWins(
  deps: Deps,
  client: ProviderClient,
  calendarId: string,
  externalId: string,
  ext: ExtEventInput,
  known: EventRow | null,
) {
  if (!known?.externalEtag) return client.updateEvent(calendarId, externalId, ext);
  try {
    return await client.updateEvent(calendarId, externalId, ext, { ifMatch: known.externalEtag });
  } catch (err) {
    if (!(err instanceof ProviderError) || err.status !== 412) throw err;
  }
  const theirs = await client.getEvent(calendarId, externalId);
  if (theirs) {
    const data = versionOfExt(theirs);
    if (!sameVersion(data, versionOfRow(known))) {
      await recordVersion(deps.db, {
        orgId: known.orgId,
        eventId: known.id,
        source: 'provider',
        data,
        etag: theirs.etag,
      });
    }
  }
  return client.updateEvent(calendarId, externalId, ext);
}

const startOf = (allDay: boolean, wire: string): ExtTime =>
  allDay ? { allDay: true, date: wire.slice(0, 10) } : { allDay: false, at: new Date(wire) };

export async function createExternalEvent(
  deps: Deps,
  a: CalActor,
  cal: CalendarAccess,
  input: CreateInput,
) {
  requireWrite(cal);
  if (input.onlineMeeting && (input.allDay || input.rrule)) throw unsupported('online_meeting');
  const account = await accountOf(deps.db, cal.calendar.accountId);
  const settings = await settingsFor(deps.db, a.org.id, a.userId);
  const ext: ExtEventInput = {
    title: input.title,
    description: input.description ?? null,
    location: input.location ?? null,
    allDay: input.allDay,
    start: input.start,
    end: input.end,
    timeZone: input.timeZone ?? settings.timeZone,
    rrule: normRule(input.rrule ?? null),
    busy: input.busy ?? true,
    private: input.visibility === 'private',
    attendees: input.attendees ? await attendeeList(deps.db, a, input.attendees, []) : undefined,
  };
  const client = clientFor(deps, account);
  const id = await provider(() => client.createEvent(cal.calendar.externalId!, ext));
  await provider(() => refreshCalendar(deps, account, cal.calendar.id));
  if (input.onlineMeeting) await addMeeting(deps, a, client, account, cal, id);
  await markWritten(deps.db, cal.calendar.id, id, true);
  return eventFor(deps, a, cal.calendar.id, id);
}

export async function updateExternalEvent(
  deps: Deps,
  a: CalActor,
  acc: EventAccess,
  input: UpdateInput,
) {
  const cal = acc.calendar!;
  requireWrite(cal);
  if (acc.row.external?.readOnly) throw new AppError('calendar_read_only');
  if (input.calendarId && input.calendarId !== acc.row.calendarId) throw unsupported('move');
  const meetingChange =
    input.onlineMeeting === undefined || input.onlineMeeting === Boolean(acc.series.meetingId)
      ? null
      : input.onlineMeeting;
  if (
    meetingChange &&
    (acc.series.rrule || acc.row.external?.seriesMasterId || (input.allDay ?? acc.row.allDay))
  ) {
    throw unsupported('online_meeting');
  }
  const account = await accountOf(deps.db, cal.calendar.accountId);
  const client = clientFor(deps, account);
  const calId = cal.calendar.externalId!;
  const { row, series } = acc;
  const scope: SeriesScope = input.scope;
  const ext = await changesOf(deps.db, a, input, row);
  let target = row.externalId!;

  if (account.provider === 'google' && series.rrule) {
    if (scope === 'following') throw unsupported('following');
    if (scope === 'all') {
      target = series.externalId!;
      if (row.parentId) {
        // "All events" from a changed occurrence: its own times stay with it.
        delete ext.start;
        delete ext.end;
        delete ext.allDay;
      } else if (ext.start && ext.end && input.recurrenceId) {
        // A dragged occurrence moves the whole series by the same difference.
        const occ = findOccurrence(series, input.recurrenceId);
        if (occ) {
          if (series.allDay) {
            const shift = dateToDay(ext.start) - dateToDay(occ.start);
            const length = dateToDay(ext.end) - dateToDay(ext.start);
            ext.start = addDaysToDate(series.startDate!, shift);
            ext.end = addDaysToDate(ext.start, length);
          } else {
            const shift = Date.parse(ext.start) - Date.parse(occ.start);
            const length = Date.parse(ext.end) - Date.parse(ext.start);
            const start = series.startsAt.getTime() + shift;
            ext.start = new Date(start).toISOString();
            ext.end = new Date(start + length).toISOString();
          }
        }
      }
      if (ext.rrule !== undefined) ext.exdates = series.exdates;
    } else if (!row.parentId) {
      // One occurrence: Google keeps it as an exception of the series.
      const occ = input.recurrenceId ? findOccurrence(series, input.recurrenceId) : null;
      if (!occ) throw new AppError('calendar_occurrence_unknown');
      const id = await provider(() =>
        client.occurrenceId(calId, series.externalId!, startOf(series.allDay, occ.start)),
      );
      if (!id) throw new AppError('calendar_occurrence_unknown');
      target = id;
      delete ext.rrule;
    } else {
      delete ext.rrule;
    }
  } else if (scope === 'following' && row.external?.seriesMasterId) {
    throw unsupported('following');
  } else if (scope === 'all' && row.external?.seriesMasterId) {
    // Microsoft "all events": the change goes to the series master; a moved occurrence moves
    // the whole series by the same amount.
    target = row.external.seriesMasterId;
    if (ext.start && ext.end) {
      if ((ext.allDay ?? row.allDay) !== row.allDay) throw unsupported('series_all_day');
      const tz = row.timeZone;
      if (row.allDay) {
        const days = dateToDay(ext.start) - dateToDay(row.startDate!);
        ext.seriesShift = {
          ms: days * 86_400_000,
          days,
          lengthMs: (dateToDay(ext.end) - dateToDay(ext.start)) * 86_400_000,
        };
      } else {
        const start = Date.parse(ext.start);
        ext.seriesShift = {
          ms: start - row.startsAt.getTime(),
          days: zonedDay(start, tz) - zonedDay(row.startsAt, tz),
          lengthMs: Date.parse(ext.end) - start,
        };
      }
      delete ext.start;
      delete ext.end;
      delete ext.allDay;
      ext.timeZone = tz;
    }
  }

  // The version we know of this event, when the change goes to that very event.
  const known = target === row.externalId ? row : target === series.externalId ? series : null;
  await markWritten(deps.db, cal.calendar.id, target, false);
  const id = await provider(() => lastWriterWins(deps, client, calId, target, ext, known));
  await provider(() => refreshCalendar(deps, account, cal.calendar.id));
  if (meetingChange === true) await addMeeting(deps, a, client, account, cal, id);
  if (meetingChange === false) {
    const [fresh] = await deps.db
      .select()
      .from(calendarEvents)
      .where(eq(calendarEvents.id, row.id));
    if (fresh?.meetingId) await removeMeeting(deps, a, client, account, cal, fresh);
  }
  await markWritten(deps.db, cal.calendar.id, id, true);
  return eventFor(deps, a, cal.calendar.id, id);
}

export async function deleteExternalEvent(
  deps: Deps,
  acc: EventAccess,
  q: { scope: SeriesScope; recurrenceId?: string },
) {
  const cal = acc.calendar!;
  requireWrite(cal);
  if (acc.row.external?.readOnly) throw new AppError('calendar_read_only');
  const account = await accountOf(deps.db, cal.calendar.accountId);
  const client = clientFor(deps, account);
  const calId = cal.calendar.externalId!;
  const { row, series } = acc;
  let target = row.externalId!;
  if (account.provider === 'google' && series.rrule) {
    if (q.scope === 'following') throw unsupported('following');
    if (q.scope === 'all' && (!row.parentId || !q.recurrenceId)) {
      target = series.externalId!;
    } else if (!row.parentId) {
      const occ = q.recurrenceId ? findOccurrence(series, q.recurrenceId) : null;
      if (!occ) throw new AppError('calendar_occurrence_unknown');
      const id = await provider(() =>
        client.occurrenceId(calId, series.externalId!, startOf(series.allDay, occ.start)),
      );
      if (!id) throw new AppError('calendar_occurrence_unknown');
      target = id;
    }
  } else if (q.scope === 'following' && row.external?.seriesMasterId) {
    throw unsupported('following');
  }
  await provider(() => client.deleteEvent(calId, target));
  await provider(() => refreshCalendar(deps, account, cal.calendar.id));
}

export async function respondExternalEvent(
  deps: Deps,
  a: CalActor,
  acc: EventAccess,
  response: Exclude<AttendeeResponse, 'needs_action'>,
) {
  const cal = acc.calendar!;
  const data = acc.series.external;
  if (!data?.attendees.some((x) => x.self) || data.organizer?.self) {
    throw new AppError('forbidden', { reason: 'not_invited' });
  }
  const account = await accountOf(deps.db, cal.calendar.accountId);
  // The answer covers the series: Google's series row, Microsoft's series master.
  const target =
    account.provider === 'google'
      ? acc.series.externalId!
      : (data.seriesMasterId ?? acc.row.externalId!);
  await provider(() =>
    clientFor(deps, account).respond(cal.calendar.externalId!, target, response),
  );
  await provider(() => refreshCalendar(deps, account, cal.calendar.id));
  return eventFor(deps, a, cal.calendar.id, acc.row.externalId!);
}
