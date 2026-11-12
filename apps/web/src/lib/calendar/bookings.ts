import {
  addDaysToDate,
  type BookingAvailabilityQuery,
  type BookingKind,
  type BookingsQuery,
} from '@crewhall/shared';
import { queryOptions } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { hhmm, minuteOf, todayIn } from './time';

/** Room and desk booking (sonraki-isler): under the calendar keys, so calendar changes refresh them. */
export const bookingKeys = {
  all: ['calendar', 'bookings'] as const,
  resources: (kind?: BookingKind, all?: boolean) =>
    ['calendar', 'bookings', 'resources', kind ?? '', all ? 'all' : ''] as const,
  list: (q: BookingsQuery) => ['calendar', 'bookings', 'list', q] as const,
  availability: (q: BookingAvailabilityQuery) =>
    ['calendar', 'bookings', 'availability', q] as const,
};

/** The day the booking page opens on: today, or tomorrow once today's working hours are over. */
export function firstBookableDate(tz: string, now: number, workdayEnd: number) {
  const today = todayIn(tz, now);
  return minuteOf(new Date(now).toISOString(), tz) >= workdayEnd * 60
    ? addDaysToDate(today, 1)
    : today;
}

/**
 * The times a new booking starts with ("HH:mm"): a desk for the working hours, a room for an
 * hour. Today nothing starts in the past: from the next quarter hour on.
 */
export function bookingDefaults(
  kind: BookingKind,
  date: string,
  tz: string,
  now: number,
  workday: { start: number; end: number },
) {
  const next =
    todayIn(tz, now) === date
      ? Math.ceil((minuteOf(new Date(now).toISOString(), tz) + 1) / 15) * 15
      : 0;
  const last = 23 * 60 + 45;
  if (kind === 'desk') {
    const start = Math.max(workday.start * 60, next);
    const end = workday.end * 60;
    if (start < end) return { start: hhmm(start), end: hhmm(end) };
    // After hours today: the next hour.
    return { start: hhmm(Math.min(next, last - 15)), end: hhmm(Math.min(next + 60, last)) };
  }
  const start = Math.min(next || 9 * 60, last - 15);
  return { start: hhmm(start), end: hhmm(Math.min(start + 60, last)) };
}

export const resourcesQuery = (kind?: BookingKind, all?: boolean) =>
  queryOptions({
    queryKey: bookingKeys.resources(kind, all),
    queryFn: ({ signal }) =>
      api.call('listBookingResources', {
        query: { kind, all: all ? 'true' : undefined },
        signal,
      }),
  });

export const bookingsQuery = (q: BookingsQuery) =>
  queryOptions({
    queryKey: bookingKeys.list(q),
    queryFn: ({ signal }) => api.call('listBookings', { query: q, signal }),
  });

export const availabilityQuery = (q: BookingAvailabilityQuery) =>
  queryOptions({
    queryKey: bookingKeys.availability(q),
    queryFn: ({ signal }) => api.call('getBookingAvailability', { query: q, signal }),
    staleTime: 15_000,
  });
