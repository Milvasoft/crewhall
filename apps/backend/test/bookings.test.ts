import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiError } from '@crewhall/api-client';
import { releaseUnclaimed } from '../src/services/calendar/bookings';
import { Client, createTestApp, join, setupWithOwner, type TestApp } from './helpers';

/** Room and desk booking (sonraki-isler): resources, conflicts, rooms on events, check-in. */
describe('room and desk booking', () => {
  let app: TestApp;
  let owner: Client;
  let mert: Client;
  let ayse: Client;
  let roomId: string;
  let bigRoomId: string;
  let deskId: string;
  let calendarId: string;

  async function expectCode(p: Promise<unknown>, status: number, code?: string) {
    try {
      await p;
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(status);
      if (code) expect((err as ApiError).code).toBe(code);
      return;
    }
    throw new Error(`expected ${status}`);
  }

  const at = (iso: string) => new Date(iso).toISOString();

  beforeAll(async () => {
    app = await createTestApp();
    const setup = await setupWithOwner(app);
    owner = setup.owner;
    mert = (await join(app, owner, 'mert@milvasoft.com', 'member')).person;
    ayse = (await join(app, owner, 'ayse@milvasoft.com', 'member')).person;
    const { items } = await owner.api.call('listCalendars');
    calendarId = items.find((c) => c.kind === 'personal' && c.permissions.write)!.id;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('lets admins define rooms and desks', async () => {
    const room = await owner.api.call('createBookingResource', {
      body: {
        kind: 'room',
        name: 'Boğaz',
        location: '3. kat',
        capacity: 6,
        equipment: ['Ekran', 'Kamera'],
        checkInRequired: true,
        checkInGraceMinutes: 15,
      },
    });
    roomId = room.id;
    bigRoomId = (
      await owner.api.call('createBookingResource', {
        body: { kind: 'room', name: 'Galata', capacity: 20 },
      })
    ).id;
    deskId = (
      await owner.api.call('createBookingResource', {
        body: { kind: 'desk', name: 'Masa A-12', location: '2. kat', capacity: 4 },
      })
    ).id;
    expect(room).toMatchObject({ capacity: 6, equipment: ['Ekran', 'Kamera'], active: true });
    await expectCode(
      mert.api.call('createBookingResource', { body: { kind: 'desk', name: 'X' } }),
      403,
      'forbidden',
    );
    const desks = await mert.api.call('listBookingResources', { query: { kind: 'desk' } });
    // A desk has no capacity.
    expect(desks.items).toEqual([expect.objectContaining({ name: 'Masa A-12', capacity: null })]);
  });

  it('books a desk into the calendar and refuses overlaps', async () => {
    const start = at('2026-12-01T06:00:00Z');
    const end = at('2026-12-01T15:00:00Z');
    const mine = await mert.api.call('createBooking', {
      body: { resourceId: deskId, start, end },
    });
    expect(mine).toMatchObject({
      resource: { name: 'Masa A-12' },
      status: 'confirmed',
      checkIn: null,
      permissions: { cancel: true, checkIn: false },
    });
    // The booking is an event of Mert's calendar (not busy: a desk is not a meeting).
    const ev = await mert.api.call('getCalendarEvent', { params: { eventId: mine.eventId! } });
    expect(ev).toMatchObject({ title: 'Masa A-12', location: 'Masa A-12 · 2. kat', busy: false });

    await expectCode(
      ayse.api.call('createBooking', {
        body: {
          resourceId: deskId,
          start: at('2026-12-01T14:00:00Z'),
          end: at('2026-12-01T16:00:00Z'),
        },
      }),
      409,
      'booking_conflict',
    );
    // Right after it is free; others see who booked, not the title.
    await ayse.api.call('createBooking', {
      body: { resourceId: deskId, start: end, end: at('2026-12-01T17:00:00Z') },
    });
    const list = await ayse.api.call('listBookings', {
      query: { from: at('2026-12-01T00:00:00Z'), to: at('2026-12-02T00:00:00Z'), kind: 'desk' },
    });
    expect(list.items.map((b) => [b.user.email, b.title])).toEqual([
      ['mert@milvasoft.com', null],
      ['ayse@milvasoft.com', 'Masa A-12'],
    ]);
    // Someone else's booking is not theirs to cancel; their own goes with its event.
    await expectCode(
      ayse.api.call('cancelBooking', { params: { bookingId: mine.id } }),
      403,
      'forbidden',
    );
    await mert.api.call('cancelBooking', { params: { bookingId: mine.id } });
    await expectCode(
      mert.api.call('getCalendarEvent', { params: { eventId: mine.eventId! } }),
      404,
    );
  });

  it('puts a room on a meeting, moves it with the meeting and frees it', async () => {
    const free = await owner.api.call('getBookingAvailability', {
      query: { from: at('2026-12-02T09:00:00Z'), to: at('2026-12-02T10:00:00Z'), capacity: 5 },
    });
    // The smallest room that fits comes first.
    expect(free.suggestedId).toBe(roomId);
    expect(free.items.map((i) => [i.resource.name, i.free, i.fits])).toEqual([
      ['Boğaz', true, true],
      ['Galata', true, true],
    ]);

    const meeting = await owner.api.call('createCalendarEvent', {
      body: {
        calendarId,
        title: 'Planlama',
        allDay: false,
        start: at('2026-12-02T09:00:00Z'),
        end: at('2026-12-02T10:00:00Z'),
        roomId,
      },
    });
    expect(meeting.room).toMatchObject({ resourceId: roomId, name: 'Boğaz', status: 'confirmed' });
    expect(meeting.room?.checkIn).toEqual({
      opensAt: at('2026-12-02T08:45:00Z'),
      closesAt: at('2026-12-02T09:15:00Z'),
    });
    expect(meeting.location).toBe('Boğaz · 3. kat');

    // Taken: the second meeting is refused as a whole.
    const before = await owner.api.call('listCalendarOccurrences', {
      query: { from: at('2026-12-02T00:00:00Z'), to: at('2026-12-03T00:00:00Z') },
    });
    await expectCode(
      owner.api.call('createCalendarEvent', {
        body: {
          calendarId,
          title: 'Çakışan',
          allDay: false,
          start: at('2026-12-02T09:30:00Z'),
          end: at('2026-12-02T10:30:00Z'),
          roomId,
        },
      }),
      409,
      'booking_conflict',
    );
    const after = await owner.api.call('listCalendarOccurrences', {
      query: { from: at('2026-12-02T00:00:00Z'), to: at('2026-12-03T00:00:00Z') },
    });
    expect(after.items).toHaveLength(before.items.length);

    // The editor does not count the meeting's own booking as a clash.
    const own = await owner.api.call('getBookingAvailability', {
      query: {
        from: at('2026-12-02T09:00:00Z'),
        to: at('2026-12-02T10:00:00Z'),
        eventId: meeting.id,
      },
    });
    expect(own.items.find((i) => i.resource.id === roomId)?.free).toBe(true);

    // Moving the meeting moves the room; into someone else's time is refused.
    const moved = await owner.api.call('updateCalendarEvent', {
      params: { eventId: meeting.id },
      body: { allDay: false, start: at('2026-12-02T11:00:00Z'), end: at('2026-12-02T12:00:00Z') },
    });
    expect(moved.room?.status).toBe('confirmed');
    const theirs = await ayse.api.call('createBooking', {
      body: {
        resourceId: roomId,
        start: at('2026-12-02T13:00:00Z'),
        end: at('2026-12-02T14:00:00Z'),
      },
    });
    await expectCode(
      owner.api.call('updateCalendarEvent', {
        params: { eventId: meeting.id },
        body: {
          allDay: false,
          start: at('2026-12-02T13:30:00Z'),
          end: at('2026-12-02T14:30:00Z'),
        },
      }),
      409,
      'booking_conflict',
    );
    const unchanged = await owner.api.call('getCalendarEvent', { params: { eventId: meeting.id } });
    expect(unchanged.start).toBe(at('2026-12-02T11:00:00Z'));

    // Series and all-day events take no room.
    await expectCode(
      owner.api.call('updateCalendarEvent', {
        params: { eventId: meeting.id },
        body: { rrule: 'FREQ=WEEKLY' },
      }),
      422,
      'booking_room_unsupported',
    );

    // Another room, then none; deleting the meeting frees it.
    const swapped = await owner.api.call('updateCalendarEvent', {
      params: { eventId: meeting.id },
      body: { roomId: bigRoomId },
    });
    expect(swapped.room?.name).toBe('Galata');
    const none = await owner.api.call('updateCalendarEvent', {
      params: { eventId: meeting.id },
      body: { roomId: null },
    });
    expect(none.room).toBeNull();
    await owner.api.call('updateCalendarEvent', {
      params: { eventId: meeting.id },
      body: { roomId },
    });
    await owner.api.call('deleteCalendarEvent', {
      params: { eventId: meeting.id },
      query: {},
    });
    const freed = await owner.api.call('getBookingAvailability', {
      query: { from: at('2026-12-02T11:00:00Z'), to: at('2026-12-02T12:00:00Z') },
    });
    expect(freed.items.find((i) => i.resource.id === roomId)?.free).toBe(true);
    await ayse.api.call('cancelBooking', { params: { bookingId: theirs.id } });
  });

  it('frees a room nobody checked in to, and keeps one that was claimed', async () => {
    const soon = new Date(Date.now() + 5 * 60_000);
    soon.setSeconds(0, 0);
    const later = new Date(soon.getTime() + 60 * 60_000);
    const claimed = await mert.api.call('createBooking', {
      body: { resourceId: roomId, start: soon.toISOString(), end: later.toISOString() },
    });
    expect(claimed.permissions.checkIn).toBe(true);
    // Only the booker checks in.
    await expectCode(ayse.api.call('checkInBooking', { params: { bookingId: claimed.id } }), 403);
    const done = await mert.api.call('checkInBooking', { params: { bookingId: claimed.id } });
    expect(done.status).toBe('checked_in');

    const far = new Date(soon.getTime() + 3 * 3_600_000);
    const unclaimed = await ayse.api.call('createBooking', {
      body: {
        resourceId: roomId,
        start: far.toISOString(),
        end: new Date(far.getTime() + 3_600_000).toISOString(),
      },
    });
    // Too early to check in.
    await expectCode(
      ayse.api.call('checkInBooking', { params: { bookingId: unclaimed.id } }),
      409,
      'booking_check_in_closed',
    );
    // Sixteen minutes after the start nobody came: freed, its event gone.
    expect(await releaseUnclaimed(app.deps.db, new Date(far.getTime() + 16 * 60_000))).toBe(1);
    const list = await ayse.api.call('listBookings', {
      query: { from: soon.toISOString(), to: new Date(far.getTime() + 7_200_000).toISOString() },
    });
    expect(list.items.map((b) => [b.id, b.status])).toEqual([
      [claimed.id, 'checked_in'],
      [unclaimed.id, 'released'],
    ]);
    await expectCode(
      ayse.api.call('getCalendarEvent', { params: { eventId: unclaimed.eventId! } }),
      404,
    );
  });

  it('removes a resource with its future bookings', async () => {
    const b = await mert.api.call('createBooking', {
      body: {
        resourceId: bigRoomId,
        start: at('2026-12-10T09:00:00Z'),
        end: at('2026-12-10T10:00:00Z'),
      },
    });
    await owner.api.call('deleteBookingResource', { params: { resourceId: bigRoomId } });
    await expectCode(mert.api.call('getCalendarEvent', { params: { eventId: b.eventId! } }), 404);
    const rooms = await mert.api.call('listBookingResources', { query: { kind: 'room' } });
    expect(rooms.items.map((r) => r.name)).toEqual(['Boğaz']);
    // Switched off: listed for admins only, not bookable.
    await owner.api.call('updateBookingResource', {
      params: { resourceId: roomId },
      body: { active: false },
    });
    expect(
      (await mert.api.call('listBookingResources', { query: { kind: 'room' } })).items,
    ).toEqual([]);
    expect(
      (await owner.api.call('listBookingResources', { query: { kind: 'room', all: 'true' } }))
        .items,
    ).toHaveLength(1);
    await expectCode(
      mert.api.call('createBooking', {
        body: {
          resourceId: roomId,
          start: at('2026-12-11T09:00:00Z'),
          end: at('2026-12-11T10:00:00Z'),
        },
      }),
      409,
      'booking_unavailable',
    );
  });
});
