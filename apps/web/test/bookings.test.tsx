import { Toaster } from '@crewhall/ui';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bookingDefaults, firstBookableDate } from '@/lib/calendar/bookings';
import { bookingsMockState } from '@/mocks/bookings';
import { calendarMockState, resetCalendarMock } from '@/mocks/calendar';
import { USER } from '@/mocks/seed';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

const TZ = 'Europe/Istanbul';
const WORKDAY = { start: 9, end: 18 };
// Thursday 22 October 2026 in Istanbul (UTC+3).
const NOON = Date.parse('2026-10-22T09:00:00Z');
const EVENING = Date.parse('2026-10-22T17:30:00Z');

describe('booking defaults', () => {
  it('opens on tomorrow once the working hours are over', () => {
    expect(firstBookableDate(TZ, NOON, 18)).toBe('2026-10-22');
    expect(firstBookableDate(TZ, EVENING, 18)).toBe('2026-10-23');
  });

  it('starts nothing in the past', () => {
    // 12:00 today: a desk from the next quarter hour to the end of the day, a room for an hour.
    expect(bookingDefaults('desk', '2026-10-22', TZ, NOON, WORKDAY)).toEqual({
      start: '12:15',
      end: '18:00',
    });
    expect(bookingDefaults('room', '2026-10-22', TZ, NOON, WORKDAY)).toEqual({
      start: '12:15',
      end: '13:15',
    });
    // Another day: the whole working day, a room at nine.
    expect(bookingDefaults('desk', '2026-10-23', TZ, NOON, WORKDAY)).toEqual({
      start: '09:00',
      end: '18:00',
    });
    expect(bookingDefaults('room', '2026-10-23', TZ, NOON, WORKDAY)).toEqual({
      start: '09:00',
      end: '10:00',
    });
    // After hours today (picked by hand): the next hour.
    expect(bookingDefaults('desk', '2026-10-22', TZ, EVENING, WORKDAY)).toEqual({
      start: '20:45',
      end: '21:45',
    });
  });
});

/** Room and desk booking screens (sonraki-isler). */
describe('room and desk booking', () => {
  beforeEach(() => {
    // A fixed "now" (noon in Istanbul): the screens default to times around it.
    vi.useFakeTimers({ toFake: ['Date'], now: NOON });
    resetCalendarMock();
    signedInAs(USER.bugra);
    render(<Toaster />);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('lets an admin add a room', async () => {
    renderApp('/admin/bookings');
    const user = userEvent.setup();
    const page = await screen.findByTestId('bookings-admin');
    expect(await within(page).findByRole('listitem', { name: 'Boğaz' })).toBeInTheDocument();
    await user.click(within(page).getByRole('button', { name: 'Kaynak ekle' }));
    const dialog = await screen.findByRole('dialog', { name: 'Kaynak ekle' });
    await user.type(within(dialog).getByLabelText('Ad'), 'Kadıköy');
    await user.type(within(dialog).getByLabelText('Kapasite'), '4');
    await user.type(within(dialog).getByLabelText('Donanım'), 'Ekran, Beyaz tahta');
    await user.click(within(dialog).getByRole('switch', { name: 'Giriş onayı iste' }));
    await user.click(within(dialog).getByRole('button', { name: 'Kaydet' }));
    expect(await within(page).findByRole('listitem', { name: 'Kadıköy' })).toBeInTheDocument();
    expect(bookingsMockState().resources.find((r) => r.name === 'Kadıköy')).toMatchObject({
      kind: 'room',
      capacity: 4,
      equipment: ['Ekran', 'Beyaz tahta'],
      checkInRequired: true,
    });
  });

  it('books a desk for the working day, lists it and cancels it', async () => {
    renderApp('/bookings');
    const user = userEvent.setup();
    const page = await screen.findByTestId('bookings-page');
    await user.click(within(page).getByRole('radio', { name: 'Masalar' }));
    const desk = await within(page).findByRole('listitem', { name: 'Masa A-12' });
    await user.click(within(desk).getByRole('button', { name: 'Masa A-12 rezervasyonu' }));
    const dialog = await screen.findByRole('dialog', { name: 'Masa A-12 rezervasyonu' });
    await user.click(within(dialog).getByRole('button', { name: 'Rezerve et' }));
    expect(await screen.findByText('Masa A-12 rezerve edildi')).toBeInTheDocument();
    const booking = bookingsMockState().bookings[0]!;
    // From the next quarter hour to the end of the working day.
    expect(booking).toMatchObject({
      userId: USER.bugra,
      status: 'confirmed',
      ownEvent: true,
      start: '2026-10-22T09:15:00.000Z',
      end: '2026-10-22T15:00:00.000Z',
    });
    // The booking is an event in the person's calendar.
    expect(calendarMockState().events.find((e) => e.id === booking.eventId)).toMatchObject({
      title: 'Masa A-12',
      location: 'Masa A-12 · 2. kat',
      busy: false,
    });
    const mine = screen.getByTestId('my-bookings');
    const row = await within(mine).findByRole('listitem', { name: 'Masa A-12' });
    await user.click(within(row).getByRole('button', { name: 'Rezervasyonu iptal et' }));
    await waitFor(() => expect(bookingsMockState().bookings[0]!.status).toBe('cancelled'));
    expect(calendarMockState().events.find((e) => e.id === booking.eventId)?.deleted).toBe(true);
  });

  it('suggests a free room for a new meeting and books it', async () => {
    renderApp('/calendar?view=week');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Yeni etkinlik' }));
    const dialog = await screen.findByRole('dialog', { name: 'Yeni etkinlik' });
    await user.type(within(dialog).getByLabelText('Başlık'), 'Planlama');
    // Boğaz (8 people) is the smallest free room that fits.
    await user.click(await within(dialog).findByRole('button', { name: 'Önerilen: Boğaz' }));
    await user.click(within(dialog).getByRole('button', { name: 'Oluştur' }));
    await waitFor(() =>
      expect(bookingsMockState().bookings).toEqual([
        expect.objectContaining({
          resourceId: '0190f0a0-0000-7000-8000-000000000b01',
          ownEvent: false,
        }),
      ]),
    );
    const event = calendarMockState().events.find((e) => e.title === 'Planlama')!;
    expect(event.location).toBe('Boğaz · 3. kat');
  });

  it('after the working hours books tomorrow', async () => {
    vi.setSystemTime(EVENING);
    renderApp('/bookings');
    const user = userEvent.setup();
    const page = await screen.findByTestId('bookings-page');
    await user.click(within(page).getByRole('radio', { name: 'Masalar' }));
    const desk = await within(page).findByRole('listitem', { name: 'Masa A-12' });
    await user.click(within(desk).getByRole('button', { name: 'Masa A-12 rezervasyonu' }));
    const dialog = await screen.findByRole('dialog', { name: 'Masa A-12 rezervasyonu' });
    await user.click(within(dialog).getByRole('button', { name: 'Rezerve et' }));
    await waitFor(() =>
      expect(bookingsMockState().bookings[0]).toMatchObject({
        start: '2026-10-23T06:00:00.000Z',
        end: '2026-10-23T15:00:00.000Z',
      }),
    );
    // Upcoming, so it is listed.
    const mine = screen.getByTestId('my-bookings');
    expect(await within(mine).findByRole('listitem', { name: 'Masa A-12' })).toBeInTheDocument();
  });
});
