import { createHash, randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import {
  calendarAccounts,
  calendarAttendees,
  calendarEvents,
  calendars,
  orgMembers,
  users,
  type DbOrTx,
} from '@crewhall/db';
import {
  canCalendar,
  civilFromDay,
  dateToDay,
  dayNumber,
  dayToDate,
  expandRRule,
  formatRRule,
  occurrenceKey,
  parseRRule,
  safeZone,
  seriesEnd,
  utcMidnight,
  zonedParts,
  zonedToUtc,
  type AttendeeResponse,
  type CalendarEvent,
  type SeriesScope,
  type SpaceColor,
} from '@crewhall/shared';
import type { z } from 'zod';
import type {
  CreateCalendarEvent as CreateSchema,
  UpdateCalendarEvent as UpdateSchema,
} from '@crewhall/shared';
import type { Deps } from '../../deps';
import { AppError } from '../../http/errors';
import {
  loadCalendar,
  permKind,
  rolesFor,
  requireWrite,
  wireKind,
  touchCalendars,
  usersByIds,
  type AttendeeRow,
  type CalActor,
  type CalendarAccess,
  type EventRow,
} from './access';
import { announceChange, type ChangeKind } from './notify';
import { attachMeeting, detachMeeting, meetingLinks, syncMeeting } from './meeting';
import { settingsFor } from './settings';
import { cancelEventBookings, eventRooms, syncEventRoom } from './bookings';
import {
  createExternalEvent,
  deleteExternalEvent,
  respondExternalEvent,
  updateExternalEvent,
} from './external/writes';

export type CreateInput = z.output<typeof CreateSchema>;
export type UpdateInput = z.output<typeof UpdateSchema>;

const DAY_MS = 86_400_000;

// ---- times --------------------------------------------------------------------------------------

export interface EventTimes {
  allDay: boolean;
  startsAt: Date;
  endsAt: Date;
  startDate: string | null;
  endDate: string | null;
}

export function timesOf(allDay: boolean, start: string, end: string): EventTimes {
  if (allDay) {
    return {
      allDay,
      startsAt: utcMidnight(start),
      endsAt: utcMidnight(end),
      startDate: start,
      endDate: end,
    };
  }
  return {
    allDay,
    startsAt: new Date(start),
    endsAt: new Date(end),
    startDate: null,
    endDate: null,
  };
}

/** Wire start/end of a row. */
export function wireTimes(
  row: Pick<EventRow, 'allDay' | 'startsAt' | 'endsAt' | 'startDate' | 'endDate'>,
) {
  return row.allDay
    ? { start: row.startDate!, end: row.endDate! }
    : { start: row.startsAt.toISOString(), end: row.endsAt.toISOString() };
}

/** Length of an event: days for all-day rows, milliseconds otherwise. */
export function durationOf(
  row: Pick<EventRow, 'allDay' | 'startsAt' | 'endsAt' | 'startDate' | 'endDate'>,
) {
  return row.allDay
    ? dateToDay(row.endDate!) - dateToDay(row.startDate!)
    : row.endsAt.getTime() - row.startsAt.getTime();
}

export function computeSeriesEnd(
  row: Pick<
    EventRow,
    'allDay' | 'startsAt' | 'endsAt' | 'startDate' | 'endDate' | 'timeZone' | 'rrule'
  >,
): Date | null {
  if (!row.rrule) return row.endsAt;
  const rule = parseRRule(row.rrule);
  if (!rule) return row.endsAt;
  return seriesEnd({
    rule,
    allDay: row.allDay,
    start: row.allDay ? row.startDate! : row.startsAt,
    timeZone: row.timeZone,
    duration: durationOf(row),
  });
}

/** Occurrences of a series row overlapping [from, to) (no overrides applied). */
export function expandRow(
  row: EventRow,
  from: Date,
  to: Date,
  skip: ReadonlySet<string> = new Set(row.exdates),
  limit?: number,
) {
  const w = wireTimes(row);
  if (!row.rrule) {
    const key = occurrenceKey(row.allDay ? row.startDate! : row.startsAt, row.allDay);
    const overlaps = row.allDay
      ? row.startsAt.getTime() < to.getTime() + DAY_MS &&
        row.endsAt.getTime() > from.getTime() - DAY_MS
      : row.startsAt < to && row.endsAt > from;
    return overlaps ? [{ key, start: w.start, end: w.end }] : [];
  }
  const rule = parseRRule(row.rrule);
  if (!rule) return [];
  return expandRRule({
    rule,
    allDay: row.allDay,
    start: row.allDay ? row.startDate! : row.startsAt,
    timeZone: row.timeZone,
    duration: durationOf(row),
    from,
    to,
    exdates: skip,
    limit,
  }).map((o) => ({
    key: o.key,
    start: typeof o.start === 'string' ? o.start : o.start.toISOString(),
    end: typeof o.end === 'string' ? o.end : o.end.toISOString(),
  }));
}

/** The occurrence of a series named by its key, if the rule produces it. */
export function findOccurrence(row: EventRow, key: string) {
  const at = row.allDay ? utcMidnight(key.slice(0, 10)) : new Date(key);
  if (Number.isNaN(at.getTime())) return null;
  const from = new Date(at.getTime() - 2 * DAY_MS);
  const to = new Date(at.getTime() + 2 * DAY_MS + (row.allDay ? 0 : durationOf(row)));
  return expandRow(row, from, to, new Set(), 50).find((o) => o.key === key) ?? null;
}

/** Shifts a start by the wall-clock difference between two instants in a zone. */
function shiftWallClock(base: Date, fromAt: Date, toAt: Date, tz: string): Date {
  const a = zonedParts(fromAt, tz);
  const b = zonedParts(toAt, tz);
  const days = dayNumber(b.year, b.month, b.day) - dayNumber(a.year, a.month, a.day);
  const minutes = b.hour * 60 + b.minute - (a.hour * 60 + a.minute);
  const p = zonedParts(base, tz);
  const total = p.hour * 60 + p.minute + minutes;
  const day = dayNumber(p.year, p.month, p.day) + days + Math.floor(total / 1440);
  const m = ((total % 1440) + 1440) % 1440;
  return zonedToUtc(
    { ...civilFromDay(day), hour: Math.floor(m / 60), minute: m % 60, second: p.second },
    tz,
  );
}

// ---- access ---------------------------------------------------------------------------------------

export interface EventAccess {
  row: EventRow;
  /** The series (the row itself unless it is a changed occurrence). */
  series: EventRow;
  calendar: CalendarAccess | null;
  attendee: AttendeeRow | null;
  canEdit: boolean;
  /** Private event seen only as busy. */
  hidden: boolean;
}

export async function eventAccessFor(
  db: DbOrTx,
  a: CalActor,
  rows: EventRow[],
  seriesById: Map<string, EventRow>,
): Promise<Map<string, EventAccess>> {
  const calIds = [...new Set(rows.map((r) => r.calendarId))];
  const calRows = calIds.length
    ? await db.select().from(calendars).where(inArray(calendars.id, calIds))
    : [];
  const roles = await rolesFor(db, a, calRows);
  const seriesIds = [...new Set(rows.map((r) => r.parentId ?? r.id))];
  const mine = seriesIds.length
    ? await db
        .select()
        .from(calendarAttendees)
        .where(
          and(
            inArray(calendarAttendees.eventId, seriesIds),
            eq(calendarAttendees.userId, a.userId),
          ),
        )
    : [];
  const out = new Map<string, EventAccess>();
  for (const row of rows) {
    const series = row.parentId ? (seriesById.get(row.parentId) ?? row) : row;
    const cal = roles.get(row.calendarId) ?? null;
    const role = cal?.role ?? null;
    const attendee = mine.find((m) => m.eventId === series.id) ?? null;
    if (role === null && !attendee) continue;
    // Rows of a mirrored series we cannot express stay read-only (they change at the provider).
    const canEdit =
      canCalendar('write', { role, kind: permKind(cal?.calendar.kind ?? 'personal') }) &&
      !row.external?.readOnly;
    const own = series.organizerId === a.userId || attendee !== null || role === 'owner';
    out.set(row.id, {
      row,
      series,
      calendar: cal,
      attendee,
      canEdit,
      hidden: series.visibility === 'private' && !own,
    });
  }
  return out;
}

/** An event the caller can see (calendar reader or attendee); 404 otherwise. */
export async function loadEvent(db: DbOrTx, a: CalActor, eventId: string) {
  const [row] = await db
    .select()
    .from(calendarEvents)
    .where(
      and(
        eq(calendarEvents.id, eventId),
        eq(calendarEvents.orgId, a.org.id),
        isNull(calendarEvents.deletedAt),
      ),
    );
  if (!row) throw new AppError('not_found');
  const seriesById = new Map<string, EventRow>();
  if (row.parentId) {
    const [parent] = await db
      .select()
      .from(calendarEvents)
      .where(and(eq(calendarEvents.id, row.parentId), isNull(calendarEvents.deletedAt)));
    if (!parent) throw new AppError('not_found');
    seriesById.set(parent.id, parent);
  }
  const access = (await eventAccessFor(db, a, [row], seriesById)).get(row.id);
  if (!access || access.hidden) throw new AppError('not_found');
  return access;
}

// ---- output ---------------------------------------------------------------------------------------

export async function toEvent(
  deps: Pick<Deps, 'db' | 'env'>,
  a: CalActor,
  acc: EventAccess,
  occurrence?: { key: string; start: string; end: string },
): Promise<CalendarEvent> {
  const { db } = deps;
  const { row, series } = acc;
  const meeting = series.meetingId
    ? ((await meetingLinks(db, deps.env.HUB_URL, [series.meetingId])).get(series.meetingId) ?? null)
    : null;
  const attendees = await db
    .select()
    .from(calendarAttendees)
    .where(eq(calendarAttendees.eventId, series.id))
    .orderBy(calendarAttendees.createdAt);
  const people = await usersByIds(db, [series.organizerId, ...attendees.map((x) => x.userId)]);
  const room = row.parentId ? null : ((await eventRooms(db, [row.id])).get(row.id) ?? null);
  const cal = acc.calendar;
  const calRef = cal
    ? {
        id: cal.calendar.id,
        name: cal.space?.name ?? cal.calendar.name,
        color: (cal.space?.color ?? cal.calendar.color) as SpaceColor,
        kind: wireKind(cal.calendar.kind),
      }
    : { id: row.calendarId, name: '', color: 's1' as SpaceColor, kind: 'personal' as const };
  const ext = cal?.calendar.kind === 'external' ? series.external : null;
  const self = ext?.attendees.find((x) => x.self) ?? null;
  const provider =
    ext && cal?.calendar.accountId
      ? ((
          await db
            .select({ provider: calendarAccounts.provider })
            .from(calendarAccounts)
            .where(eq(calendarAccounts.id, cal.calendar.accountId))
        )[0]?.provider ?? null)
      : null;
  const times = occurrence ?? wireTimes(row);
  const isOrganizer = series.organizerId === a.userId;
  const settings = await settingsFor(db, a.org.id, a.userId);
  return {
    id: row.id,
    uid: row.uid,
    calendar: calRef,
    title: row.title,
    description: row.description,
    location: row.location,
    allDay: row.allDay,
    start: times.start,
    end: times.end,
    timeZone: row.timeZone,
    rrule: row.parentId ? null : row.rrule,
    exdates: row.parentId ? [] : row.exdates,
    seriesId: row.parentId ?? (occurrence && row.rrule ? row.id : null),
    recurrenceId: row.recurrenceId ?? (occurrence && row.rrule ? occurrence.key : null),
    status: row.status,
    busy: row.busy,
    visibility: row.visibility,
    // Connected calendars remind through their own app; Crewhall adds none.
    reminders: ext ? [] : (row.reminders ?? settings.defaultReminders),
    organizer: series.organizerId ? (people.get(series.organizerId) ?? null) : null,
    attendees: ext
      ? ext.attendees.map((x) => ({
          id: pseudoId(`${series.id}:${x.email}`),
          user: null,
          email: x.email,
          name: x.name,
          response: x.response,
          optional: x.optional,
        }))
      : attendees.map((x) => ({
          id: x.id,
          user: x.userId ? (people.get(x.userId) ?? null) : null,
          email: x.email,
          name: x.userId ? (people.get(x.userId)?.name ?? x.name) : x.name,
          response: x.response,
          optional: x.optional,
        })),
    myResponse: ext ? (self?.response ?? null) : (acc.attendee?.response ?? null),
    meeting: meeting ? { id: meeting.id, slug: meeting.slug, url: meeting.url } : null,
    room,
    permissions: {
      edit: acc.canEdit,
      delete: acc.canEdit,
      respond: ext ? self !== null && !ext.organizer?.self : acc.attendee !== null && !isOrganizer,
    },
    external:
      ext && provider
        ? {
            provider,
            joinUrl: ext.joinUrl,
            webUrl: ext.webUrl,
            organizer: ext.organizer
              ? { email: ext.organizer.email, name: ext.organizer.name }
              : null,
            occurrenceOnly: Boolean(row.external?.seriesMasterId),
            readOnly: Boolean(row.external?.readOnly),
          }
        : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function getEvent(deps: Deps, a: CalActor, eventId: string, recurrenceId?: string) {
  const acc = await loadEvent(deps.db, a, eventId);
  if (!recurrenceId || acc.row.parentId || !acc.row.rrule) return toEvent(deps, a, acc);
  const [override] = await deps.db
    .select()
    .from(calendarEvents)
    .where(
      and(
        eq(calendarEvents.parentId, acc.row.id),
        eq(calendarEvents.recurrenceId, recurrenceId),
        isNull(calendarEvents.deletedAt),
      ),
    );
  if (override) return toEvent(deps, a, { ...acc, row: override });
  const occ = findOccurrence(acc.row, recurrenceId);
  if (!occ) throw new AppError('calendar_occurrence_unknown');
  return toEvent(deps, a, acc, occ);
}

// ---- attendees ------------------------------------------------------------------------------------

interface AttendeeSpec {
  userId: string | null;
  email: string;
  name: string | null;
  optional: boolean;
}

/** Org members by id, outsiders by address; an address of a member becomes that member. */
async function resolveAttendees(
  db: DbOrTx,
  a: CalActor,
  input: { userIds: string[]; emails: string[]; optionalUserIds?: string[] },
): Promise<AttendeeSpec[]> {
  const optional = new Set(input.optionalUserIds ?? []);
  const emails = [...new Set(input.emails.map((e) => e.trim().toLowerCase()))];
  const conds: SQL[] = [];
  if (input.userIds.length) conds.push(inArray(users.id, input.userIds));
  if (emails.length) conds.push(inArray(sql`lower(${users.email})`, emails));
  if (!conds.length) return [];
  const members = await db
    .select({ id: users.id, email: users.email, name: users.name })
    .from(orgMembers)
    .innerJoin(users, eq(users.id, orgMembers.userId))
    .where(
      and(eq(orgMembers.organizationId, a.org.id), eq(orgMembers.status, 'active'), or(...conds)),
    );
  const byId = new Map(members.map((m) => [m.id, m]));
  const byEmail = new Map(members.map((m) => [m.email.toLowerCase(), m]));
  const out = new Map<string, AttendeeSpec>();
  for (const id of input.userIds) {
    const m = byId.get(id);
    if (!m) throw new AppError('validation_failed', { field: 'attendees.userIds', id });
    out.set(m.email.toLowerCase(), {
      userId: m.id,
      email: m.email.toLowerCase(),
      name: m.name,
      optional: optional.has(m.id),
    });
  }
  for (const e of emails) {
    if (out.has(e)) continue;
    const m = byEmail.get(e);
    out.set(e, {
      userId: m?.id ?? null,
      email: e,
      name: m?.name ?? null,
      optional: m ? optional.has(m.id) : false,
    });
  }
  // The organizer is not an invitee of their own event.
  out.delete(a.userEmail.toLowerCase());
  return [...out.values()];
}

/** Replaces the invitee list, keeping the answers of people who stay. Returns the new ones. */
async function setAttendees(db: DbOrTx, orgId: string, eventId: string, list: AttendeeSpec[]) {
  const existing = await db
    .select()
    .from(calendarAttendees)
    .where(eq(calendarAttendees.eventId, eventId));
  const keep = new Set(list.map((x) => x.email));
  const removed = existing.filter((x) => !keep.has(x.email.toLowerCase()));
  if (removed.length) {
    await db.delete(calendarAttendees).where(
      inArray(
        calendarAttendees.id,
        removed.map((x) => x.id),
      ),
    );
  }
  const known = new Map(existing.map((x) => [x.email.toLowerCase(), x]));
  const added: AttendeeSpec[] = [];
  for (const spec of list) {
    const old = known.get(spec.email);
    if (old) {
      if (old.optional !== spec.optional || old.userId !== spec.userId) {
        await db
          .update(calendarAttendees)
          .set({ optional: spec.optional, userId: spec.userId })
          .where(eq(calendarAttendees.id, old.id));
      }
      continue;
    }
    added.push(spec);
  }
  if (added.length) {
    await db.insert(calendarAttendees).values(
      added.map((x) => ({
        orgId,
        eventId,
        userId: x.userId,
        email: x.email,
        name: x.name,
        optional: x.optional,
      })),
    );
  }
  return { added, removed };
}

// ---- create ---------------------------------------------------------------------------------------

export function newUid(hubUrl: string) {
  return `${randomUUID()}@${new URL(hubUrl).host}`;
}

/** A uuid-shaped stable id (v5 layout) for things without a row, e.g. a mirrored invitee. */
function pseudoId(seed: string) {
  const h = createHash('sha1').update(seed).digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

export async function createEvent(deps: Deps, a: CalActor, input: CreateInput) {
  const cal = await loadCalendar(deps.db, a, input.calendarId);
  if (cal.calendar.kind === 'external') {
    if (input.roomId) throw new AppError('booking_room_unsupported');
    return createExternalEvent(deps, a, cal, input);
  }
  requireWrite(cal);
  const settings = await settingsFor(deps.db, a.org.id, a.userId);
  const timeZone = safeZone(input.timeZone ?? settings.timeZone);
  const times = timesOf(input.allDay, input.start, input.end);
  const rrule = input.rrule ? formatRRule(parseRRule(input.rrule)!) : null;
  const specs = input.attendees ? await resolveAttendees(deps.db, a, input.attendees) : [];

  const row = await deps.db.transaction(async (tx) => {
    const base = {
      orgId: a.org.id,
      calendarId: cal.calendar.id,
      uid: newUid(deps.env.HUB_URL),
      title: input.title,
      description: input.description ?? null,
      location: input.location ?? null,
      ...times,
      timeZone,
      rrule,
      status: input.status ?? ('confirmed' as const),
      busy: input.busy ?? true,
      visibility: input.visibility ?? ('default' as const),
      reminders: input.reminders ?? null,
      organizerId: a.userId,
      createdBy: a.userId,
    };
    const [created] = await tx
      .insert(calendarEvents)
      .values({ ...base, seriesEndsAt: computeSeriesEnd(base) })
      .returning();
    if (specs.length) await setAttendees(tx, a.org.id, created!.id, specs);
    if (input.roomId) {
      await syncEventRoom(tx, a, created!, input.roomId);
      // The room may have become the event's place.
      const [withRoom] = await tx
        .select()
        .from(calendarEvents)
        .where(eq(calendarEvents.id, created!.id));
      await touchCalendars(tx, [cal.calendar.id]);
      return withRoom!;
    }
    await touchCalendars(tx, [cal.calendar.id]);
    return created!;
  });
  let created = row;
  if (input.onlineMeeting) {
    const meetingId = await attachMeeting(deps, a, row);
    created = { ...row, meetingId };
  }
  if (specs.length) await announceChange(deps, a, created, 'invited', specs);
  const acc = (await eventAccessFor(deps.db, a, [created], new Map())).get(row.id)!;
  return toEvent(deps, a, acc);
}

// ---- update ---------------------------------------------------------------------------------------

const MATTERS: (keyof UpdateInput)[] = ['title', 'location', 'start', 'end', 'allDay', 'rrule'];

function fieldsOf(input: UpdateInput) {
  const f: Partial<typeof calendarEvents.$inferInsert> = {};
  if (input.title !== undefined) f.title = input.title;
  if (input.description !== undefined) f.description = input.description;
  if (input.location !== undefined) f.location = input.location;
  if (input.status !== undefined) f.status = input.status;
  if (input.busy !== undefined) f.busy = input.busy;
  if (input.visibility !== undefined) f.visibility = input.visibility;
  if (input.reminders !== undefined) f.reminders = input.reminders;
  if (input.timeZone !== undefined) f.timeZone = input.timeZone;
  return f;
}

async function loadSeries(db: DbOrTx, row: EventRow) {
  if (!row.parentId) return row;
  const [parent] = await db
    .select()
    .from(calendarEvents)
    .where(eq(calendarEvents.id, row.parentId));
  if (!parent) throw new AppError('not_found');
  return parent;
}

async function overridesOf(db: DbOrTx, seriesId: string) {
  return db
    .select()
    .from(calendarEvents)
    .where(and(eq(calendarEvents.parentId, seriesId), isNull(calendarEvents.deletedAt)));
}

/** Is occurrence `a` at or after `b` (keys of the same series)? */
const atOrAfter = (keyA: string, keyB: string, allDay: boolean) =>
  allDay ? keyA.slice(0, 10) >= keyB.slice(0, 10) : Date.parse(keyA) >= Date.parse(keyB);

/**
 * Ends a series just before an occurrence: UNTIL the moment before it (COUNT becomes the
 * number of occurrences before it). Returns the rule left for the rest of the series.
 */
function truncateRule(series: EventRow, key: string) {
  const rule = parseRRule(series.rrule!)!;
  const restRule = { ...rule };
  if (rule.count !== null) {
    const before = expandRow(
      series,
      new Date(Date.UTC(1000, 0, 1)),
      series.allDay ? utcMidnight(key.slice(0, 10)) : new Date(key),
      new Set(),
      2000,
    ).filter((o) => !atOrAfter(o.key, key, series.allDay)).length;
    rule.count = Math.max(1, before);
    restRule.count = Math.max(1, (restRule.count ?? 1) - before);
  } else {
    rule.until = series.allDay
      ? { kind: 'date', day: dateToDay(key.slice(0, 10)) - 1 }
      : { kind: 'instant', ms: Date.parse(key) - 1000 };
  }
  return { head: formatRRule(rule), rest: formatRRule(restRule) };
}

export async function updateEvent(deps: Deps, a: CalActor, eventId: string, input: UpdateInput) {
  const acc = await loadEvent(deps.db, a, eventId);
  if (!acc.canEdit) throw new AppError('calendar_read_only');
  if (acc.calendar?.calendar.kind === 'external') {
    if (input.roomId) throw new AppError('booking_room_unsupported');
    return updateExternalEvent(deps, a, acc, input);
  }
  if (input.calendarId && input.calendarId !== acc.row.calendarId) {
    // Into a mirrored calendar is a new event at the provider, not a move.
    const target = await loadCalendar(deps.db, a, input.calendarId);
    if (target.calendar.kind === 'external') {
      throw new AppError('calendar_external_unsupported', { reason: 'move' });
    }
  }
  let scope: SeriesScope = input.scope;
  let key = input.recurrenceId ?? acc.row.recurrenceId ?? undefined;
  const series = await loadSeries(deps.db, acc.row);
  if (acc.row.parentId && scope === 'this') {
    return updateRow(deps, a, acc.row, series, input, 'this');
  }
  if (scope !== 'all' && !series.rrule) {
    if (acc.row.parentId) throw new AppError('calendar_event_not_recurring');
    scope = 'all';
  }
  if (scope === 'following' && key && key === firstKey(series)) scope = 'all';
  if (scope === 'all') {
    // A dragged occurrence moves the whole series by the same wall-clock difference.
    return updateRow(deps, a, series, series, input, 'all', key);
  }
  if (!key) throw new AppError('calendar_occurrence_unknown');
  const occ = findOccurrence(series, key);
  const [existing] = (await overridesOf(deps.db, series.id)).filter((o) => o.recurrenceId === key);
  if (!occ && !existing) throw new AppError('calendar_occurrence_unknown');

  if (scope === 'this') {
    const override =
      existing ??
      (await deps.db.transaction(async (tx) => {
        const t = timesOf(series.allDay, occ!.start, occ!.end);
        const [row] = await tx
          .insert(calendarEvents)
          .values({
            orgId: series.orgId,
            calendarId: series.calendarId,
            uid: series.uid,
            parentId: series.id,
            recurrenceId: key,
            title: series.title,
            description: series.description,
            location: series.location,
            ...t,
            timeZone: series.timeZone,
            seriesEndsAt: t.endsAt,
            status: series.status,
            busy: series.busy,
            visibility: series.visibility,
            reminders: series.reminders,
            organizerId: series.organizerId,
            createdBy: a.userId,
            extra: series.extra,
          })
          .returning();
        return row!;
      }));
    return updateRow(deps, a, override, series, input, 'this');
  }

  // following: the series ends before the occurrence, a new one starts there.
  key = key!;
  const { head, rest } = truncateRule(series, key);
  const occStart = occ?.start ?? wireTimes(existing!).start;
  const occEnd = occ?.end ?? wireTimes(existing!).end;
  const created = await deps.db.transaction(async (tx) => {
    await tx
      .update(calendarEvents)
      .set({
        rrule: head,
        seriesEndsAt: computeSeriesEnd({ ...series, rrule: head }),
        sequence: series.sequence + 1,
        exdates: series.exdates.filter((x) => !atOrAfter(x, key!, series.allDay)),
      })
      .where(eq(calendarEvents.id, series.id));
    const later = (await overridesOf(tx, series.id)).filter((o) =>
      atOrAfter(o.recurrenceId!, key!, series.allDay),
    );
    if (later.length) {
      await tx
        .update(calendarEvents)
        .set({ deletedAt: new Date() })
        .where(
          inArray(
            calendarEvents.id,
            later.map((o) => o.id),
          ),
        );
    }
    const t = timesOf(series.allDay, occStart, occEnd);
    const values = {
      orgId: series.orgId,
      calendarId: series.calendarId,
      uid: newUid(deps.env.HUB_URL),
      title: series.title,
      description: series.description,
      location: series.location,
      ...t,
      timeZone: series.timeZone,
      rrule: rest,
      exdates: series.exdates.filter((x) => atOrAfter(x, key!, series.allDay)),
      status: series.status,
      busy: series.busy,
      visibility: series.visibility,
      reminders: series.reminders,
      organizerId: series.organizerId,
      createdBy: a.userId,
      extra: series.extra,
    };
    const [row] = await tx
      .insert(calendarEvents)
      .values({ ...values, seriesEndsAt: computeSeriesEnd(values) })
      .returning();
    const people = await tx
      .select()
      .from(calendarAttendees)
      .where(eq(calendarAttendees.eventId, series.id));
    if (people.length) {
      await tx.insert(calendarAttendees).values(
        people.map((p) => ({
          orgId: p.orgId,
          eventId: row!.id,
          userId: p.userId,
          email: p.email,
          name: p.name,
          response: p.response,
          optional: p.optional,
          respondedAt: p.respondedAt,
        })),
      );
    }
    return row!;
  });
  return updateRow(deps, a, created, created, { ...input, scope: 'all' }, 'all', key);
}

function firstKey(series: EventRow) {
  return occurrenceKey(series.allDay ? series.startDate! : series.startsAt, series.allDay);
}

/**
 * Applies the fields to one row. For a series (`all`) a new start given together with the key
 * of the occurrence it was taken from moves the series by the same wall-clock difference.
 */
async function updateRow(
  deps: Deps,
  a: CalActor,
  row: EventRow,
  series: EventRow,
  input: UpdateInput,
  scope: 'all' | 'this',
  fromKey?: string,
) {
  const db = deps.db;
  const patch = fieldsOf(input);
  let targetCal: CalendarAccess | null = null;
  if (input.calendarId && input.calendarId !== row.calendarId) {
    if (scope !== 'all' || row.parentId)
      throw new AppError('bad_request', { reason: 'move_series' });
    targetCal = await loadCalendar(db, a, input.calendarId);
    requireWrite(targetCal);
    patch.calendarId = targetCal.calendar.id;
  }
  const allDay = input.allDay ?? row.allDay;
  let timesChanged = false;
  if (input.start !== undefined && input.end !== undefined) {
    let start = input.start;
    let end = input.end;
    if (
      scope === 'all' &&
      row.rrule &&
      fromKey &&
      allDay === row.allDay &&
      fromKey !== firstKey(row)
    ) {
      // The new times are the occurrence's; move the series start by the same difference.
      const occ = findOccurrence(row, fromKey);
      if (occ) {
        if (allDay) {
          const delta = dateToDay(start) - dateToDay(occ.start);
          const len = dateToDay(end) - dateToDay(start);
          start = dayToDate(dateToDay(row.startDate!) + delta);
          end = dayToDate(dateToDay(start) + len);
        } else {
          const tz = patch.timeZone ?? row.timeZone;
          const moved = shiftWallClock(row.startsAt, new Date(occ.start), new Date(start), tz);
          const len = Date.parse(end) - Date.parse(start);
          start = moved.toISOString();
          end = new Date(moved.getTime() + len).toISOString();
        }
      }
    }
    const t = timesOf(allDay, start, end);
    timesChanged =
      t.allDay !== row.allDay ||
      t.startsAt.getTime() !== row.startsAt.getTime() ||
      t.endsAt.getTime() !== row.endsAt.getTime();
    Object.assign(patch, t);
  } else if (input.allDay !== undefined && input.allDay !== row.allDay) {
    throw new AppError('validation_failed', { field: 'start', reason: 'times_with_all_day' });
  }
  if (scope === 'all' && input.rrule !== undefined) {
    patch.rrule = input.rrule ? formatRRule(parseRRule(input.rrule)!) : null;
  }
  const merged = { ...row, ...patch } as EventRow;
  const startMoved =
    timesChanged &&
    (merged.allDay !== row.allDay ||
      occurrenceKey(merged.allDay ? merged.startDate! : merged.startsAt, merged.allDay) !==
        firstKey(row));
  const matters =
    MATTERS.some((k) => input[k] !== undefined) &&
    (timesChanged ||
      (input.title !== undefined && input.title !== row.title) ||
      (input.location !== undefined && input.location !== row.location) ||
      (input.rrule !== undefined && (patch.rrule ?? null) !== row.rrule));

  const specs =
    scope === 'all' && input.attendees ? await resolveAttendees(db, a, input.attendees) : null;
  const changes = await db.transaction(async (tx) => {
    if (scope === 'all' && !row.parentId && (startMoved || patch.rrule !== undefined)) {
      // Removed and changed occurrences were named after the old start: they go.
      if (startMoved) {
        patch.exdates = [];
        await tx
          .update(calendarEvents)
          .set({ deletedAt: new Date() })
          .where(and(eq(calendarEvents.parentId, row.id), isNull(calendarEvents.deletedAt)));
      }
    }
    const next = { ...row, ...patch } as EventRow;
    const [updated] = await tx
      .update(calendarEvents)
      .set({
        ...patch,
        seriesEndsAt: row.parentId ? next.endsAt : computeSeriesEnd(next),
        sequence: matters ? row.sequence + 1 : row.sequence,
        updatedAt: new Date(),
      })
      .where(eq(calendarEvents.id, row.id))
      .returning();
    if (scope === 'all' && targetCal && !row.parentId) {
      await tx
        .update(calendarEvents)
        .set({ calendarId: targetCal.calendar.id })
        .where(eq(calendarEvents.parentId, row.id));
    }
    // The room moves with the meeting (or is refused with the change when it is taken).
    if (scope === 'all' && !row.parentId) await syncEventRoom(tx, a, updated!, input.roomId);
    // A changed occurrence counts as a change of its series for CalDAV (one resource).
    if (row.parentId) {
      await tx
        .update(calendarEvents)
        .set({ updatedAt: new Date() })
        .where(eq(calendarEvents.id, row.parentId));
    }
    const diff = specs ? await setAttendees(tx, a.org.id, series.id, specs) : null;
    await touchCalendars(tx, [row.calendarId, ...(targetCal ? [targetCal.calendar.id] : [])]);
    return { updated: updated!, diff };
  });

  // The series' Crewhall meeting follows the event (changed occurrences keep the series' one).
  let meetingChanged = false;
  if (scope === 'all' && !row.parentId) {
    const current = changes.updated;
    const wantsMeeting = current.allDay
      ? false
      : (input.onlineMeeting ?? Boolean(current.meetingId));
    if (wantsMeeting && !current.meetingId) {
      changes.updated = { ...current, meetingId: await attachMeeting(deps, a, current) };
      meetingChanged = true;
    } else if (!wantsMeeting && current.meetingId) {
      await detachMeeting(deps, a, current);
      changes.updated = { ...current, meetingId: null };
      meetingChanged = true;
    } else if (current.meetingId && matters) {
      await syncMeeting(deps, a, current);
    }
  }

  const notify = input.notify !== false;
  if (notify && changes.diff?.added.length) {
    await announceChange(
      deps,
      a,
      series.id === row.id ? changes.updated : series,
      'invited',
      changes.diff.added,
    );
  }
  if (notify && changes.diff?.removed.length) {
    await announceChange(
      deps,
      a,
      changes.updated,
      'cancelled',
      changes.diff.removed.map((r) => ({
        userId: r.userId,
        email: r.email,
        name: r.name,
        optional: r.optional,
      })),
    );
  }
  if (notify && (matters || meetingChanged)) {
    await announceChange(deps, a, changes.updated, 'updated');
  }
  const fresh = await loadEvent(db, a, changes.updated.id);
  return toEvent(deps, a, fresh);
}

// ---- delete ---------------------------------------------------------------------------------------

export async function deleteEvent(
  deps: Deps,
  a: CalActor,
  eventId: string,
  q: { scope: SeriesScope; recurrenceId?: string },
) {
  const acc = await loadEvent(deps.db, a, eventId);
  if (!acc.canEdit) throw new AppError('calendar_read_only');
  if (acc.calendar?.calendar.kind === 'external') return deleteExternalEvent(deps, acc, q);
  const series = await loadSeries(deps.db, acc.row);
  const key = q.recurrenceId ?? acc.row.recurrenceId ?? undefined;
  let scope = q.scope;
  if (!series.rrule) scope = 'all';
  if (scope === 'following' && key === firstKey(series)) scope = 'all';
  if (acc.row.parentId && q.scope === 'all' && !q.recurrenceId) scope = 'all';
  const now = new Date();

  if (scope === 'all') {
    await deps.db.transaction(async (tx) => {
      await tx
        .update(calendarEvents)
        .set({ deletedAt: now })
        .where(eq(calendarEvents.id, series.id));
      await tx
        .update(calendarEvents)
        .set({ deletedAt: now })
        .where(and(eq(calendarEvents.parentId, series.id), isNull(calendarEvents.deletedAt)));
      await cancelEventBookings(tx, [series.id]);
      await touchCalendars(tx, [series.calendarId]);
    });
    await announceChange(deps, a, series, 'cancelled');
    await detachMeeting(deps, a, series);
    return;
  }
  if (!key) throw new AppError('calendar_occurrence_unknown');
  await deps.db.transaction(async (tx) => {
    if (scope === 'this') {
      await tx
        .update(calendarEvents)
        .set({
          exdates: [...new Set([...series.exdates, key])],
          sequence: series.sequence + 1,
          updatedAt: now,
        })
        .where(eq(calendarEvents.id, series.id));
      await tx
        .update(calendarEvents)
        .set({ deletedAt: now })
        .where(
          and(
            eq(calendarEvents.parentId, series.id),
            eq(calendarEvents.recurrenceId, key),
            isNull(calendarEvents.deletedAt),
          ),
        );
    } else {
      const { head } = truncateRule(series, key);
      await tx
        .update(calendarEvents)
        .set({
          rrule: head,
          seriesEndsAt: computeSeriesEnd({ ...series, rrule: head }),
          sequence: series.sequence + 1,
          updatedAt: now,
        })
        .where(eq(calendarEvents.id, series.id));
      const later = (await overridesOf(tx, series.id)).filter((o) =>
        atOrAfter(o.recurrenceId!, key, series.allDay),
      );
      if (later.length) {
        await tx
          .update(calendarEvents)
          .set({ deletedAt: now })
          .where(
            inArray(
              calendarEvents.id,
              later.map((o) => o.id),
            ),
          );
      }
    }
    await touchCalendars(tx, [series.calendarId]);
  });
  const [fresh] = await deps.db
    .select()
    .from(calendarEvents)
    .where(eq(calendarEvents.id, series.id));
  if (fresh) await announceChange(deps, a, fresh, 'updated');
}

// ---- respond --------------------------------------------------------------------------------------

export async function respondEvent(
  deps: Deps,
  a: CalActor,
  eventId: string,
  response: Exclude<AttendeeResponse, 'needs_action'>,
) {
  const acc = await loadEvent(deps.db, a, eventId);
  if (acc.calendar?.calendar.kind === 'external')
    return respondExternalEvent(deps, a, acc, response);
  if (!acc.attendee) throw new AppError('forbidden', { reason: 'not_invited' });
  await deps.db
    .update(calendarAttendees)
    .set({ response, respondedAt: new Date() })
    .where(eq(calendarAttendees.id, acc.attendee.id));
  await deps.db
    .update(calendarEvents)
    .set({ updatedAt: new Date() })
    .where(eq(calendarEvents.id, acc.series.id));
  await touchCalendars(deps.db, [acc.series.calendarId]);
  if (acc.attendee.response !== response) {
    await announceChange(deps, a, acc.series, 'response' as ChangeKind, undefined, response);
  }
  const fresh = await loadEvent(deps.db, a, eventId);
  return toEvent(deps, a, fresh);
}
