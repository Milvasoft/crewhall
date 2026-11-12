import {
  canContacts,
  type Booking,
  type BookingResource,
  type EndpointName,
  type EventRoom,
} from '@crewhall/shared';
import { actorOf, MockApiError, requireUser, summary, type Resolvers } from './core';
import { newId } from './db';
import type { MockState } from './seed';

/**
 * Room and desk booking part of the contract mock (sonraki-isler), in memory: resources,
 * bookings with the same overlap and check-in rules as the server. The calendar mock calls the
 * room hooks when an event gets or loses a room; a booking's own event lives there too.
 */

interface MockBooking {
  id: string;
  resourceId: string;
  userId: string;
  eventId: string | null;
  ownEvent: boolean;
  start: string;
  end: string;
  status: Booking['status'];
  checkedInAt: string | null;
}

interface State {
  resources: BookingResource[];
  bookings: MockBooking[];
}

const seedResources = (): BookingResource[] => [
  {
    id: '0190f0a0-0000-7000-8000-000000000b01',
    kind: 'room',
    name: 'Boğaz',
    location: '3. kat',
    capacity: 8,
    equipment: ['Ekran', 'Kamera'],
    description: null,
    checkInRequired: true,
    checkInGraceMinutes: 15,
    active: true,
  },
  {
    id: '0190f0a0-0000-7000-8000-000000000b02',
    kind: 'room',
    name: 'Galata',
    location: '3. kat',
    capacity: 20,
    equipment: ['Projeksiyon'],
    description: null,
    checkInRequired: false,
    checkInGraceMinutes: 15,
    active: true,
  },
  {
    id: '0190f0a0-0000-7000-8000-000000000b03',
    kind: 'desk',
    name: 'Masa A-12',
    location: '2. kat',
    capacity: null,
    equipment: [],
    description: null,
    checkInRequired: false,
    checkInGraceMinutes: 15,
    active: true,
  },
];

let state: State = { resources: seedResources(), bookings: [] };

/** Hooks into the calendar mock (set by it, so the two modules do not import each other). */
export const bookingEvents: {
  create: (b: {
    userId: string;
    title: string;
    location: string;
    start: string;
    end: string;
    busy: boolean;
  }) => string;
  remove: (eventId: string) => void;
} = {
  create: () => {
    throw new Error('calendar mock not loaded');
  },
  remove: () => undefined,
};

export function resetBookingsMock() {
  state = { resources: seedResources(), bookings: [] };
}

export function bookingsMockState() {
  return state;
}

/** Tests: a resource as an admin would define it. */
export function addMockResource(
  r: Partial<BookingResource> & Pick<BookingResource, 'kind' | 'name'>,
) {
  const resource: BookingResource = {
    id: newId(),
    location: null,
    capacity: null,
    equipment: [],
    description: null,
    checkInRequired: false,
    checkInGraceMinutes: 15,
    active: true,
    ...r,
  };
  state.resources.push(resource);
  return resource;
}

const ACTIVE = new Set<Booking['status']>(['confirmed', 'checked_in']);
// Org admins and owners; the mock uses the directory's "manage" rule for the same roles.
const isAdmin = (s: MockState, userId: string) => {
  const me = s.users.find((u) => u.id === userId);
  return Boolean(me && canContacts('directory.manage', { orgRole: actorOf(s, me).orgRole }));
};

function clash(resourceId: string, start: string, end: string, except?: string) {
  const r = state.resources.find((x) => x.id === resourceId);
  if (!r) throw new MockApiError('not_found');
  if (!r.active) throw new MockApiError('booking_unavailable');
  const taken = state.bookings.some(
    (b) =>
      b.resourceId === resourceId &&
      b.id !== except &&
      ACTIVE.has(b.status) &&
      b.start < end &&
      b.end > start,
  );
  if (taken) throw new MockApiError('booking_conflict');
  return r;
}

function windowOf(r: BookingResource, start: string) {
  if (!r.checkInRequired) return null;
  const t = Date.parse(start);
  return {
    opensAt: new Date(t - 15 * 60_000).toISOString(),
    closesAt: new Date(t + r.checkInGraceMinutes * 60_000).toISOString(),
  };
}

function toBooking(s: MockState, userId: string, b: MockBooking): Booking {
  const r = state.resources.find((x) => x.id === b.resourceId)!;
  const u = s.users.find((x) => x.id === b.userId)!;
  const win = windowOf(r, b.start);
  const own = b.userId === userId;
  const now = Date.now();
  return {
    id: b.id,
    resource: { id: r.id, kind: r.kind, name: r.name, location: r.location },
    user: summary(u),
    eventId: b.eventId,
    title: own || isAdmin(s, userId) ? r.name : null,
    start: b.start,
    end: b.end,
    status: b.status,
    checkedInAt: b.checkedInAt,
    checkIn: win,
    permissions: {
      cancel: ACTIVE.has(b.status) && (own || isAdmin(s, userId)) && Date.parse(b.end) > now,
      checkIn:
        own &&
        b.status === 'confirmed' &&
        Boolean(win) &&
        now >= Date.parse(win!.opensAt) &&
        now <= Date.parse(win!.closesAt),
    },
  };
}

const placeOf = (r: BookingResource) => (r.location ? `${r.name} · ${r.location}` : r.name);

// ---- calendar hooks ------------------------------------------------------------------------

/** An event's room (the calendar mock's toEvent). */
export function eventRoomOf(eventId: string): EventRoom | null {
  const b = [...state.bookings]
    .reverse()
    .find((x) => x.eventId === eventId && !x.ownEvent && x.status !== 'cancelled');
  if (!b) return null;
  const r = state.resources.find((x) => x.id === b.resourceId)!;
  return {
    resourceId: r.id,
    name: r.name,
    location: r.location,
    bookingId: b.id,
    status: b.status,
    checkIn: windowOf(r, b.start),
  };
}

/** Same rules as the server's syncEventRoom; returns the place to show when it had none. */
export function syncEventRoom(
  e: { id: string; allDay: boolean; rrule: string | null; start: string; end: string },
  userId: string,
  roomId: string | null | undefined,
): string | null {
  const current = state.bookings.find(
    (b) => b.eventId === e.id && !b.ownEvent && ACTIVE.has(b.status),
  );
  const target = roomId === undefined ? current?.resourceId : roomId;
  if (!target) {
    if (current) current.status = 'cancelled';
    return null;
  }
  if (e.allDay || e.rrule) throw new MockApiError('booking_room_unsupported');
  const r = clash(target, e.start, e.end, current?.resourceId === target ? current.id : undefined);
  if (current && current.resourceId === target) {
    current.start = e.start;
    current.end = e.end;
    return null;
  }
  if (current) current.status = 'cancelled';
  state.bookings.push({
    id: newId(),
    resourceId: r.id,
    userId,
    eventId: e.id,
    ownEvent: false,
    start: e.start,
    end: e.end,
    status: 'confirmed',
    checkedInAt: null,
  });
  return placeOf(r);
}

export function cancelEventBookings(eventId: string) {
  for (const b of state.bookings) {
    if (b.eventId === eventId && ACTIVE.has(b.status)) b.status = 'cancelled';
  }
}

// ---- resolvers -----------------------------------------------------------------------------

export const bookingResolvers: Partial<Resolvers<EndpointName>> = {
  listBookingResources: ({ s, query }) => {
    const u = requireUser(s);
    const all = Boolean(query.all) && isAdmin(s, u.id);
    return {
      items: state.resources
        .filter((r) => (!query.kind || r.kind === query.kind) && (all || r.active))
        .sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name, 'tr')),
    };
  },
  createBookingResource: ({ s, body }) => {
    const u = requireUser(s);
    if (!isAdmin(s, u.id)) throw new MockApiError('forbidden');
    return addMockResource({
      kind: body.kind,
      name: body.name,
      location: body.location || null,
      capacity: body.kind === 'room' ? (body.capacity ?? null) : null,
      equipment: body.equipment ?? [],
      description: body.description || null,
      checkInRequired: body.checkInRequired ?? false,
      checkInGraceMinutes: body.checkInGraceMinutes ?? 15,
    });
  },
  updateBookingResource: ({ s, params, body }) => {
    const u = requireUser(s);
    if (!isAdmin(s, u.id)) throw new MockApiError('forbidden');
    const r = state.resources.find((x) => x.id === params.resourceId);
    if (!r) throw new MockApiError('not_found');
    for (const [k, v] of Object.entries(body)) {
      if (v === undefined) continue;
      if (k === 'capacity' && r.kind !== 'room') continue;
      (r as Record<string, unknown>)[k] = v === '' ? null : v;
    }
    return r;
  },
  deleteBookingResource: ({ s, params }) => {
    const u = requireUser(s);
    if (!isAdmin(s, u.id)) throw new MockApiError('forbidden');
    for (const b of state.bookings.filter((x) => x.resourceId === params.resourceId)) {
      if (b.ownEvent && b.eventId) bookingEvents.remove(b.eventId);
    }
    state.bookings = state.bookings.filter((x) => x.resourceId !== params.resourceId);
    state.resources = state.resources.filter((x) => x.id !== params.resourceId);
    return {};
  },
  listBookings: ({ s, query }) => {
    const u = requireUser(s);
    return {
      items: state.bookings
        .filter((b) => {
          const r = state.resources.find((x) => x.id === b.resourceId);
          return (
            r &&
            b.status !== 'cancelled' &&
            b.start < query.to &&
            b.end > query.from &&
            (!query.resourceId || b.resourceId === query.resourceId) &&
            (!query.kind || r.kind === query.kind) &&
            (!query.mine || b.userId === u.id)
          );
        })
        .sort((a, b) => (a.start < b.start ? -1 : 1))
        .map((b) => toBooking(s, u.id, b)),
    };
  },
  getBookingAvailability: ({ s, query }) => {
    requireUser(s);
    const items = state.resources
      .filter((r) => r.active && r.kind === (query.kind ?? 'room'))
      .map((r) => ({
        resource: r,
        free: !state.bookings.some(
          (b) =>
            b.resourceId === r.id &&
            ACTIVE.has(b.status) &&
            b.start < query.to &&
            b.end > query.from &&
            (!query.eventId || b.eventId !== query.eventId),
        ),
        fits: !query.capacity || r.capacity === null || r.capacity >= Number(query.capacity),
      }))
      .sort(
        (x, y) =>
          Number(y.free && y.fits) - Number(x.free && x.fits) ||
          (x.resource.capacity ?? 9999) - (y.resource.capacity ?? 9999) ||
          x.resource.name.localeCompare(y.resource.name, 'tr'),
      );
    return { items, suggestedId: items.find((i) => i.free && i.fits)?.resource.id ?? null };
  },
  createBooking: ({ s, body }) => {
    const u = requireUser(s);
    const r = clash(body.resourceId, body.start, body.end);
    const eventId = bookingEvents.create({
      userId: u.id,
      title: body.title || r.name,
      location: placeOf(r),
      start: body.start,
      end: body.end,
      busy: r.kind === 'room',
    });
    const b: MockBooking = {
      id: newId(),
      resourceId: r.id,
      userId: u.id,
      eventId,
      ownEvent: true,
      start: body.start,
      end: body.end,
      status: 'confirmed',
      checkedInAt: null,
    };
    state.bookings.push(b);
    return toBooking(s, u.id, b);
  },
  cancelBooking: ({ s, params }) => {
    const u = requireUser(s);
    const b = state.bookings.find((x) => x.id === params.bookingId);
    if (!b) throw new MockApiError('not_found');
    if (!toBooking(s, u.id, b).permissions.cancel) throw new MockApiError('forbidden');
    b.status = 'cancelled';
    if (b.ownEvent && b.eventId) bookingEvents.remove(b.eventId);
    return {};
  },
  checkInBooking: ({ s, params }) => {
    const u = requireUser(s);
    const b = state.bookings.find((x) => x.id === params.bookingId);
    if (!b) throw new MockApiError('not_found');
    if (b.userId !== u.id) throw new MockApiError('forbidden');
    if (!toBooking(s, u.id, b).permissions.checkIn) {
      throw new MockApiError('booking_check_in_closed');
    }
    b.status = 'checked_in';
    b.checkedInAt = new Date().toISOString();
    return toBooking(s, u.id, b);
  },
};
