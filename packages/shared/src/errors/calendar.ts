/** Calendar module error codes; translations go to packages/i18n/src/locales/{tr,en}/errors/calendar.json. */
export const CALENDAR_ERROR_CODES = [
  'calendar_read_only',
  'calendar_not_team',
  'calendar_last_owner',
  'calendar_event_not_recurring',
  'calendar_occurrence_unknown',
  'calendar_ics_invalid',
  'calendar_integration_off',
  'calendar_oauth_failed',
  'calendar_account_revoked',
  'calendar_external_failed',
  'calendar_external_unsupported',
  'calendar_exchange_auth_failed',
  'booking_conflict',
  'booking_unavailable',
  'booking_room_unsupported',
  'booking_check_in_closed',
] as const;

export const CALENDAR_ERROR_STATUS: Record<(typeof CALENDAR_ERROR_CODES)[number], number> = {
  /** The caller may read the calendar but not change it. */
  calendar_read_only: 403,
  /** Members and deletion are for team calendars. */
  calendar_not_team: 409,
  /** A team calendar keeps at least one owner. */
  calendar_last_owner: 409,
  /** this/following on an event without a recurrence rule. */
  calendar_event_not_recurring: 409,
  /** The recurrenceId is not an occurrence of the series. */
  calendar_occurrence_unknown: 404,
  /** The file is not iCalendar or holds no events. */
  calendar_ics_invalid: 422,
  /** The admin has not set up (or switched off) this provider. */
  calendar_integration_off: 409,
  /** Connecting failed (cancelled, expired state, the provider refused the code). */
  calendar_oauth_failed: 400,
  /** The provider withdrew access; connect the account again. */
  calendar_account_revoked: 409,
  /** The provider rejected the change or could not be reached. */
  calendar_external_failed: 502,
  /** Not possible on a mirrored calendar (this-and-following, moving between accounts…). */
  calendar_external_unsupported: 409,
  /** Exchange refused the sign-in when connecting. */
  calendar_exchange_auth_failed: 422,
  /** The resource is booked for (part of) that time. */
  booking_conflict: 409,
  /** The resource was switched off or removed. */
  booking_unavailable: 409,
  /** Rooms go on one-off timed events (not series, all-day or mirrored calendars). */
  booking_room_unsupported: 422,
  /** Check-in opens 15 minutes before the start and closes when the grace time ends. */
  booking_check_in_closed: 409,
};
