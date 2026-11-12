/** Meet module error codes; translations go to packages/i18n/src/locales/{tr,en}/errors/meet.json. */
export const MEET_ERROR_CODES = [
  'meet_unavailable',
  'meet_ended',
  'meet_link_expired',
  'meet_guests_disabled',
  'meet_lobby_retry_later',
  'meet_not_moderator',
  'meet_recording_forbidden',
  'meet_recording_active',
  'meet_recording_unavailable',
  'meet_not_live',
  'meet_slug_taken',
  'meet_webhook_invalid',
  'meet_call_unavailable',
  'meet_call_over',
  'meet_remote_control_off',
  'meet_room_live',
  'meet_managed_by_calendar',
] as const;

export const MEET_ERROR_STATUS: Record<(typeof MEET_ERROR_CODES)[number], number> = {
  /** LiveKit is not configured or not reachable. */
  meet_unavailable: 503,
  meet_ended: 410,
  meet_link_expired: 410,
  meet_guests_disabled: 403,
  meet_lobby_retry_later: 429,
  meet_not_moderator: 403,
  meet_recording_forbidden: 403,
  meet_recording_active: 409,
  /** Egress or storage is not configured, or the space has no room left. */
  meet_recording_unavailable: 409,
  meet_not_live: 409,
  meet_slug_taken: 409,
  meet_webhook_invalid: 401,
  /** Calls are for direct and group conversations you belong to. */
  meet_call_unavailable: 409,
  /** The call already ended or stopped ringing for you. */
  meet_call_over: 410,
  /** Remote control is turned off for the org or this meeting. */
  meet_remote_control_off: 409,
  /** A room with people in it cannot be deleted: end the meeting first. */
  meet_room_live: 409,
  /** Created from the calendar: edit or cancel the calendar event instead. */
  meet_managed_by_calendar: 409,
};
