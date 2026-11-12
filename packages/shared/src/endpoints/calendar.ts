import { def, Empty, items, type EndpointDef } from '../endpoint-def';
import {
  CalDavInfo,
  Calendar,
  CalendarAccount,
  CalendarAccounts,
  CalendarIntegration,
  ConnectExchangeAccount,
  CalendarIntegrations,
  CalendarEvent,
  CalendarEventVersion,
  CalendarMember,
  CalendarOccurrence,
  CalendarSettings,
  CreateCalendar,
  CreateCalendarEvent,
  DeleteCalendarEventQuery,
  EventQuery,
  FreeBusy,
  FreeBusyQuery,
  ImportIcs,
  ImportIcsResult,
  OccurrencesQuery,
  RespondCalendarEvent,
  SetCalendarMember,
  UpdateCalendar,
  UpdateCalendarEvent,
  UpdateCalendarAccount,
  UpdateCalendarIntegration,
  UpdateCalendarSettings,
} from '../schemas/calendar';
import {
  Booking,
  BookingAvailability,
  BookingAvailabilityQuery,
  BookingResource,
  BookingResourcesQuery,
  BookingsQuery,
  CreateBooking,
  CreateBookingResource,
  UpdateBookingResource,
} from '../schemas/bookings';

/**
 * Calendar module contract (roadmap 14). Only the calendar session edits this file; see
 * docs/contracts/moduller.md. Export (.ics) and CalDAV are outside the JSON table
 * (CALENDAR_RAW_PATHS).
 */
export const calendarEndpoints = {
  // ---- Calendars -------------------------------------------------------------------------
  /** Personal, team and space calendars the caller can read (personal and space ones are created on demand). */
  listCalendars: def({
    method: 'GET',
    path: '/api/v1/calendar/calendars',
    auth: 'session',
    response: items(Calendar),
  }),
  /** A team calendar; the creator is its owner. */
  createCalendar: def({
    method: 'POST',
    path: '/api/v1/calendar/calendars',
    auth: 'session',
    body: CreateCalendar,
    response: Calendar,
  }),
  updateCalendar: def({
    method: 'PATCH',
    path: '/api/v1/calendar/calendars/:calendarId',
    auth: 'session',
    body: UpdateCalendar,
    response: Calendar,
  }),
  /** Team calendars only; their events go with them. */
  deleteCalendar: def({
    method: 'DELETE',
    path: '/api/v1/calendar/calendars/:calendarId',
    auth: 'session',
    response: Empty,
  }),
  listCalendarMembers: def({
    method: 'GET',
    path: '/api/v1/calendar/calendars/:calendarId/members',
    auth: 'session',
    response: items(CalendarMember),
  }),
  setCalendarMember: def({
    method: 'PUT',
    path: '/api/v1/calendar/calendars/:calendarId/members/:userId',
    auth: 'session',
    body: SetCalendarMember,
    response: CalendarMember,
  }),
  removeCalendarMember: def({
    method: 'DELETE',
    path: '/api/v1/calendar/calendars/:calendarId/members/:userId',
    auth: 'session',
    response: Empty,
  }),
  /** Adds the events of an .ics file; events with a known UID are updated. */
  importCalendarIcs: def({
    method: 'POST',
    path: '/api/v1/calendar/calendars/:calendarId/import',
    auth: 'session',
    body: ImportIcs,
    response: ImportIcsResult,
  }),

  // ---- Views -----------------------------------------------------------------------------
  /** Day, week, month and agenda: events expanded in range plus linked meetings and cards. */
  listCalendarOccurrences: def({
    method: 'GET',
    path: '/api/v1/calendar/occurrences',
    auth: 'session',
    query: OccurrencesQuery,
    response: items(CalendarOccurrence),
  }),
  /** Busy intervals of org members (no titles), for "uygunluk" while inviting. */
  getCalendarFreeBusy: def({
    method: 'GET',
    path: '/api/v1/calendar/free-busy',
    auth: 'session',
    query: FreeBusyQuery,
    response: FreeBusy,
  }),

  // ---- Events ----------------------------------------------------------------------------
  createCalendarEvent: def({
    method: 'POST',
    path: '/api/v1/calendar/events',
    auth: 'session',
    body: CreateCalendarEvent,
    response: CalendarEvent,
  }),
  getCalendarEvent: def({
    method: 'GET',
    path: '/api/v1/calendar/events/:eventId',
    auth: 'session',
    query: EventQuery,
    response: CalendarEvent,
  }),
  /** Mirrored calendars: versions overwritten by a conflict, newest first. */
  listCalendarEventVersions: def({
    method: 'GET',
    path: '/api/v1/calendar/events/:eventId/versions',
    auth: 'session',
    response: items(CalendarEventVersion),
  }),
  /** Whole series, one occurrence (`this`) or the rest of the series (`following`). */
  updateCalendarEvent: def({
    method: 'PATCH',
    path: '/api/v1/calendar/events/:eventId',
    auth: 'session',
    body: UpdateCalendarEvent,
    response: CalendarEvent,
  }),
  deleteCalendarEvent: def({
    method: 'DELETE',
    path: '/api/v1/calendar/events/:eventId',
    auth: 'session',
    query: DeleteCalendarEventQuery,
    response: Empty,
  }),
  /** Kabul / ret / belki; the answer covers the whole series. */
  respondCalendarEvent: def({
    method: 'POST',
    path: '/api/v1/calendar/events/:eventId/respond',
    auth: 'session',
    body: RespondCalendarEvent,
    response: CalendarEvent,
  }),

  // ---- Settings --------------------------------------------------------------------------
  getCalendarSettings: def({
    method: 'GET',
    path: '/api/v1/calendar/settings',
    auth: 'session',
    response: CalendarSettings,
  }),
  updateCalendarSettings: def({
    method: 'PATCH',
    path: '/api/v1/calendar/settings',
    auth: 'session',
    body: UpdateCalendarSettings,
    response: CalendarSettings,
  }),
  getCalDavInfo: def({
    method: 'GET',
    path: '/api/v1/calendar/caldav',
    auth: 'session',
    response: CalDavInfo,
  }),

  // ---- Connected accounts (Google / Microsoft) --------------------------------------------
  /** The caller's connected accounts and the providers the org offers. Connecting is a redirect (CALENDAR_RAW_PATHS.oauthStart). */
  listCalendarAccounts: def({
    method: 'GET',
    path: '/api/v1/calendar/accounts',
    auth: 'session',
    response: CalendarAccounts,
  }),
  /** Syncs the account now (normally every few minutes in the background). */
  syncCalendarAccount: def({
    method: 'POST',
    path: '/api/v1/calendar/accounts/:accountId/sync',
    auth: 'session',
    response: CalendarAccount,
  }),
  /** "Yalnız meşgul/boş": switching starts a full sync that drops or brings back the details. */
  updateCalendarAccount: def({
    method: 'PATCH',
    path: '/api/v1/calendar/accounts/:accountId',
    auth: 'session',
    body: UpdateCalendarAccount,
    response: CalendarAccount,
  }),
  /** On-premises Exchange: no OAuth there, the person signs in here. */
  connectExchangeAccount: def({
    method: 'POST',
    path: '/api/v1/calendar/accounts/exchange',
    auth: 'session',
    body: ConnectExchangeAccount,
    response: CalendarAccount,
  }),
  /** Disconnects: its calendars leave Crewhall; nothing changes at the provider. */
  deleteCalendarAccount: def({
    method: 'DELETE',
    path: '/api/v1/calendar/accounts/:accountId',
    auth: 'session',
    response: Empty,
  }),

  // ---- Admin: provider OAuth clients -------------------------------------------------------
  getCalendarIntegrations: def({
    method: 'GET',
    path: '/api/v1/calendar/admin/integrations',
    auth: 'session',
    response: CalendarIntegrations,
  }),
  updateCalendarIntegration: def({
    method: 'PUT',
    path: '/api/v1/calendar/admin/integrations/:provider',
    auth: 'session',
    body: UpdateCalendarIntegration,
    response: CalendarIntegration,
  }),
  // ---- Room and desk booking (sonraki-isler) -----------------------------------------------
  listBookingResources: def({
    method: 'GET',
    path: '/api/v1/bookings/resources',
    auth: 'session',
    query: BookingResourcesQuery,
    response: items(BookingResource),
  }),
  /** Admins (org settings). */
  createBookingResource: def({
    method: 'POST',
    path: '/api/v1/bookings/resources',
    auth: 'session',
    body: CreateBookingResource,
    response: BookingResource,
  }),
  updateBookingResource: def({
    method: 'PATCH',
    path: '/api/v1/bookings/resources/:resourceId',
    auth: 'session',
    body: UpdateBookingResource,
    response: BookingResource,
  }),
  /** Removes the resource; its future bookings are cancelled (their own events go too). */
  deleteBookingResource: def({
    method: 'DELETE',
    path: '/api/v1/bookings/resources/:resourceId',
    auth: 'session',
    response: Empty,
  }),
  /** Bookings in a range (the booking page's day and week), cancelled ones left out. */
  listBookings: def({
    method: 'GET',
    path: '/api/v1/bookings',
    auth: 'session',
    query: BookingsQuery,
    response: items(Booking),
  }),
  /** Which rooms (or desks) are free for a time; the event editor suggests one. */
  getBookingAvailability: def({
    method: 'GET',
    path: '/api/v1/bookings/availability',
    auth: 'session',
    query: BookingAvailabilityQuery,
    response: BookingAvailability,
  }),
  /** Books a resource; an event for it goes into the caller's calendar. */
  createBooking: def({
    method: 'POST',
    path: '/api/v1/bookings',
    auth: 'session',
    body: CreateBooking,
    response: Booking,
  }),
  cancelBooking: def({
    method: 'DELETE',
    path: '/api/v1/bookings/:bookingId',
    auth: 'session',
    response: Empty,
  }),
  checkInBooking: def({
    method: 'POST',
    path: '/api/v1/bookings/:bookingId/check-in',
    auth: 'session',
    response: Booking,
  }),
  /** Google: reads the Workspace directory now (it also runs every hour). */
  syncWorkspaceDirectory: def({
    method: 'POST',
    path: '/api/v1/calendar/admin/integrations/google/directory-sync',
    auth: 'session',
    response: CalendarIntegration,
  }),
} satisfies Record<string, EndpointDef>;
