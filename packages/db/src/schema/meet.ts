import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './auth';
import { blobs } from './drive';
import { organizations } from './org';
import { nodes, spaces } from './space';
import { id, timestamps, tz } from './types';

/**
 * Meetings (doc 17 §4 "meetings · participants", "recordings"). Owned by the meet session.
 * Chat tables are not referenced with foreign keys: the meeting conversation lives in the
 * chat module (conversations.type = 'meeting', conversations.meeting_id → meetings).
 */

export const meetingKind = pgEnum('meeting_kind', ['chat', 'room', 'scheduled']);
export const meetingRecurrence = pgEnum('meeting_recurrence', [
  'none',
  'daily',
  'weekdays',
  'weekly',
]);
export const meetingRole = pgEnum('meeting_role', ['moderator', 'member', 'listener', 'guest']);
export const lobbyStatus = pgEnum('meeting_lobby_status', [
  'waiting',
  'admitted',
  'denied',
  'expired',
  'cancelled',
]);
export const recordingStatus = pgEnum('recording_status', [
  'starting',
  'recording',
  'processing',
  'ready',
  'failed',
  'expired',
]);

export interface MeetingSettingsData {
  guestsAllowed: boolean;
  lobby: boolean;
  autoRecord: boolean;
  guestLinkHours: 1 | 24;
  /** People made moderator during the meeting (design 7.8 "Moderatör yap"). */
  moderatorIds?: string[];
  /** Guests (lobby request ids) a moderator allowed to share their screen (design 7.15). */
  screenShareGuests?: string[];
  /** Remote control of shared screens; absent = on (a moderator turns it off). */
  remoteControl?: boolean;
}

export const meetings = pgTable(
  'meetings',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    kind: meetingKind('kind').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    /** null: personal meeting; recordings go to the starter's personal space. */
    spaceId: uuid('space_id').references(() => spaces.id, { onDelete: 'cascade' }),
    /** Conversation the meeting is attached to (strip, system message). */
    conversationId: uuid('conversation_id'),
    /** The meeting's own conversation (type meeting), created through the chat module. */
    chatConversationId: uuid('chat_conversation_id'),
    /** LiveKit room name, stable for the meeting. */
    roomName: text('room_name').notNull().unique(),
    /** Link segment `/m/<slug>`; rotating it invalidates the old link. */
    joinSlug: text('join_slug').notNull().unique(),
    hostUserId: uuid('host_user_id').references(() => users.id, { onDelete: 'set null' }),
    startsAt: tz('starts_at'),
    durationMinutes: integer('duration_minutes'),
    recurrence: meetingRecurrence('recurrence').notNull().default('none'),
    settings: jsonb('settings').$type<MeetingSettingsData>().notNull(),
    /** .ics SEQUENCE: bumped on every time change or cancel. */
    icsSequence: integer('ics_sequence').notNull().default(0),
    cancelledAt: tz('cancelled_at'),
    /** Last session end (history ordering, "son 2 dk"). */
    endedAt: tz('ended_at'),
    ...timestamps(),
  },
  (t) => [
    index('meetings_org_starts_idx').on(t.orgId, t.startsAt),
    index('meetings_space_idx').on(t.spaceId),
    // One live room per conversation (design 07: "Her sohbetin tek tıkla açılan bir odası").
    uniqueIndex('meetings_conversation_chat_uq')
      .on(t.conversationId)
      .where(sql`${t.kind} = 'chat' and ${t.cancelledAt} is null`),
  ],
);

/** People invited to a scheduled meeting; members by user id, guests by e-mail. */
export const meetingInvitees = pgTable(
  'meeting_invitees',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    meetingId: uuid('meeting_id')
      .notNull()
      .references(() => meetings.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    email: text('email'),
    invitedBy: uuid('invited_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('meeting_invitees_user_uq')
      .on(t.meetingId, t.userId)
      .where(sql`${t.userId} is not null`),
    uniqueIndex('meeting_invitees_email_uq')
      .on(t.meetingId, sql`lower(${t.email})`)
      .where(sql`${t.email} is not null`),
  ],
);

/** One live occurrence of a meeting: from the first join to the room closing. */
export const meetingSessions = pgTable(
  'meeting_sessions',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    meetingId: uuid('meeting_id')
      .notNull()
      .references(() => meetings.id, { onDelete: 'cascade' }),
    /** LiveKit room sid; webhooks of the same room instance land here. */
    roomSid: text('room_sid'),
    startedAt: tz('started_at').notNull().defaultNow(),
    endedAt: tz('ended_at'),
    startedBy: uuid('started_by').references(() => users.id, { onDelete: 'set null' }),
    peakParticipants: integer('peak_participants').notNull().default(0),
    /** LiveKit identities removed by a moderator: their next join goes to the lobby. */
    removedIdentities: jsonb('removed_identities').$type<string[]>().notNull().default([]),
    ...timestamps(),
  },
  (t) => [
    index('meeting_sessions_meeting_idx').on(t.meetingId, t.startedAt),
    uniqueIndex('meeting_sessions_live_uq')
      .on(t.meetingId)
      .where(sql`${t.endedAt} is null`),
  ],
);

/** Filled from LiveKit webhooks (participant_joined / participant_left); one row per join. */
export const meetingParticipants = pgTable(
  'meeting_participants',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    meetingId: uuid('meeting_id')
      .notNull()
      .references(() => meetings.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => meetingSessions.id, { onDelete: 'cascade' }),
    identity: text('identity').notNull(),
    /** LiveKit participant sid of this join (dedupes webhook retries). */
    participantSid: text('participant_sid'),
    /** null for guests (doc 17 §4). */
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    guestName: text('guest_name'),
    role: meetingRole('role').notNull(),
    joinedAt: tz('joined_at').notNull(),
    leftAt: tz('left_at'),
    ...timestamps(),
  },
  (t) => [
    index('meeting_participants_session_idx').on(t.sessionId, t.identity),
    uniqueIndex('meeting_participants_sid_uq')
      .on(t.sessionId, t.participantSid)
      .where(sql`${t.participantSid} is not null`),
  ],
);

/** Knocks: guests by link, members without access or removed (design 7.13-7.15). */
export const meetingLobby = pgTable(
  'meeting_lobby',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    meetingId: uuid('meeting_id')
      .notNull()
      .references(() => meetings.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** sha256 of the guest's secret (members use their session). */
    secretHash: text('secret_hash'),
    status: lobbyStatus('status').notNull().default('waiting'),
    requestedAt: tz('requested_at').notNull().defaultNow(),
    decidedAt: tz('decided_at'),
    decidedBy: uuid('decided_by').references(() => users.id, { onDelete: 'set null' }),
    ip: text('ip'),
    ...timestamps(),
  },
  (t) => [index('meeting_lobby_meeting_idx').on(t.meetingId, t.status)],
);

export const recordings = pgTable(
  'recordings',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    meetingId: uuid('meeting_id')
      .notNull()
      .references(() => meetings.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id').references(() => meetingSessions.id, { onDelete: 'set null' }),
    egressId: text('egress_id').unique(),
    status: recordingStatus('status').notNull().default('starting'),
    audioOnly: boolean('audio_only').notNull().default(false),
    /** Object key the egress writes to; becomes the blob's storage key. */
    storageKey: text('storage_key').notNull(),
    /** Target Drive space (meeting's space or the starter's personal space). */
    spaceId: uuid('space_id').references(() => spaces.id, { onDelete: 'set null' }),
    blobId: uuid('blob_id').references(() => blobs.id, { onDelete: 'set null' }),
    nodeId: uuid('node_id').references(() => nodes.id, { onDelete: 'set null' }),
    durationS: integer('duration_s'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    startedBy: uuid('started_by').references(() => users.id, { onDelete: 'set null' }),
    startedAt: tz('started_at').notNull().defaultNow(),
    endedAt: tz('ended_at'),
    error: text('error'),
    ...timestamps(),
  },
  (t) => [
    index('recordings_meeting_idx').on(t.meetingId, t.startedAt),
    index('recordings_status_idx').on(t.status),
  ],
);

/** Meeting rules per space (space settings › Toplantı; doc 17 §15 item 8). */
export const meetSpaceSettings = pgTable('meet_space_settings', {
  spaceId: uuid('space_id')
    .primaryKey()
    .references(() => spaces.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  guestsAllowed: boolean('guests_allowed').notNull().default(true),
  editorsCanRecord: boolean('editors_can_record').notNull().default(true),
  /** null keeps recordings; default 180 days. */
  recordingRetentionDays: integer('recording_retention_days').default(180),
  ...timestamps(),
});

/** Calls from a direct or group chat (H7): who was rung and how each answered. */
export const callStatus = pgEnum('meeting_call_status', [
  'ringing',
  'active',
  'ended',
  'missed',
  'declined',
  'cancelled',
]);

export type CallMemberState = 'ringing' | 'accepted' | 'declined' | 'busy' | 'missed';

export interface CallMemberData {
  userId: string;
  state: CallMemberState;
  at: string;
  /** Who rang this person into the call, when it was not the one who started it. */
  by?: string;
}

/**
 * A call rings the members of a direct or group conversation and takes place in that
 * conversation's meeting room (meetings.kind = 'chat'). Adding a third person turns it into
 * a meeting (`upgraded`).
 */
export const meetingCalls = pgTable(
  'meeting_calls',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    meetingId: uuid('meeting_id')
      .notNull()
      .references(() => meetings.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id').notNull(),
    callerId: uuid('caller_id').references(() => users.id, { onDelete: 'set null' }),
    video: boolean('video').notNull().default(false),
    status: callStatus('status').notNull().default('ringing'),
    members: jsonb('members').$type<CallMemberData[]>().notNull().default([]),
    upgraded: boolean('upgraded').notNull().default(false),
    startedAt: tz('started_at').notNull().defaultNow(),
    answeredAt: tz('answered_at'),
    endedAt: tz('ended_at'),
    ...timestamps(),
  },
  (t) => [
    index('meeting_calls_conversation_idx').on(t.conversationId, t.startedAt),
    index('meeting_calls_meeting_idx').on(t.meetingId),
    // One live call per conversation.
    uniqueIndex('meeting_calls_live_uq')
      .on(t.conversationId)
      .where(sql`${t.status} in ('ringing', 'active')`),
  ],
);
