import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './auth';
import { organizations } from './org';
import { meetings } from './meet';
import { spaces } from './space';
import { citext, id, textTr, timestamps, tz } from './types';

/**
 * Calendar module (roadmap 14). Owned by the calendar session. Meetings (meet) and board
 * card due dates are read from their own tables at query time; nothing is copied here.
 */

/** external: a Google or Microsoft calendar mirrored from a connected account (calendar_accounts). */
export const calendarKind = pgEnum('calendar_kind', ['personal', 'team', 'space', 'external']);
export const calendarProvider = pgEnum('calendar_provider', ['google', 'microsoft', 'exchange']);
export const calendarAccountStatus = pgEnum('calendar_account_status', [
  'active',
  'error',
  'revoked',
]);
export const calendarRole = pgEnum('calendar_role', ['owner', 'editor', 'viewer']);
export const calendarEventStatus = pgEnum('calendar_event_status', [
  'confirmed',
  'tentative',
  'cancelled',
]);
export const calendarAttendeeResponse = pgEnum('calendar_attendee_response', [
  'needs_action',
  'accepted',
  'declined',
  'tentative',
]);

/**
 * A person's Google or Microsoft account connected for calendar sync. Tokens are sealed with
 * AUTH_SECRET (services/calendar/external/secrets.ts); the provider stays the source of truth.
 */
export const calendarAccounts = pgTable(
  'calendar_accounts',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: calendarProvider('provider').notNull(),
    /** The account's address as the provider reports it. */
    email: citext('email').notNull(),
    /**
     * Null for org-wide (delegated) accounts: tokens come from the org's application access.
     * Exchange: the sealed sign-in instead of a token (it has no OAuth of its own).
     */
    refreshTokenEnc: text('refresh_token_enc'),
    accessTokenEnc: text('access_token_enc'),
    accessExpiresAt: tz('access_expires_at'),
    status: calendarAccountStatus('status').notNull().default('active'),
    lastError: text('last_error'),
    lastSyncedAt: tz('last_synced_at'),
    /** Added by the org-wide integration (domain-wide delegation / application permission). */
    delegated: boolean('delegated').notNull().default(false),
    /** Only busy times come in: titles, places, notes and people are not stored. */
    busyOnly: boolean('busy_only').notNull().default(false),
    /** The person's token was asked for the address book too (Microsoft: Contacts.ReadWrite). */
    contactsGranted: boolean('contacts_granted').notNull().default(false),
    /** The address book's sync; null while it does not sync. */
    contactsState: jsonb('contacts_state').$type<ContactsSyncState>(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('calendar_accounts_uq').on(t.orgId, t.userId, t.provider, t.email),
    index('calendar_accounts_user_idx').on(t.userId),
  ],
);

/** Where the account's address book sync stands. */
export interface ContactsSyncState {
  /** Graph deltaLink; null = next run is a full listing. */
  cursor: string | null;
  status: 'active' | 'needs_consent' | 'error';
  lastError: string | null;
  lastSyncedAt: string | null;
  /** Mirrored contacts after the last run. */
  count: number;
}

/** Where incremental sync of an external calendar continues. */
export interface CalendarSyncState {
  /** Google nextSyncToken or Graph deltaLink; null = next run is a full sync. */
  cursor: string | null;
  /** Graph calendarView window the delta link belongs to (ISO). */
  windowStart?: string;
  windowEnd?: string;
  /**
   * Change notifications: Google push channel (events.watch) or Graph subscription. `token` is
   * sealed; the provider sends it back with every notification.
   */
  push?: { id: string; resourceId?: string; expiresAt: string; tokenEnc: string };
}

export const calendars = pgTable(
  'calendars',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    kind: calendarKind('kind').notNull(),
    /** personal: the owner; team: the creator (members decide rights). */
    ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'cascade' }),
    spaceId: uuid('space_id').references(() => spaces.id, { onDelete: 'cascade' }),
    name: textTr('name').notNull(),
    color: text('color').notNull().default('s1'),
    description: text('description'),
    /** external: the connected account and the provider's calendar id. */
    accountId: uuid('account_id').references(() => calendarAccounts.id, { onDelete: 'cascade' }),
    externalId: text('external_id'),
    /** external: the provider lets the account change events. */
    externalWritable: boolean('external_writable'),
    syncState: jsonb('sync_state').$type<CalendarSyncState>(),
    /** Grows with every change of an event; CalDAV's getctag. */
    changeSeq: bigint('change_seq', { mode: 'number' }).notNull().default(1),
    deletedAt: tz('deleted_at'),
    ...timestamps(),
  },
  (t) => [
    index('calendars_org_idx').on(t.orgId),
    uniqueIndex('calendars_personal_uq')
      .on(t.orgId, t.ownerId)
      .where(sql`${t.kind} = 'personal' and ${t.deletedAt} is null`),
    uniqueIndex('calendars_space_uq')
      .on(t.spaceId)
      .where(sql`${t.kind} = 'space'`),
    uniqueIndex('calendars_external_uq')
      .on(t.accountId, t.externalId)
      // Not on kind: the enum value is new in the same migration transaction.
      .where(sql`${t.accountId} is not null`),
  ],
);

/** Team calendar members; personal and space calendars derive rights elsewhere. */
export const calendarMembers = pgTable(
  'calendar_members',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    calendarId: uuid('calendar_id')
      .notNull()
      .references(() => calendars.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: calendarRole('role').notNull(),
    ...timestamps(),
  },
  (t) => [
    primaryKey({ columns: [t.calendarId, t.userId] }),
    index('calendar_members_user_idx').on(t.userId),
  ],
);

export interface CalendarExternalPerson {
  email: string;
  name: string | null;
  response: 'needs_action' | 'accepted' | 'declined' | 'tentative';
  /** The connected account itself. */
  self: boolean;
  optional: boolean;
}

/** Provider data of a mirrored event; external events have no calendar_attendees rows. */
export interface CalendarExternalData {
  organizer: { email: string; name: string | null; self: boolean } | null;
  attendees: CalendarExternalPerson[];
  /** Google Meet / Teams link of the event. */
  joinUrl: string | null;
  /** The event in Google Calendar / Outlook on the web. */
  webUrl: string | null;
  /** Cannot be changed from Crewhall (a recurrence we cannot express). */
  readOnly: boolean;
  /** One occurrence of a provider series stored on its own (Graph; unsupported Google rules). */
  seriesMasterId: string | null;
  /** The current version was written from Crewhall (kept when the provider replaces it). */
  writtenHere?: boolean;
}

/** A version of an event that was overwritten (calendar_event_versions.data). */
export interface CalendarEventVersionData {
  title: string;
  description: string | null;
  location: string | null;
  allDay: boolean;
  /** Wire format: `YYYY-MM-DD` for all-day, ISO instant otherwise. */
  start: string;
  end: string;
  attendees: { email: string; name: string | null }[];
}

/**
 * Events. A series is one row with `rrule`; a changed occurrence is another row pointing at
 * it (`parent_id` + `recurrence_id`, the original start's key). Times: timed events use
 * starts_at/ends_at; all-day events keep their dates in start_date/end_date (end exclusive)
 * and the UTC midnights in starts_at/ends_at for range queries.
 */
export const calendarEvents = pgTable(
  'calendar_events',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    calendarId: uuid('calendar_id')
      .notNull()
      .references(() => calendars.id, { onDelete: 'cascade' }),
    /** iCalendar UID; overrides share their series' UID. */
    uid: text('uid').notNull(),
    /** CalDAV resource name chosen by the client on PUT; null = `<id>.ics`. */
    davName: text('dav_name'),
    parentId: uuid('parent_id'),
    recurrenceId: text('recurrence_id'),
    title: textTr('title').notNull(),
    description: text('description'),
    location: text('location'),
    allDay: boolean('all_day').notNull().default(false),
    startsAt: tz('starts_at').notNull(),
    endsAt: tz('ends_at').notNull(),
    startDate: text('start_date'),
    endDate: text('end_date'),
    timeZone: text('time_zone').notNull(),
    rrule: text('rrule'),
    /** End of the last occurrence; null = never ends (or not recurring: ends_at). */
    seriesEndsAt: tz('series_ends_at'),
    exdates: text('exdates')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    status: calendarEventStatus('status').notNull().default('confirmed'),
    busy: boolean('busy').notNull().default(true),
    visibility: text('visibility', { enum: ['default', 'private'] })
      .notNull()
      .default('default'),
    /** Minutes before; null = the attendee's own default. */
    reminders: integer('reminders').array(),
    organizerId: uuid('organizer_id').references(() => users.id, { onDelete: 'set null' }),
    /** iTIP SEQUENCE; grows on changes that matter to invitees. */
    sequence: integer('sequence').notNull().default(0),
    /** The event's Crewhall meeting ("Crewhall toplantısı ekle"); meet owns the row. */
    meetingId: uuid('meeting_id').references(() => meetings.id, { onDelete: 'set null' }),
    /** external: the provider's event id and version (Google etag, Graph changeKey). */
    externalId: text('external_id'),
    externalEtag: text('external_etag'),
    /** external: what we show but do not model (their invitees, join link, web link). */
    external: jsonb('external').$type<CalendarExternalData>(),
    /** Properties we keep for CalDAV round trips (CATEGORIES, URL…), never interpreted. */
    extra: jsonb('extra').$type<Record<string, string>>(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    deletedAt: tz('deleted_at'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('calendar_events_uid_uq')
      .on(t.calendarId, t.uid)
      .where(sql`${t.parentId} is null and ${t.deletedAt} is null`),
    uniqueIndex('calendar_events_dav_name_uq')
      .on(t.calendarId, t.davName)
      .where(sql`${t.davName} is not null and ${t.parentId} is null and ${t.deletedAt} is null`),
    uniqueIndex('calendar_events_override_uq')
      .on(t.parentId, t.recurrenceId)
      .where(sql`${t.parentId} is not null and ${t.deletedAt} is null`),
    uniqueIndex('calendar_events_external_uq')
      .on(t.calendarId, t.externalId)
      .where(sql`${t.externalId} is not null`),
    index('calendar_events_range_idx').on(t.calendarId, t.startsAt),
    index('calendar_events_org_idx').on(t.orgId),
  ],
);

/**
 * Mirrored calendars: versions lost to "the last writer wins". `provider`: what the provider held
 * when a Crewhall write overwrote it; `crewhall`: what Crewhall had written when the provider
 * replaced it. Goes with the event.
 */
export const calendarVersionSource = pgEnum('calendar_version_source', ['provider', 'crewhall']);

export const calendarEventVersions = pgTable(
  'calendar_event_versions',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    eventId: uuid('event_id')
      .notNull()
      .references(() => calendarEvents.id, { onDelete: 'cascade' }),
    source: calendarVersionSource('source').notNull(),
    data: jsonb('data').$type<CalendarEventVersionData>().notNull(),
    etag: text('etag'),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t) => [index('calendar_event_versions_event_idx').on(t.eventId, t.createdAt)],
);

/** Invitees of a series (overrides share them). Org members by user, outsiders by address. */
export const calendarAttendees = pgTable(
  'calendar_attendees',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    eventId: uuid('event_id')
      .notNull()
      .references(() => calendarEvents.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    email: citext('email').notNull(),
    name: text('name'),
    response: calendarAttendeeResponse('response').notNull().default('needs_action'),
    optional: boolean('optional').notNull().default(false),
    respondedAt: tz('responded_at'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('calendar_attendees_event_email_uq').on(t.eventId, t.email),
    index('calendar_attendees_user_idx').on(t.userId),
  ],
);

export interface CalendarSettingsData {
  timeZone?: string;
  timeZoneExplicit?: boolean;
  weekStart?: 0 | 1 | 6;
  defaultView?: 'day' | 'week' | 'month' | 'agenda';
  defaultReminders?: number[];
  allDayReminderMinute?: number;
  workdayStart?: number;
  workdayEnd?: number;
  showMeetings?: boolean;
  showCards?: boolean;
  showDeclined?: boolean;
  hiddenCalendarIds?: string[];
}

/** Per person and org: zone, week start, default reminders, hidden calendars. */
export const calendarUserSettings = pgTable(
  'calendar_user_settings',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    settings: jsonb('settings').$type<CalendarSettingsData>().notNull().default({}),
    ...timestamps(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.userId] })],
);

/** Reminders already sent (event, person, occurrence, minutes before): each goes out once. */
export const calendarReminderLog = pgTable(
  'calendar_reminder_log',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    eventId: uuid('event_id')
      .notNull()
      .references(() => calendarEvents.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    occurrence: text('occurrence').notNull(),
    minutes: integer('minutes').notNull(),
    sentAt: tz('sent_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.eventId, t.userId, t.occurrence, t.minutes] }),
    index('calendar_reminder_log_sent_idx').on(t.sentAt),
  ],
);

/** Per org and provider: the OAuth client the admin registered for calendar sync. */
export const calendarIntegrations = pgTable(
  'calendar_integrations',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    provider: calendarProvider('provider').notNull(),
    enabled: boolean('enabled').notNull().default(false),
    clientId: text('client_id'),
    clientSecretEnc: text('client_secret_enc'),
    /** Microsoft: directory (tenant) id or common / organizations. */
    tenant: text('tenant'),
    /** Everyone's calendar without connecting (Google delegation / Graph application permission). */
    domainWide: boolean('domain_wide').notNull().default(false),
    /** Google: sealed service account key (JSON) with domain-wide delegation. */
    serviceAccountEnc: text('service_account_enc'),
    /** Google: Workspace admin the service account impersonates for the Directory API. */
    delegatedAdmin: text('delegated_admin'),
    directorySync: boolean('directory_sync').notNull().default(false),
    /** Personal contacts sync too. Microsoft: connecting then also asks for Contacts.ReadWrite. */
    contactsSync: boolean('contacts_sync').notNull().default(false),
    /** Exchange: the server's EWS address (https://mail.example.com/EWS/Exchange.asmx). */
    ewsUrl: text('ews_url'),
    /** Exchange: how people sign in to it. */
    ewsAuth: text('ews_auth', { enum: ['ntlm', 'basic'] })
      .notNull()
      .default('ntlm'),
    directorySyncedAt: tz('directory_synced_at'),
    directoryError: text('directory_error'),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.provider] })],
);

/** OAuth round trips in flight (ten minutes); the PKCE verifier is sealed. */
export const calendarOauthStates = pgTable('calendar_oauth_states', {
  stateHash: text('state_hash').primaryKey(),
  orgId: uuid('org_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  provider: calendarProvider('provider').notNull(),
  codeVerifierEnc: text('code_verifier_enc').notNull(),
  expiresAt: tz('expires_at').notNull(),
});
