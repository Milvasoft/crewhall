import { z } from 'zod';
import { Id, Timestamp } from './common';
import { UserSummary } from './org';

/**
 * Room and desk booking (sonraki-isler, new features; part of the calendar module). The admin
 * defines rooms (capacity, equipment) and shared desks; people book them from the calendar (a
 * meeting's room) or the booking page. Overlaps are refused; a resource that wants a check-in
 * is freed when nobody checks in within the grace minutes. No floor plan.
 */

export const BookingKind = z.enum(['room', 'desk']);
export type BookingKind = z.infer<typeof BookingKind>;

export const BookingStatus = z.enum(['confirmed', 'checked_in', 'released', 'cancelled']);
export type BookingStatus = z.infer<typeof BookingStatus>;

export const BookingResource = z.object({
  id: Id,
  kind: BookingKind,
  name: z.string(),
  location: z.string().nullable(),
  capacity: z.number().int().nullable(),
  equipment: z.array(z.string()),
  description: z.string().nullable(),
  checkInRequired: z.boolean(),
  checkInGraceMinutes: z.number().int(),
  active: z.boolean(),
});
export type BookingResource = z.infer<typeof BookingResource>;

const text = (max: number) => z.string().trim().max(max);

export const CreateBookingResource = z.object({
  kind: BookingKind,
  name: text(120).min(1),
  location: text(200).nullable().optional(),
  capacity: z.number().int().min(1).max(10_000).nullable().optional(),
  equipment: z.array(text(60).min(1)).max(30).optional(),
  description: text(1000).nullable().optional(),
  checkInRequired: z.boolean().optional(),
  checkInGraceMinutes: z.number().int().min(5).max(120).optional(),
});
export type CreateBookingResource = z.input<typeof CreateBookingResource>;

export const UpdateBookingResource = CreateBookingResource.omit({ kind: true })
  .partial()
  .extend({ active: z.boolean().optional() });
export type UpdateBookingResource = z.input<typeof UpdateBookingResource>;

export const BookingResourcesQuery = z.object({
  kind: BookingKind.optional(),
  /** Admins: inactive ones too. */
  all: z.stringbool().optional(),
});

export const Booking = z.object({
  id: Id,
  resource: BookingResource.pick({ id: true, kind: true, name: true, location: true }),
  user: UserSummary,
  /** The calendar event of the booking. */
  eventId: Id.nullable(),
  /** The event's title (only for the booker and admins; others see the resource as busy). */
  title: z.string().nullable(),
  start: Timestamp,
  end: Timestamp,
  status: BookingStatus,
  checkedInAt: Timestamp.nullable(),
  /** Check-in window when the resource wants one: 15 minutes before the start to the grace end. */
  checkIn: z.object({ opensAt: Timestamp, closesAt: Timestamp }).nullable(),
  permissions: z.object({ cancel: z.boolean(), checkIn: z.boolean() }),
});
export type Booking = z.infer<typeof Booking>;

export const BookingsQuery = z.object({
  from: Timestamp,
  to: Timestamp,
  resourceId: Id.optional(),
  kind: BookingKind.optional(),
  /** Only the caller's bookings. */
  mine: z.stringbool().optional(),
});
export type BookingsQuery = z.input<typeof BookingsQuery>;

export const CreateBooking = z
  .object({
    resourceId: Id,
    start: Timestamp,
    end: Timestamp,
    /** Title of the event made for the booking; default: the resource's name. */
    title: text(200).optional(),
  })
  .refine((v) => Date.parse(v.end) > Date.parse(v.start), {
    path: ['end'],
    message: 'end before start',
  });
export type CreateBooking = z.input<typeof CreateBooking>;

/** Free rooms for a time (the event editor's suggestion), best fit first. */
export const BookingAvailabilityQuery = z.object({
  from: Timestamp,
  to: Timestamp,
  kind: BookingKind.default('room'),
  /** People expected: rooms that fit come first. */
  capacity: z.coerce.number().int().min(1).max(10_000).optional(),
  /** The event being edited: its own booking does not count as a clash. */
  eventId: Id.optional(),
});
export type BookingAvailabilityQuery = z.input<typeof BookingAvailabilityQuery>;

export const BookingAvailability = z.object({
  items: z.array(
    z.object({
      resource: BookingResource,
      free: z.boolean(),
      /** Fits the capacity asked for (true when no capacity was asked). */
      fits: z.boolean(),
    }),
  ),
  /** The first free room that fits (the suggestion); null when none. */
  suggestedId: Id.nullable(),
});
export type BookingAvailability = z.infer<typeof BookingAvailability>;

/** On a calendar event (absent on older servers). */
export const EventRoom = z.object({
  resourceId: Id,
  name: z.string(),
  location: z.string().nullable(),
  bookingId: Id,
  status: BookingStatus,
  checkIn: z.object({ opensAt: Timestamp, closesAt: Timestamp }).nullable(),
});
export type EventRoom = z.infer<typeof EventRoom>;
