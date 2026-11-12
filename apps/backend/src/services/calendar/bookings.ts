import { and, asc, eq, gt, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { bookingResources, bookings, calendarEvents, type Db, type DbOrTx } from '@crewhall/db';
import {
  can,
  type Booking,
  type BookingAvailability,
  type BookingResource,
  type CreateBooking,
  type CreateBookingResource,
  type EventRoom,
  type UpdateBookingResource,
} from '@crewhall/shared';
import type { z } from 'zod';
import type {
  BookingAvailabilityQuery,
  BookingResourcesQuery,
  BookingsQuery,
} from '@crewhall/shared';
import type { Deps } from '../../deps';
import { AppError } from '../../http/errors';
import { orgContext } from '../membership';
import {
  personalCalendar,
  touchCalendars,
  usersByIds,
  type CalActor,
  type EventRow,
} from './access';
import { settingsFor } from './settings';

/**
 * Room and desk booking (sonraki-isler). A booking always has a calendar event: the meeting it
 * was made for (rooms from the event editor) or an event made for it in the booker's personal
 * calendar (the booking page). Overlaps are checked under a lock on the resource row, so two
 * people never get the same room. A resource that wants a check-in is freed by the
 * calendar.bookings_release job when nobody checks in within the grace minutes.
 */

type ResourceRow = typeof bookingResources.$inferSelect;
type BookingRow = typeof bookings.$inferSelect;

/** Bookings that hold the resource. */
const ACTIVE = ['confirmed', 'checked_in'] as const;
const CHECK_IN_EARLY_MS = 15 * 60_000;

const isAdmin = (a: CalActor) =>
  can(a.actor, 'org.update_settings', { type: 'org', org: orgContext(a.org) });

function requireMember(a: CalActor) {
  if (a.actor.orgRole === 'guest') throw new AppError('forbidden');
}

function requireAdmin(a: CalActor) {
  if (!isAdmin(a)) throw new AppError('forbidden');
}

export const toResource = (r: ResourceRow): BookingResource => ({
  id: r.id,
  kind: r.kind,
  name: r.name,
  location: r.location,
  capacity: r.capacity,
  equipment: r.equipment,
  description: r.description,
  checkInRequired: r.checkInRequired,
  checkInGraceMinutes: r.checkInGraceMinutes,
  active: r.active,
});

/** The check-in window of a booking, or null when the resource wants none. */
export function checkInWindow(
  r: Pick<ResourceRow, 'checkInRequired' | 'checkInGraceMinutes'>,
  start: Date,
) {
  if (!r.checkInRequired) return null;
  return {
    opensAt: new Date(start.getTime() - CHECK_IN_EARLY_MS),
    closesAt: new Date(start.getTime() + r.checkInGraceMinutes * 60_000),
  };
}

const iso = (w: { opensAt: Date; closesAt: Date } | null) =>
  w ? { opensAt: w.opensAt.toISOString(), closesAt: w.closesAt.toISOString() } : null;

// ---- resources -----------------------------------------------------------------------------

export async function listResources(
  db: DbOrTx,
  a: CalActor,
  q: z.output<typeof BookingResourcesQuery>,
) {
  requireMember(a);
  const rows = await db
    .select()
    .from(bookingResources)
    .where(
      and(
        eq(bookingResources.orgId, a.org.id),
        q.kind ? eq(bookingResources.kind, q.kind) : undefined,
        q.all && isAdmin(a) ? undefined : eq(bookingResources.active, true),
      ),
    )
    .orderBy(asc(bookingResources.kind), sql`${bookingResources.name} collate "tr-x-icu"`);
  return { items: rows.map(toResource) };
}

async function loadResource(db: DbOrTx, a: CalActor, id: string) {
  const [row] = await db
    .select()
    .from(bookingResources)
    .where(and(eq(bookingResources.id, id), eq(bookingResources.orgId, a.org.id)));
  if (!row) throw new AppError('not_found');
  return row;
}

export async function createResource(db: DbOrTx, a: CalActor, input: CreateBookingResource) {
  requireAdmin(a);
  const [row] = await db
    .insert(bookingResources)
    .values({
      orgId: a.org.id,
      kind: input.kind,
      name: input.name,
      location: input.location || null,
      capacity: input.kind === 'room' ? (input.capacity ?? null) : null,
      equipment: input.equipment ?? [],
      description: input.description || null,
      checkInRequired: input.checkInRequired ?? false,
      checkInGraceMinutes: input.checkInGraceMinutes ?? 15,
    })
    .returning();
  return toResource(row!);
}

export async function updateResource(
  db: DbOrTx,
  a: CalActor,
  id: string,
  input: UpdateBookingResource,
) {
  requireAdmin(a);
  const current = await loadResource(db, a, id);
  const set: Partial<ResourceRow> = {};
  if (input.name !== undefined) set.name = input.name;
  if (input.location !== undefined) set.location = input.location || null;
  if (input.capacity !== undefined && current.kind === 'room') set.capacity = input.capacity;
  if (input.equipment !== undefined) set.equipment = input.equipment;
  if (input.description !== undefined) set.description = input.description || null;
  if (input.checkInRequired !== undefined) set.checkInRequired = input.checkInRequired;
  if (input.checkInGraceMinutes !== undefined) set.checkInGraceMinutes = input.checkInGraceMinutes;
  if (input.active !== undefined) set.active = input.active;
  const [row] = await db
    .update(bookingResources)
    .set({ ...set, updatedAt: new Date() })
    .where(eq(bookingResources.id, current.id))
    .returning();
  return toResource(row!);
}

export async function deleteResource(deps: Pick<Deps, 'db'>, a: CalActor, id: string) {
  requireAdmin(a);
  const current = await loadResource(deps.db, a, id);
  await deps.db.transaction(async (tx) => {
    const future = await tx
      .select()
      .from(bookings)
      .where(
        and(
          eq(bookings.resourceId, current.id),
          inArray(bookings.status, [...ACTIVE]),
          gt(bookings.endsAt, new Date()),
        ),
      );
    await removeOwnEvents(tx, future);
    await tx.delete(bookingResources).where(eq(bookingResources.id, current.id));
  });
}

// ---- conflicts -----------------------------------------------------------------------------

/**
 * Locks the resource row and refuses a time that overlaps another active booking. Callers run
 * it inside the transaction that writes the booking, so concurrent bookings queue up here.
 */
async function lockFree(
  tx: DbOrTx,
  orgId: string,
  resourceId: string,
  start: Date,
  end: Date,
  except?: string,
) {
  const [resource] = await tx
    .select()
    .from(bookingResources)
    .where(and(eq(bookingResources.id, resourceId), eq(bookingResources.orgId, orgId)))
    .for('update');
  if (!resource) throw new AppError('not_found');
  if (!resource.active) throw new AppError('booking_unavailable');
  const [clash] = await tx
    .select({ id: bookings.id })
    .from(bookings)
    .where(
      and(
        eq(bookings.resourceId, resourceId),
        inArray(bookings.status, [...ACTIVE]),
        lt(bookings.startsAt, end),
        gt(bookings.endsAt, start),
        except ? ne(bookings.id, except) : undefined,
      ),
    )
    .limit(1);
  if (clash) throw new AppError('booking_conflict');
  return resource;
}

/** The events made for these bookings go with them. */
async function removeOwnEvents(tx: DbOrTx, rows: BookingRow[]) {
  const ids = rows.filter((b) => b.ownEvent && b.eventId).map((b) => b.eventId!);
  if (!ids.length) return;
  const gone = await tx
    .update(calendarEvents)
    .set({ deletedAt: new Date() })
    .where(and(inArray(calendarEvents.id, ids), isNull(calendarEvents.deletedAt)))
    .returning({ calendarId: calendarEvents.calendarId });
  await touchCalendars(tx, [...new Set(gone.map((g) => g.calendarId))]);
}

// ---- bookings ------------------------------------------------------------------------------

async function toBookings(db: DbOrTx, a: CalActor, rows: BookingRow[]): Promise<Booking[]> {
  if (!rows.length) return [];
  const eventIds = rows.flatMap((r) => (r.eventId ? [r.eventId] : []));
  const [resources, people, events] = await Promise.all([
    db
      .select()
      .from(bookingResources)
      .where(inArray(bookingResources.id, [...new Set(rows.map((r) => r.resourceId))])),
    usersByIds(
      db,
      rows.map((r) => r.userId),
    ),
    eventIds.length
      ? db
          .select({ id: calendarEvents.id, title: calendarEvents.title })
          .from(calendarEvents)
          .where(inArray(calendarEvents.id, eventIds))
      : Promise.resolve([]),
  ]);
  const admin = isAdmin(a);
  const now = Date.now();
  return rows.map((b) => {
    const r = resources.find((x) => x.id === b.resourceId)!;
    const own = b.userId === a.userId;
    const win = checkInWindow(r, b.startsAt);
    const active = (ACTIVE as readonly string[]).includes(b.status);
    return {
      id: b.id,
      resource: { id: r.id, kind: r.kind, name: r.name, location: r.location },
      user: people.get(b.userId) ?? {
        id: b.userId,
        name: '',
        email: '',
        imageUrl: null,
      },
      eventId: b.eventId,
      title: own || admin ? (events.find((e) => e.id === b.eventId)?.title ?? null) : null,
      start: b.startsAt.toISOString(),
      end: b.endsAt.toISOString(),
      status: b.status,
      checkedInAt: b.checkedInAt?.toISOString() ?? null,
      checkIn: iso(win),
      permissions: {
        cancel: active && (own || admin) && b.endsAt.getTime() > now,
        checkIn:
          own &&
          b.status === 'confirmed' &&
          Boolean(win) &&
          now >= win!.opensAt.getTime() &&
          now <= win!.closesAt.getTime(),
      },
    };
  });
}

export async function listBookings(db: DbOrTx, a: CalActor, q: z.output<typeof BookingsQuery>) {
  requireMember(a);
  const rows = await db
    .select({ b: bookings })
    .from(bookings)
    .innerJoin(bookingResources, eq(bookingResources.id, bookings.resourceId))
    .where(
      and(
        eq(bookings.orgId, a.org.id),
        ne(bookings.status, 'cancelled'),
        lt(bookings.startsAt, new Date(q.to)),
        gt(bookings.endsAt, new Date(q.from)),
        q.resourceId ? eq(bookings.resourceId, q.resourceId) : undefined,
        q.kind ? eq(bookingResources.kind, q.kind) : undefined,
        q.mine ? eq(bookings.userId, a.userId) : undefined,
      ),
    )
    .orderBy(asc(bookings.startsAt))
    .limit(2000);
  return {
    items: await toBookings(
      db,
      a,
      rows.map((r) => r.b),
    ),
  };
}

export async function availability(
  db: DbOrTx,
  a: CalActor,
  q: z.output<typeof BookingAvailabilityQuery>,
): Promise<BookingAvailability> {
  requireMember(a);
  const resources = await db
    .select()
    .from(bookingResources)
    .where(
      and(
        eq(bookingResources.orgId, a.org.id),
        eq(bookingResources.kind, q.kind),
        eq(bookingResources.active, true),
      ),
    );
  const from = new Date(q.from);
  const to = new Date(q.to);
  const busy = resources.length
    ? await db
        .select({ resourceId: bookings.resourceId })
        .from(bookings)
        .where(
          and(
            inArray(
              bookings.resourceId,
              resources.map((r) => r.id),
            ),
            inArray(bookings.status, [...ACTIVE]),
            lt(bookings.startsAt, to),
            gt(bookings.endsAt, from),
            q.eventId ? or(isNull(bookings.eventId), ne(bookings.eventId, q.eventId)) : undefined,
          ),
        )
    : [];
  const taken = new Set(busy.map((b) => b.resourceId));
  const items = resources
    .map((r) => ({
      resource: toResource(r),
      free: !taken.has(r.id),
      fits: !q.capacity || r.capacity === null || r.capacity >= q.capacity,
    }))
    // Free and big enough first, the smallest such room first; then the rest by name.
    .sort(
      (x, y) =>
        Number(y.free && y.fits) - Number(x.free && x.fits) ||
        (x.free && x.fits && y.free && y.fits
          ? (x.resource.capacity ?? 9999) - (y.resource.capacity ?? 9999)
          : 0) ||
        x.resource.name.localeCompare(y.resource.name, 'tr'),
    );
  const suggested = items.find((i) => i.free && i.fits);
  return { items, suggestedId: suggested?.resource.id ?? null };
}

/** The label a booked event shows as its place when it had none. */
const placeOf = (r: ResourceRow) => (r.location ? `${r.name} · ${r.location}` : r.name);

export async function createBooking(
  deps: Pick<Deps, 'db' | 'env'>,
  a: CalActor,
  input: CreateBooking,
) {
  requireMember(a);
  const start = new Date(input.start);
  const end = new Date(input.end);
  const cal = await personalCalendar(deps.db, a);
  const settings = await settingsFor(deps.db, a.org.id, a.userId);
  const row = await deps.db.transaction(async (tx) => {
    const resource = await lockFree(tx, a.org.id, input.resourceId, start, end);
    const [event] = await tx
      .insert(calendarEvents)
      .values({
        orgId: a.org.id,
        calendarId: cal.id,
        uid: `${crypto.randomUUID()}@${new URL(deps.env.HUB_URL).hostname}`,
        title: input.title || resource.name,
        location: placeOf(resource),
        allDay: false,
        startsAt: start,
        endsAt: end,
        seriesEndsAt: end,
        timeZone: settings.timeZone,
        // Sitting at a desk is not being busy; a room is a meeting.
        busy: resource.kind === 'room',
        organizerId: a.userId,
        createdBy: a.userId,
      })
      .returning();
    const [booking] = await tx
      .insert(bookings)
      .values({
        orgId: a.org.id,
        resourceId: resource.id,
        userId: a.userId,
        eventId: event!.id,
        ownEvent: true,
        startsAt: start,
        endsAt: end,
      })
      .returning();
    await touchCalendars(tx, [cal.id]);
    return booking!;
  });
  return (await toBookings(deps.db, a, [row]))[0]!;
}

async function loadBooking(db: DbOrTx, a: CalActor, id: string) {
  const [row] = await db
    .select()
    .from(bookings)
    .where(and(eq(bookings.id, id), eq(bookings.orgId, a.org.id)));
  if (!row) throw new AppError('not_found');
  return row;
}

export async function cancelBooking(deps: Pick<Deps, 'db'>, a: CalActor, id: string) {
  const row = await loadBooking(deps.db, a, id);
  const [view] = await toBookings(deps.db, a, [row]);
  if (!view!.permissions.cancel) throw new AppError('forbidden');
  await deps.db.transaction(async (tx) => {
    await tx
      .update(bookings)
      .set({ status: 'cancelled', endedAt: new Date(), updatedAt: new Date() })
      .where(eq(bookings.id, row.id));
    await removeOwnEvents(tx, [row]);
  });
}

export async function checkIn(deps: Pick<Deps, 'db'>, a: CalActor, id: string) {
  const row = await loadBooking(deps.db, a, id);
  if (row.userId !== a.userId) throw new AppError('forbidden');
  const [view] = await toBookings(deps.db, a, [row]);
  if (!view!.permissions.checkIn) throw new AppError('booking_check_in_closed');
  const [updated] = await deps.db
    .update(bookings)
    .set({ status: 'checked_in', checkedInAt: new Date(), updatedAt: new Date() })
    .where(eq(bookings.id, row.id))
    .returning();
  return (await toBookings(deps.db, a, [updated!]))[0]!;
}

/**
 * calendar.bookings_release (every minute): bookings of resources that want a check-in, still
 * not checked in when the grace time ended, are freed; their own events go.
 */
export async function releaseUnclaimed(db: Db, now = new Date()) {
  return db.transaction(async (tx) => {
    const due = await tx
      .select({ b: bookings })
      .from(bookings)
      .innerJoin(bookingResources, eq(bookingResources.id, bookings.resourceId))
      .where(
        and(
          eq(bookings.status, 'confirmed'),
          eq(bookingResources.checkInRequired, true),
          sql`${bookings.startsAt} + make_interval(mins => ${bookingResources.checkInGraceMinutes}) < ${now}`,
        ),
      )
      .for('update', { of: bookings, skipLocked: true });
    if (!due.length) return 0;
    const rows = due.map((d) => d.b);
    await tx
      .update(bookings)
      .set({ status: 'released', endedAt: now, updatedAt: now })
      .where(
        inArray(
          bookings.id,
          rows.map((r) => r.id),
        ),
      );
    await removeOwnEvents(tx, rows);
    return rows.length;
  });
}

// ---- rooms on calendar events ----------------------------------------------------------------

/** The room booked for an event, for the event view. */
export async function eventRooms(db: DbOrTx, eventIds: string[]): Promise<Map<string, EventRoom>> {
  if (!eventIds.length) return new Map();
  const rows = await db
    .select({ b: bookings, r: bookingResources })
    .from(bookings)
    .innerJoin(bookingResources, eq(bookingResources.id, bookings.resourceId))
    .where(
      and(
        inArray(bookings.eventId, eventIds),
        eq(bookings.ownEvent, false),
        ne(bookings.status, 'cancelled'),
      ),
    )
    .orderBy(asc(bookings.createdAt));
  const out = new Map<string, EventRoom>();
  for (const { b, r } of rows) {
    // The latest one wins (a released room shows as released until another is booked).
    out.set(b.eventId!, {
      resourceId: r.id,
      name: r.name,
      location: r.location,
      bookingId: b.id,
      status: b.status,
      checkIn: iso(checkInWindow(r, b.startsAt)),
    });
  }
  return out;
}

/**
 * Keeps an event's room booking in step with the event (inside the event's transaction):
 * `roomId` undefined keeps the room and moves its booking with the event, null frees it, an id
 * books that room. Only one-off timed events in Crewhall calendars take a room.
 */
export async function syncEventRoom(
  tx: DbOrTx,
  a: CalActor,
  event: EventRow,
  roomId: string | null | undefined,
) {
  const [current] = await tx
    .select()
    .from(bookings)
    .where(
      and(
        eq(bookings.eventId, event.id),
        eq(bookings.ownEvent, false),
        inArray(bookings.status, [...ACTIVE]),
      ),
    );
  const target = roomId === undefined ? current?.resourceId : roomId;
  if (current && (!target || target !== current.resourceId)) {
    await tx
      .update(bookings)
      .set({ status: 'cancelled', endedAt: new Date(), updatedAt: new Date() })
      .where(eq(bookings.id, current.id));
  }
  if (!target) return;
  if (event.allDay || event.rrule || event.parentId || event.deletedAt) {
    throw new AppError('booking_room_unsupported');
  }
  if (current && target === current.resourceId) {
    if (
      current.startsAt.getTime() === event.startsAt.getTime() &&
      current.endsAt.getTime() === event.endsAt.getTime()
    ) {
      return;
    }
    await lockFree(tx, a.org.id, target, event.startsAt, event.endsAt, current.id);
    await tx
      .update(bookings)
      .set({ startsAt: event.startsAt, endsAt: event.endsAt, updatedAt: new Date() })
      .where(eq(bookings.id, current.id));
    return;
  }
  const resource = await lockFree(tx, a.org.id, target, event.startsAt, event.endsAt);
  if (resource.kind !== 'room') throw new AppError('booking_room_unsupported');
  await tx.insert(bookings).values({
    orgId: a.org.id,
    resourceId: resource.id,
    userId: a.userId,
    eventId: event.id,
    startsAt: event.startsAt,
    endsAt: event.endsAt,
  });
  // The room is the meeting's place when it had none.
  if (!event.location) {
    await tx
      .update(calendarEvents)
      .set({ location: placeOf(resource) })
      .where(eq(calendarEvents.id, event.id));
  }
}

/** A deleted event frees its room (and a booking's own event ends the booking). */
export async function cancelEventBookings(tx: DbOrTx, eventIds: string[]) {
  if (!eventIds.length) return;
  await tx
    .update(bookings)
    .set({ status: 'cancelled', endedAt: new Date(), updatedAt: new Date() })
    .where(and(inArray(bookings.eventId, eventIds), inArray(bookings.status, [...ACTIVE])));
}
