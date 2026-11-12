import { z } from 'zod';
import { EventRoom } from './bookings';
import { Id, Timestamp } from './common';
import { UserSummary } from './org';
import { SpaceColor } from './space';
import { CALENDAR_DATE_RE, isValidTimeZone, parseCalendarDate } from './calendar-time';
import { parseRRule } from './calendar-rrule';

/**
 * Calendar module (roadmap 14). Personal calendars (one per person and org), team calendars
 * with their own members and space calendars that follow the space's roles. Scheduled
 * meetings (meet) and board card due dates are shown as linked sources, never copied.
 * Times travel as instants (ISO with offset) for timed events and `YYYY-MM-DD` for all-day
 * ones (end exclusive); recurring events keep their wall-clock time in `timeZone`.
 */

export const CalendarKind = z.enum(['personal', 'team', 'space']);
export type CalendarKind = z.infer<typeof CalendarKind>;

export const CalendarRole = z.enum(['owner', 'editor', 'viewer']);

/** Google Calendar or Microsoft 365 / Outlook, connected per person (Hesabım › Takvim). */
export const CalendarProvider = z.enum(['google', 'microsoft', 'exchange']);
export type CalendarProvider = z.infer<typeof CalendarProvider>;

/**
 * A calendar mirrored from a connected account. Such calendars travel with `kind: 'personal'`
 * so older clients keep working; this field tells them apart.
 */
export const CalendarExternalRef = z.object({
  provider: CalendarProvider,
  accountId: Id,
  /** The connected account's address. */
  email: z.string(),
  /** The provider lets the account change events (owner or writer). */
  writable: z.boolean(),
});
export type CalendarExternalRef = z.infer<typeof CalendarExternalRef>;
export type CalendarRole = z.infer<typeof CalendarRole>;

export const CalendarDate = z
  .string()
  .regex(CALENDAR_DATE_RE)
  .refine((s) => parseCalendarDate(s) !== null, 'invalid date');
export type CalendarDate = z.infer<typeof CalendarDate>;

export const TimeZoneName = z.string().min(1).max(64).refine(isValidTimeZone, 'unknown time zone');

/** RFC 5545 RRULE value (without `RRULE:`), limited to what calendar-rrule.ts expands. */
export const RRuleText = z
  .string()
  .max(500)
  .refine((s) => parseRRule(s) !== null, 'unsupported recurrence rule');

export const CALENDAR_LIMITS = {
  /** Longest range one occurrences request may cover. */
  maxRangeDays: 400,
  maxAttendees: 200,
  maxReminders: 5,
  /** Reminders up to four weeks before. */
  maxReminderMinutes: 40_320,
  maxIcsBytes: 5_000_000,
  freeBusyUsers: 50,
} as const;

export const CalendarPermissions = z.object({
  /** Create, move and delete events. */
  write: z.boolean(),
  /** Rename, recolour, members, delete the calendar. */
  manage: z.boolean(),
});

export const Calendar = z.object({
  id: Id,
  kind: CalendarKind,
  name: z.string(),
  color: SpaceColor,
  description: z.string().nullable(),
  spaceId: Id.nullable(),
  ownerId: Id.nullable(),
  /** The person's own personal calendar. */
  isDefault: z.boolean(),
  myRole: CalendarRole,
  memberCount: z.number().int(),
  permissions: CalendarPermissions,
  /** Set on calendars mirrored from Google or Microsoft; absent on older servers. */
  external: CalendarExternalRef.nullable().optional(),
  createdAt: Timestamp,
});
export type Calendar = z.infer<typeof Calendar>;

export const CalendarMemberInput = z.object({
  userId: Id,
  role: z.enum(['editor', 'viewer']),
});

export const CreateCalendar = z.object({
  name: z.string().trim().min(1).max(80),
  color: SpaceColor.default('s1'),
  description: z.string().max(500).optional(),
  members: z.array(CalendarMemberInput).max(200).default([]),
});
export type CreateCalendar = z.input<typeof CreateCalendar>;

export const UpdateCalendar = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  color: SpaceColor.optional(),
  description: z.string().max(500).nullable().optional(),
});
export type UpdateCalendar = z.infer<typeof UpdateCalendar>;

export const CalendarMember = z.object({ user: UserSummary, role: CalendarRole });
export type CalendarMember = z.infer<typeof CalendarMember>;

export const SetCalendarMember = z.object({ role: z.enum(['editor', 'viewer']) });

// ---- events -----------------------------------------------------------------------------------

export const AttendeeResponse = z.enum(['needs_action', 'accepted', 'declined', 'tentative']);
export type AttendeeResponse = z.infer<typeof AttendeeResponse>;

export const EventStatus = z.enum(['confirmed', 'tentative', 'cancelled']);
export type EventStatus = z.infer<typeof EventStatus>;

export const EventVisibility = z.enum(['default', 'private']);
export type EventVisibility = z.infer<typeof EventVisibility>;

export const EventAttendee = z.object({
  id: Id,
  /** Org member; null for an outside address. */
  user: UserSummary.nullable(),
  email: z.string(),
  name: z.string().nullable(),
  response: AttendeeResponse,
  optional: z.boolean(),
});
export type EventAttendee = z.infer<typeof EventAttendee>;

export const AttendeesInput = z.object({
  userIds: z.array(Id).max(CALENDAR_LIMITS.maxAttendees).default([]),
  emails: z.array(z.email().max(254)).max(CALENDAR_LIMITS.maxAttendees).default([]),
  /** Of the above, these are optional. */
  optionalUserIds: z.array(Id).max(CALENDAR_LIMITS.maxAttendees).optional(),
});

const Reminders = z
  .array(z.number().int().min(0).max(CALENDAR_LIMITS.maxReminderMinutes))
  .max(CALENDAR_LIMITS.maxReminders);

/** Timed: ISO instants. All-day: `YYYY-MM-DD`, end exclusive (a one-day event ends the next day). */
const EventTimesBase = z.object({
  allDay: z.boolean().default(false),
  start: z.string().max(40),
  end: z.string().max(40),
  timeZone: TimeZoneName.optional(),
});

function checkTimes(
  v: { allDay?: boolean; start?: string; end?: string },
  ctx: z.RefinementCtx,
  partial: boolean,
) {
  if (partial && v.start === undefined && v.end === undefined) return;
  if (v.start === undefined || v.end === undefined) {
    ctx.addIssue({ code: 'custom', path: ['end'], message: 'start and end go together' });
    return;
  }
  const allDay = v.allDay ?? false;
  if (allDay) {
    if (!CalendarDate.safeParse(v.start).success || !CalendarDate.safeParse(v.end).success) {
      ctx.addIssue({ code: 'custom', path: ['start'], message: 'all-day times are dates' });
      return;
    }
    if (v.end <= v.start)
      ctx.addIssue({ code: 'custom', path: ['end'], message: 'end before start' });
    return;
  }
  const s = Timestamp.safeParse(v.start);
  const e = Timestamp.safeParse(v.end);
  if (!s.success || !e.success) {
    ctx.addIssue({ code: 'custom', path: ['start'], message: 'timed events use instants' });
    return;
  }
  if (Date.parse(v.end) < Date.parse(v.start)) {
    ctx.addIssue({ code: 'custom', path: ['end'], message: 'end before start' });
  }
}

const EventFields = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(10_000).nullable().optional(),
  location: z.string().max(500).nullable().optional(),
  rrule: RRuleText.nullable().optional(),
  status: z.enum(['confirmed', 'tentative']).optional(),
  /** false = shows as free (transparent) in availability. */
  busy: z.boolean().optional(),
  visibility: EventVisibility.optional(),
  /** Minutes before the start; absent = the person's default. */
  reminders: Reminders.optional(),
  attendees: AttendeesInput.optional(),
  /**
   * "Crewhall toplantısı ekle": a scheduled meeting (meet) is created for the event and its link
   * goes to the invitees and the .ics; false removes it. Timed events only.
   */
  onlineMeeting: z.boolean().optional(),
  /** Books this room for the event (one-off timed events); null frees it. */
  roomId: Id.nullable().optional(),
});

export const CreateCalendarEvent = EventFields.extend({
  calendarId: Id,
  ...EventTimesBase.shape,
}).superRefine((v, ctx) => checkTimes(v, ctx, false));
export type CreateCalendarEvent = z.input<typeof CreateCalendarEvent>;

/** Which part of a series a change applies to. */
export const SeriesScope = z.enum(['all', 'this', 'following']);
export type SeriesScope = z.infer<typeof SeriesScope>;

export const UpdateCalendarEvent = EventFields.partial()
  .extend({
    calendarId: Id.optional(),
    allDay: z.boolean().optional(),
    start: z.string().max(40).optional(),
    end: z.string().max(40).optional(),
    timeZone: TimeZoneName.optional(),
    scope: SeriesScope.default('all'),
    /** With scope this/following: the occurrence's key (occurrenceKey). */
    recurrenceId: z.string().max(40).optional(),
    /** The person's occurrence-level "send updates to invitees" choice; default true. */
    notify: z.boolean().optional(),
  })
  .superRefine((v, ctx) => {
    checkTimes(v, ctx, true);
    if (v.scope !== 'all' && !v.recurrenceId) {
      ctx.addIssue({ code: 'custom', path: ['recurrenceId'], message: 'required for this scope' });
    }
  });
export type UpdateCalendarEvent = z.input<typeof UpdateCalendarEvent>;

export const DeleteCalendarEventQuery = z.object({
  scope: SeriesScope.default('all'),
  recurrenceId: z.string().max(40).optional(),
});

export const RespondCalendarEvent = z.object({
  response: z.enum(['accepted', 'declined', 'tentative']),
});

export const EventPermissions = z.object({
  edit: z.boolean(),
  delete: z.boolean(),
  /** The caller is an attendee and may answer. */
  respond: z.boolean(),
});

export const CalendarEventRef = z.object({
  id: Id,
  name: z.string(),
  color: SpaceColor,
  kind: CalendarKind,
});

/** A version of a mirrored event lost to "the last writer wins". */
export const CalendarEventVersion = z.object({
  id: Id,
  /** provider: the version at Google / Microsoft; crewhall: the one written from Crewhall. */
  overwritten: z.enum(['provider', 'crewhall']),
  replacedAt: Timestamp,
  title: z.string(),
  description: z.string().nullable(),
  location: z.string().nullable(),
  allDay: z.boolean(),
  start: z.string(),
  end: z.string(),
  attendees: z.array(z.object({ email: z.string(), name: z.string().nullable() })),
});
export type CalendarEventVersion = z.infer<typeof CalendarEventVersion>;

export const CalendarEvent = z.object({
  id: Id,
  uid: z.string(),
  calendar: CalendarEventRef,
  title: z.string(),
  description: z.string().nullable(),
  location: z.string().nullable(),
  allDay: z.boolean(),
  start: z.string(),
  end: z.string(),
  timeZone: z.string(),
  rrule: z.string().nullable(),
  /** Removed occurrences (keys). */
  exdates: z.array(z.string()),
  /** Set on a changed occurrence of a series: the series and the original start's key. */
  seriesId: Id.nullable(),
  recurrenceId: z.string().nullable(),
  status: EventStatus,
  busy: z.boolean(),
  visibility: EventVisibility,
  reminders: z.array(z.number().int()),
  organizer: UserSummary.nullable(),
  attendees: z.array(EventAttendee),
  myResponse: AttendeeResponse.nullable(),
  permissions: EventPermissions,
  /** The event's Crewhall meeting (onlineMeeting); absent on older servers. */
  meeting: z.object({ id: Id, slug: z.string(), url: z.string() }).nullable().optional(),
  /** The room booked for the event; absent on older servers. */
  room: EventRoom.nullable().optional(),
  /** Events of a mirrored Google / Microsoft calendar; absent on older servers. */
  external: z
    .object({
      provider: CalendarProvider,
      /** Google Meet or Teams link of the event. */
      joinUrl: z.string().nullable(),
      /** The event in Google Calendar or Outlook on the web. */
      webUrl: z.string().nullable(),
      organizer: z.object({ email: z.string(), name: z.string().nullable() }).nullable(),
      /**
       * Microsoft series arrive as single occurrences: changes apply to that occurrence only.
       * Google rules Crewhall cannot express are read-only (readOnly).
       */
      occurrenceOnly: z.boolean(),
      readOnly: z.boolean(),
    })
    .nullable()
    .optional(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type CalendarEvent = z.infer<typeof CalendarEvent>;

export const EventQuery = z.object({
  /** Opens the series as that occurrence (its override when one exists). */
  recurrenceId: z.string().max(40).optional(),
});

// ---- occurrences (what the views draw) ------------------------------------------------------

export const OccurrenceSource = z.enum(['event', 'meeting', 'card']);
export type OccurrenceSource = z.infer<typeof OccurrenceSource>;

export const CalendarOccurrence = z.object({
  /** Stable key for the views: `<source>:<id>:<recurrenceId>`. */
  key: z.string(),
  source: OccurrenceSource,
  /** event: the event row (series or changed occurrence); meeting/card: the linked item. */
  sourceId: Id,
  /** The series id when the occurrence belongs to one. */
  seriesId: Id.nullable(),
  recurrenceId: z.string().nullable(),
  calendarId: Id.nullable(),
  color: SpaceColor,
  /** Private events of others show as busy without details ("Meşgul"). */
  title: z.string(),
  hidden: z.boolean(),
  location: z.string().nullable(),
  allDay: z.boolean(),
  start: z.string(),
  end: z.string(),
  status: EventStatus,
  busy: z.boolean(),
  recurring: z.boolean(),
  myResponse: AttendeeResponse.nullable(),
  attendeeCount: z.number().int(),
  /** Can be dragged and resized by the caller (events with write rights). */
  editable: z.boolean(),
  /** Linked source: where the item lives (meeting room, board card). */
  url: z.string().nullable(),
  /** card: done; meeting: live now. */
  flag: z.enum(['done', 'live']).nullable(),
  /** Event of a mirrored Google / Microsoft calendar; absent on older servers. */
  provider: CalendarProvider.nullable().optional(),
});
export type CalendarOccurrence = z.infer<typeof CalendarOccurrence>;

const csvIds = z
  .string()
  .max(4000)
  .transform((s) => s.split(',').filter(Boolean))
  .pipe(z.array(Id).max(100));

export const OccurrencesQuery = z
  .object({
    from: Timestamp,
    to: Timestamp,
    /** Default: every calendar the caller can read except hidden ones. */
    calendarIds: csvIds.optional(),
    /** Space view: the space calendar plus the space's meetings and cards. */
    spaceId: Id.optional(),
    meetings: z.stringbool().default(true),
    cards: z.stringbool().default(true),
  })
  .refine(
    (q) =>
      Date.parse(q.to) > Date.parse(q.from) &&
      Date.parse(q.to) - Date.parse(q.from) <= CALENDAR_LIMITS.maxRangeDays * 86_400_000,
    { message: 'invalid range', path: ['to'] },
  );
export type OccurrencesQuery = z.input<typeof OccurrencesQuery>;

// ---- availability -----------------------------------------------------------------------------

export const FreeBusyQuery = z
  .object({
    userIds: z
      .string()
      .max(4000)
      .transform((s) => s.split(',').filter(Boolean))
      .pipe(z.array(Id).min(1).max(CALENDAR_LIMITS.freeBusyUsers)),
    from: Timestamp,
    to: Timestamp,
  })
  .refine((q) => Date.parse(q.to) - Date.parse(q.from) <= 62 * 86_400_000, {
    message: 'invalid range',
    path: ['to'],
  });

export const BusyInterval = z.object({
  start: Timestamp,
  end: Timestamp,
  /** tentative / needs-action: drawn lighter. */
  tentative: z.boolean(),
});

export const FreeBusy = z.object({
  items: z.array(z.object({ userId: Id, busy: z.array(BusyInterval) })),
});
export type FreeBusy = z.infer<typeof FreeBusy>;

// ---- settings, import ---------------------------------------------------------------------------

export const CalendarView = z.enum(['day', 'week', 'month', 'agenda']);
export type CalendarView = z.infer<typeof CalendarView>;

export const CalendarSettings = z.object({
  /** IANA zone the views and all-day reminders use. */
  timeZone: z.string(),
  /** Set by the person (otherwise the browser's zone was taken). */
  timeZoneExplicit: z.boolean(),
  /** 0 = Sunday, 1 = Monday, 6 = Saturday. */
  weekStart: z.union([z.literal(0), z.literal(1), z.literal(6)]),
  defaultView: CalendarView,
  defaultReminders: z.array(z.number().int()),
  /** All-day reminders fire at this local minute of the day before (default 09:00 → 540). */
  allDayReminderMinute: z.number().int().min(0).max(1439),
  workdayStart: z.number().int().min(0).max(23),
  workdayEnd: z.number().int().min(1).max(24),
  showMeetings: z.boolean(),
  showCards: z.boolean(),
  showDeclined: z.boolean(),
  hiddenCalendarIds: z.array(Id),
});
export type CalendarSettings = z.infer<typeof CalendarSettings>;

export const UpdateCalendarSettings = z.object({
  timeZone: TimeZoneName.optional(),
  /** false: the browser's zone (sent once by the client). */
  timeZoneExplicit: z.boolean().optional(),
  weekStart: z.union([z.literal(0), z.literal(1), z.literal(6)]).optional(),
  defaultView: CalendarView.optional(),
  defaultReminders: Reminders.optional(),
  allDayReminderMinute: z.number().int().min(0).max(1439).optional(),
  workdayStart: z.number().int().min(0).max(23).optional(),
  workdayEnd: z.number().int().min(1).max(24).optional(),
  showMeetings: z.boolean().optional(),
  showCards: z.boolean().optional(),
  showDeclined: z.boolean().optional(),
  hiddenCalendarIds: z.array(Id).max(200).optional(),
});
export type UpdateCalendarSettings = z.infer<typeof UpdateCalendarSettings>;

export const ImportIcs = z.object({
  ics: z.string().min(1).max(CALENDAR_LIMITS.maxIcsBytes),
});

export const ImportIcsResult = z.object({
  created: z.number().int(),
  updated: z.number().int(),
  skipped: z.number().int(),
  errors: z.array(z.object({ uid: z.string().nullable(), reason: z.string() })),
});
export type ImportIcsResult = z.infer<typeof ImportIcsResult>;

/** Where CalDAV clients connect (the server's public URL + /caldav/). */
export const CalDavInfo = z.object({
  url: z.string(),
  username: z.string(),
  /** Personal API tokens (Hesabım › MCP ve API) are the password; off when MCP is off. */
  tokensAvailable: z.boolean(),
});
export type CalDavInfo = z.infer<typeof CalDavInfo>;

// ---- connected accounts (Google / Microsoft sync) ---------------------------------------------

export const CalendarAccountStatus = z.enum(['active', 'error', 'revoked']);
export type CalendarAccountStatus = z.infer<typeof CalendarAccountStatus>;

export const CalendarAccount = z.object({
  id: Id,
  provider: CalendarProvider,
  email: z.string(),
  /** error: the last sync failed (lastError); revoked: the person must connect again. */
  status: CalendarAccountStatus,
  /** An error code (errors.<code>) or the provider's reason. */
  lastError: z.string().nullable(),
  lastSyncedAt: Timestamp.nullable(),
  /** Its calendars as Crewhall shows them (shown and hidden through the calendar settings). */
  calendars: z.array(z.object({ id: Id, name: z.string(), writable: z.boolean() })),
  createdAt: Timestamp,
  /** Added by the org-wide integration; the person cannot disconnect it (absent on older servers). */
  delegated: z.boolean().optional(),
  /** Only free/busy comes in: no titles, places or people; nothing is written back. */
  busyOnly: z.boolean().optional(),
  /**
   * The account's address book, when the org syncs it (absent on older servers).
   * needs_consent: the person connects again, or the admin grants the permission.
   */
  contacts: z
    .object({
      status: z.enum(['active', 'needs_consent', 'error']),
      lastError: z.string().nullable(),
      lastSyncedAt: Timestamp.nullable(),
      count: z.number().int(),
    })
    .nullable()
    .optional(),
});
export type CalendarAccount = z.infer<typeof CalendarAccount>;

export const UpdateCalendarAccount = z.object({ busyOnly: z.boolean() });
export type UpdateCalendarAccount = z.infer<typeof UpdateCalendarAccount>;

export const CalendarAccounts = z.object({
  items: z.array(CalendarAccount),
  /** Providers the org admin set up; the connect buttons. */
  providers: z.array(CalendarProvider),
});
export type CalendarAccounts = z.infer<typeof CalendarAccounts>;

/** One provider's OAuth client as the admin sees it (Yönetim › Takvim). */
export const CalendarIntegration = z.object({
  provider: CalendarProvider,
  enabled: z.boolean(),
  clientId: z.string().nullable(),
  hasClientSecret: z.boolean(),
  /** Microsoft only: tenant id, `organizations` or `common` (default). */
  tenant: z.string().nullable(),
  /** Redirect URI to register at Google Cloud / Microsoft Entra. */
  redirectUri: z.string(),
  /** Accounts connected in the org. */
  accountCount: z.number().int(),
  updatedAt: Timestamp.nullable(),
  /**
   * Org-wide access (absent on older servers): everyone's calendar syncs without connecting one
   * by one. Google: service account with domain-wide delegation; Microsoft: application
   * permission (Calendars.ReadWrite) with the client above.
   */
  domainWide: z.boolean().optional(),
  /** Google: the service account (client_email of the stored key). */
  serviceAccountEmail: z.string().nullable().optional(),
  /** Google: the Workspace admin the service account acts as for the Directory API. */
  delegatedAdmin: z.string().nullable().optional(),
  /** Google: manager, department, title, phones from the Workspace directory every hour. */
  directorySync: z.boolean().optional(),
  directorySyncedAt: Timestamp.nullable().optional(),
  /** Last directory sync error (provider reason), null when it went through. */
  directoryError: z.string().nullable().optional(),
  /** Microsoft, Exchange: people's contacts sync too, two-way (Microsoft: Contacts.ReadWrite). */
  contactsSync: z.boolean().optional(),
  /** Exchange: the server's EWS address. */
  ewsUrl: z.string().nullable().optional(),
  /** Exchange: how people sign in to it. */
  ewsAuth: z.enum(['ntlm', 'basic']).optional(),
});
export type CalendarIntegration = z.infer<typeof CalendarIntegration>;

export const CalendarIntegrations = z.object({ items: z.array(CalendarIntegration) });
export type CalendarIntegrations = z.infer<typeof CalendarIntegrations>;

export const UpdateCalendarIntegration = z.object({
  enabled: z.boolean(),
  clientId: z.string().trim().max(300).nullable().optional(),
  /** Empty or absent keeps the stored secret; null removes it. */
  clientSecret: z.string().max(1000).nullable().optional(),
  tenant: z
    .string()
    .trim()
    .max(100)
    .regex(/^[A-Za-z0-9.-]*$/)
    .nullable()
    .optional(),
  domainWide: z.boolean().optional(),
  /** Google: the service account's JSON key file; absent keeps it, null removes it. */
  serviceAccountKey: z.string().max(10_000).nullable().optional(),
  delegatedAdmin: z.email().max(254).nullable().optional(),
  directorySync: z.boolean().optional(),
  contactsSync: z.boolean().optional(),
  ewsUrl: z
    .string()
    .trim()
    .max(500)
    .regex(/^https:\/\/[^\s]+$/)
    .nullable()
    .optional(),
  ewsAuth: z.enum(['ntlm', 'basic']).optional(),
});
export type UpdateCalendarIntegration = z.infer<typeof UpdateCalendarIntegration>;

/**
 * A person connects an on-premises Exchange mailbox with their own sign-in. The password is
 * sealed and never comes back. `username`: `DOMAIN\\user` or empty for the address.
 */
export const ConnectExchangeAccount = z.object({
  email: z.email().max(254),
  username: z.string().trim().max(254).optional(),
  password: z.string().min(1).max(1000),
});
export type ConnectExchangeAccount = z.infer<typeof ConnectExchangeAccount>;

/** Non-JSON paths of the module (export is a file; CalDAV speaks WebDAV; OAuth redirects). */
export const CALENDAR_RAW_PATHS = {
  exportIcs: '/api/v1/calendar/calendars/:calendarId/export.ics',
  caldav: '/caldav',
  /** GET, browser navigation: starts connecting a Google or Microsoft account. */
  oauthStart: '/api/calendar/oauth/:provider/start',
  /** OAuth2 redirect URI to register at Google Cloud and Microsoft Entra (both providers). */
  oauthCallback: '/api/calendar/oauth/callback',
} as const;

// ---- permissions ------------------------------------------------------------------------------

const RANK: Record<CalendarRole, number> = { viewer: 0, editor: 1, owner: 2 };

/**
 * Calendar rights from the caller's role on the calendar (personal: owner; team: the member
 * role; space: owner/admin → owner, editor → editor, viewer → viewer). Events: organizers and
 * calendar editors change them, attendees only answer.
 */
export function canCalendar(
  action: 'read' | 'write' | 'manage',
  input: { role: CalendarRole | null; kind: CalendarKind },
): boolean {
  if (input.role === null) return false;
  switch (action) {
    case 'read':
      return true;
    case 'write':
      return RANK[input.role] >= RANK.editor;
    case 'manage':
      // A space calendar is managed with the space (its name and colour follow the space).
      return input.kind !== 'space' && input.role === 'owner';
  }
}
