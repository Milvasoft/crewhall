import { sql } from 'drizzle-orm';
import { boolean, index, integer, pgEnum, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth';
import { calendarEvents } from './calendar';
import { organizations } from './org';
import { id, textTr, timestamps, tz } from './types';

/**
 * Room and desk booking (sonraki-isler, new features): resources the admin defines and the
 * bookings people make. Every booking carries a calendar event (the meeting it was made for, or
 * one created in the booker's calendar), so bookings show in the views, .ics and CalDAV. There
 * is no floor plan: lists and the calendar.
 */

export const bookingKind = pgEnum('booking_kind', ['room', 'desk']);

/** released: not checked in within the grace minutes, freed automatically. */
export const bookingStatus = pgEnum('booking_status', [
  'confirmed',
  'checked_in',
  'released',
  'cancelled',
]);

export const bookingResources = pgTable(
  'booking_resources',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    kind: bookingKind('kind').notNull(),
    name: textTr('name').notNull(),
    /** Building, floor, area as free text ("İstanbul · 3. kat"). */
    location: text('location'),
    capacity: integer('capacity'),
    equipment: text('equipment')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    description: text('description'),
    checkInRequired: boolean('check_in_required').notNull().default(false),
    checkInGraceMinutes: integer('check_in_grace_minutes').notNull().default(15),
    active: boolean('active').notNull().default(true),
    ...timestamps(),
  },
  (t) => [index('booking_resources_org_idx').on(t.orgId, t.kind)],
);

export const bookings = pgTable(
  'bookings',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    resourceId: uuid('resource_id')
      .notNull()
      .references(() => bookingResources.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The calendar event of the booking (a meeting's event, or one made for the booking). */
    eventId: uuid('event_id').references(() => calendarEvents.id, { onDelete: 'set null' }),
    /** The event was created for the booking and goes with it. */
    ownEvent: boolean('own_event').notNull().default(false),
    startsAt: tz('starts_at').notNull(),
    endsAt: tz('ends_at').notNull(),
    status: bookingStatus('status').notNull().default('confirmed'),
    checkedInAt: tz('checked_in_at'),
    endedAt: tz('ended_at'),
    ...timestamps(),
  },
  (t) => [
    index('bookings_resource_idx').on(t.resourceId, t.startsAt),
    index('bookings_user_idx').on(t.userId, t.startsAt),
    index('bookings_event_idx').on(t.eventId),
  ],
);
