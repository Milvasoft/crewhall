import { sql, type SQL } from 'drizzle-orm';
import {
  bigint,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { users } from './auth';
import { blobs } from './drive';
import { organizations } from './org';
import { nodes, spaces } from './space';
import { id, textTr, timestamps, tz } from './types';

/**
 * Chat, presence and notifications (doc 17 §4, §6, §10). Owned by the chat session.
 *
 * Space conversations (and space-bound alert ones) take their members from space_members;
 * their conversation_members rows only carry the person's own settings. Every other
 * conversation's members are its conversation_members rows.
 */

const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });

export const conversationType = pgEnum('conversation_type', [
  'direct',
  'group',
  'space',
  'meeting',
  'alert',
  'card',
]);
export const notifyLevel = pgEnum('notify_level', ['all', 'critical', 'mentions', 'none']);
export const messageKind = pgEnum('message_kind', ['user', 'webhook', 'system']);
export const mentionKind = pgEnum('mention_kind', ['user', 'all', 'here']);
export const statusVisibility = pgEnum('status_visibility', [
  'online',
  'busy',
  'dnd',
  'away',
  'invisible',
]);
export const digestFrequency = pgEnum('digest_frequency', ['off', 'hourly', 'daily']);
export const pushPlatform = pgEnum('push_platform', ['ios', 'android']);

export const conversations = pgTable(
  'conversations',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    type: conversationType('type').notNull(),
    spaceId: uuid('space_id').references(() => spaces.id, { onDelete: 'cascade' }),
    /** meetings (meet module) and board cards point here; loose until those tables exist. */
    meetingId: uuid('meeting_id'),
    name: textTr('name'),
    /** Channel icon: one emoji (isReactionEmoji), shown instead of the letter placeholder. */
    emoji: text('emoji'),
    avatarBlobId: uuid('avatar_blob_id').references(() => blobs.id, { onDelete: 'set null' }),
    /** "Ekler" folder of a space conversation (created on the first attachment). */
    attachmentsNodeId: uuid('attachments_node_id').references(() => nodes.id, {
      onDelete: 'set null',
    }),
    /** Sorted "userA:userB" of a direct conversation; one per pair. */
    directKey: text('direct_key'),
    lastSeq: bigint('last_seq', { mode: 'number' }).notNull().default(0),
    lastMessageAt: tz('last_message_at'),
    archivedAt: tz('archived_at'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  (t) => [
    index('conversations_org_last_idx').on(t.orgId, t.lastMessageAt),
    index('conversations_space_idx').on(t.spaceId),
    uniqueIndex('conversations_direct_uq')
      .on(t.orgId, t.directKey)
      .where(sql`${t.directKey} is not null`),
  ],
);

export const conversationMembers = pgTable(
  'conversation_members',
  {
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** Added without (all of) the history: earlier messages are never sent to them. */
    historyFromSeq: bigint('history_from_seq', { mode: 'number' }),
    /** "Benim için sil" (H19): messages up to this seq are hidden from this person only. */
    clearedAtSeq: bigint('cleared_at_seq', { mode: 'number' }),
    /** Personal archive (H19): out of this person's list until unarchived. */
    archivedAt: tz('archived_at'),
    pinnedAt: tz('pinned_at'),
    pinPosition: integer('pin_position'),
    notify: notifyLevel('notify').notNull(),
    mutedUntil: tz('muted_until'),
    addedBy: uuid('added_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  (t) => [
    primaryKey({ columns: [t.conversationId, t.userId] }),
    index('conversation_members_user_idx').on(t.userId),
  ],
);

/** Unread = messages with seq > last_read_seq (forward only, GREATEST). */
export const readStates = pgTable(
  'read_states',
  {
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    lastReadSeq: bigint('last_read_seq', { mode: 'number' }).notNull().default(0),
    /**
     * "Okunmadı olarak işaretle": counts as unread (at least 1) until the person reads it again,
     * even when only their own messages follow the read position.
     */
    markedUnread: boolean('marked_unread').notNull().default(false),
    updatedAt: tz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.conversationId, t.userId] }),
    index('read_states_user_idx').on(t.userId),
  ],
);

/**
 * Each forward move of a read position (seq from, exclusive, to, inclusive) and when it
 * happened: "Mesaj bilgisi" reads who saw a message and first when from here.
 */
export const readMarks = pgTable(
  'chat_read_marks',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    fromSeq: bigint('from_seq', { mode: 'number' }).notNull(),
    toSeq: bigint('to_seq', { mode: 'number' }).notNull(),
    at: tz('at').notNull().defaultNow(),
  },
  (t) => [index('chat_read_marks_conv_idx').on(t.conversationId, t.toSeq)],
);

/** Crewhall card or system line; `text` is the searchable body with mention tokens. */
export interface MessageBodyData {
  card?: Record<string, unknown>;
  system?: Record<string, unknown>;
  /** Sent on someone's behalf (MCP client, API token): shown as "Claude ile" (doc 17 §13). */
  via?: { kind: string; client: string; grant?: string | null; token?: string | null };
  /** Written on another installation (federation): who, and the message id there. */
  remote?: { address: string; name: string; domain: string; originId: string };
  /** Written by a meeting guest (no account): the guest's name and their lobby row. */
  guest?: { id: string; name: string };
  /** `/me` (roadmap 23): shown as an action line, "* Ayşe kahve almaya gitti". */
  emote?: boolean;
  /** `/poll`: the chat_polls row this message carries. */
  poll?: string;
  /** A GIF from GIPHY (MessageGif); the image stays on GIPHY's CDN. */
  gif?: {
    provider: 'giphy';
    id: string;
    url: string;
    previewUrl?: string | null;
    width: number;
    height: number;
    title: string;
  };
  /** Posted by an automation rule (roadmap 17): the bot shows the rule's name. */
  automation?: { ruleId: string; ruleName: string };
  /** Internal references (ids only; titles are resolved per viewer). */
  refs?: { kind: 'node' | 'card'; id: string }[];
  /** "Ben bakıyorum" on a webhook card: who took it (ISO time). */
  claim?: { userId: string; at: string };
}

export const messages = pgTable(
  'messages',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    seq: bigint('seq', { mode: 'number' }).notNull(),
    kind: messageKind('kind').notNull().default('user'),
    authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
    webhookId: uuid('webhook_id').references((): AnyPgColumn => incomingWebhooks.id, {
      onDelete: 'set null',
    }),
    body: jsonb('body').$type<MessageBodyData>().notNull().default({}),
    text: text('text').notNull().default(''),
    replyToId: uuid('reply_to_id').references((): AnyPgColumn => messages.id, {
      onDelete: 'set null',
    }),
    clientMsgId: uuid('client_msg_id'),
    /**
     * `/whisper` (roadmap 23): only the author and this person see the message; everyone
     * else gets a seq gap (reads, search, previews and events all skip it).
     */
    whisperTo: uuid('whisper_to').references(() => users.id, { onDelete: 'cascade' }),
    pinnedAt: tz('pinned_at'),
    pinnedBy: uuid('pinned_by').references(() => users.id, { onDelete: 'set null' }),
    editedAt: tz('edited_at'),
    deletedAt: tz('deleted_at'),
    deletedBy: uuid('deleted_by').references(() => users.id, { onDelete: 'set null' }),
    /** 'simple' config: the same column serves Turkish and English text. */
    search: tsvector('search').generatedAlwaysAs(
      (): SQL =>
        sql`to_tsvector('simple', case when ${messages.deletedAt} is null then ${messages.text} else '' end)`,
    ),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('messages_conversation_seq_uq').on(t.conversationId, t.seq),
    uniqueIndex('messages_author_client_uq')
      .on(t.authorId, t.clientMsgId)
      .where(sql`${t.clientMsgId} is not null`),
    index('messages_conversation_updated_idx').on(t.conversationId, t.updatedAt),
    index('messages_pinned_idx')
      .on(t.conversationId, t.pinnedAt)
      .where(sql`${t.pinnedAt} is not null`),
    index('messages_search_gin').using('gin', t.search),
  ],
);

/** Files of a message: Drive nodes in the conversation's or the sender's attachment folder. */
export const messageAttachments = pgTable(
  'message_attachments',
  {
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    nodeId: uuid('node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    position: integer('position').notNull().default(0),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.messageId, t.nodeId] }),
    index('message_attachments_conversation_idx').on(t.conversationId, t.createdAt),
    index('message_attachments_node_idx').on(t.nodeId),
  ],
);

export const reactions = pgTable(
  'reactions',
  {
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    emoji: text('emoji').notNull(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.messageId, t.userId, t.emoji] }),
    index('reactions_user_idx').on(t.userId, t.createdAt),
  ],
);

/**
 * One row per mention as written (`user_id` null for @all / @here) and one per person it
 * reached (`notified_user_id`), which unread mention counts read.
 */
export const mentions = pgTable(
  'mentions',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    seq: bigint('seq', { mode: 'number' }).notNull(),
    kind: mentionKind('kind').notNull(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    notifiedUserId: uuid('notified_user_id').references(() => users.id, { onDelete: 'cascade' }),
    seenAt: tz('seen_at'),
  },
  (t) => [
    index('mentions_message_idx').on(t.messageId),
    index('mentions_notified_idx').on(t.notifiedUserId, t.conversationId, t.seq),
  ],
);

export const incomingWebhooks = pgTable(
  'incoming_webhooks',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id')
      .notNull()
      .references((): AnyPgColumn => conversations.id, { onDelete: 'cascade' }),
    name: textTr('name').notNull(),
    avatarBlobId: uuid('avatar_blob_id').references(() => blobs.id, { onDelete: 'set null' }),
    /** sha256 of the URL key, hex; the key itself is never stored. */
    tokenHash: text('token_hash').notNull(),
    /** Service integration (github, azure_devops, jira); null = Crewhall / Google Chat body. */
    provider: text('provider', { enum: ['github', 'azure_devops', 'jira'] }),
    /** The service events it posts; others are answered 202 and dropped. */
    events: text('events')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** Signing secret (encrypted with the org key): HMAC for GitHub/Jira, Basic auth for Azure. */
    secretEnc: text('secret_enc'),
    rateLimit: integer('rate_limit').notNull().default(60),
    lastUsedAt: tz('last_used_at'),
    mutedUntil: tz('muted_until'),
    disabledAt: tz('disabled_at'),
    /** Last "requests are being rejected" mail to the conversation admins (once a day). */
    failingNotifiedAt: tz('failing_notified_at'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  (t) => [index('incoming_webhooks_conversation_idx').on(t.conversationId)],
);

/** Delivery log (4.14): rows 7 days in the UI, bodies dropped after 30 days. */
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    webhookId: uuid('webhook_id')
      .notNull()
      .references(() => incomingWebhooks.id, { onDelete: 'cascade' }),
    receivedAt: tz('received_at').notNull().defaultNow(),
    status: integer('status').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    ip: text('ip'),
    latencyMs: integer('latency_ms').notNull(),
    error: text('error'),
    bodyExcerpt: text('body_excerpt'),
    messageId: uuid('message_id').references(() => messages.id, { onDelete: 'set null' }),
  },
  (t) => [index('webhook_deliveries_webhook_idx').on(t.webhookId, t.receivedAt)],
);

export const notifications = pgTable(
  'notifications',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    category: text('category').notNull(),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    targetType: text('target_type').notNull(),
    targetId: uuid('target_id').notNull(),
    conversationId: uuid('conversation_id').references(() => conversations.id, {
      onDelete: 'cascade',
    }),
    seq: bigint('seq', { mode: 'number' }),
    spaceId: uuid('space_id').references(() => spaces.id, { onDelete: 'cascade' }),
    payload: jsonb('payload')
      .$type<Record<string, string | number | boolean | null>>()
      .notNull()
      .default({}),
    url: text('url').notNull(),
    groupKey: text('group_key'),
    count: integer('count').notNull().default(1),
    /** Push wanted at creation (prefs, quiet hours, critical); the job decides on focus. */
    wantsPush: boolean('wants_push').notNull().default(false),
    /** Why it will not push (preference, quiet hours, someone at a session…); null: it may. */
    pushSkip: text('push_skip'),
    /** What each device's provider answered, written when the push ran. */
    pushOutcome:
      jsonb('push_outcome').$type<
        { deviceId: string; provider: string; ok: boolean; error?: string }[]
      >(),
    /** Show an OS notification (desktop channel, not silenced); rows before it: as before. */
    wantsDesktop: boolean('wants_desktop').notNull().default(true),
    wantsEmail: boolean('wants_email').notNull().default(false),
    /** Pierces quiet hours and Do not disturb (critical alerts). */
    urgent: boolean('urgent').notNull().default(false),
    readAt: tz('read_at'),
    snoozedUntil: tz('snoozed_until'),
    dismissedAt: tz('dismissed_at'),
    pushedAt: tz('pushed_at'),
    emailedAt: tz('emailed_at'),
    ...timestamps(),
  },
  (t) => [
    index('notifications_user_idx').on(t.userId, t.orgId, t.updatedAt),
    // Rows sharing a group key merge while unread.
    uniqueIndex('notifications_group_uq')
      .on(t.userId, t.orgId, t.groupKey)
      .where(sql`${t.groupKey} is not null and ${t.readAt} is null and ${t.dismissedAt} is null`),
    index('notifications_unread_idx')
      .on(t.userId, t.orgId)
      .where(sql`${t.readAt} is null and ${t.dismissedAt} is null`),
  ],
);

/** Missing rows fall back to the defaults in code. */
export const notificationPrefs = pgTable(
  'notification_prefs',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    category: text('category').notNull(),
    inApp: boolean('in_app').notNull(),
    push: boolean('push').notNull(),
    email: boolean('email').notNull(),
    /** OS notifications (desktop app, browser); null: as the bell. */
    desktop: boolean('desktop'),
    updatedAt: tz('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.userId, t.category] })],
);

/** Per person and org: status, read receipts, quiet hours, digest. */
export const chatUserSettings = pgTable(
  'chat_user_settings',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    readReceipts: boolean('read_receipts').notNull().default(true),
    timezone: text('timezone'),
    visibility: statusVisibility('visibility').notNull().default('online'),
    visibilityUntil: tz('visibility_until'),
    statusText: text('status_text'),
    statusEmoji: text('status_emoji'),
    statusExpiresAt: tz('status_expires_at'),
    autoMeeting: boolean('auto_meeting').notNull().default(true),
    digest: digestFrequency('digest').notNull().default('daily'),
    quietFrom: text('quiet_from'),
    quietTo: text('quiet_to'),
    lastDigestAt: tz('last_digest_at'),
    ...timestamps(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.userId] })],
);

export const pushDevices = pgTable(
  'push_devices',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The push token: `ExponentPushToken[…]` (Expo), an FCM registration token or an iOS VoIP token. */
    expoToken: text('expo_token').notNull().unique(),
    provider: text('provider', { enum: ['expo', 'fcm', 'voip'] })
      .notNull()
      .default('expo'),
    platform: pushPlatform('platform').notNull(),
    appVersion: text('app_version'),
    /** VoIP tokens: sandbox (development builds) or production; null: APNS_ENV, then the other. */
    apnsEnvironment: text('apns_environment', { enum: ['sandbox', 'production'] }),
    lastSeenAt: tz('last_seen_at').notNull().defaultNow(),
    disabledAt: tz('disabled_at'),
    /** "Bu cihazda bildirim alma": no push to this device until then. */
    mutedUntil: tz('muted_until'),
    /** What turned it off (the provider's answer). */
    disabledReason: text('disabled_reason'),
    ...timestamps(),
  },
  (t) => [index('push_devices_user_idx').on(t.userId, t.orgId)],
);

/** Expo tickets waiting for their receipt (checked 15 minutes later). */
export const pushTickets = pgTable(
  'push_tickets',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => pushDevices.id, { onDelete: 'cascade' }),
    /** Expo push ticket id, or the Notifike message id (push sent through Notifike). */
    ticketId: text('ticket_id').notNull(),
    provider: text('provider', { enum: ['expo', 'notifike'] })
      .notNull()
      .default('expo'),
    notificationId: uuid('notification_id').references(() => notifications.id, {
      onDelete: 'set null',
    }),
    createdAt: tz('created_at').notNull().defaultNow(),
    checkedAt: tz('checked_at'),
    error: text('error'),
  },
  (t) => [
    index('push_tickets_pending_idx')
      .on(t.createdAt)
      .where(sql`${t.checkedAt} is null`),
  ],
);

/** One-time WebSocket tickets (30 s); stored so any API node can accept them. */
export const wsTickets = pgTable(
  'ws_tickets',
  {
    /** sha256 of the ticket, hex. */
    tokenHash: text('token_hash').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id'),
    expiresAt: tz('expires_at').notNull(),
    usedAt: tz('used_at'),
  },
  (t) => [index('ws_tickets_expires_idx').on(t.expiresAt)],
);

/** `/poll` (roadmap 23): a poll message; votes are live (message.updated on every vote). */
export const chatPolls = pgTable(
  'chat_polls',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    messageId: uuid('message_id')
      .notNull()
      .unique()
      .references(() => messages.id, { onDelete: 'cascade' }),
    question: text('question').notNull(),
    options: jsonb('options').$type<string[]>().notNull(),
    multiple: boolean('multiple').notNull().default(false),
    closedAt: tz('closed_at'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  (t) => [index('chat_polls_conversation_idx').on(t.conversationId)],
);

export const chatPollVotes = pgTable(
  'chat_poll_votes',
  {
    pollId: uuid('poll_id')
      .notNull()
      .references(() => chatPolls.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    option: integer('option').notNull(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.pollId, t.userId, t.option] })],
);

/** `/remind` (roadmap 23): fired by the chat.reminders job as a notification to its owner. */
export const chatReminders = pgTable(
  'chat_reminders',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    text: text('text').notNull(),
    remindAt: tz('remind_at').notNull(),
    firedAt: tz('fired_at'),
    ...timestamps(),
  },
  (t) => [
    index('chat_reminders_due_idx')
      .on(t.remindAt)
      .where(sql`${t.firedAt} is null`),
    index('chat_reminders_user_idx').on(t.userId, t.orgId),
  ],
);

export const scheduledMessageStatus = pgEnum('scheduled_message_status', [
  'scheduled',
  'sending',
  'sent',
  'cancelled',
  'failed',
]);

/**
 * "Daha sonra gönder" and `/zamanla`: written now, posted at `send_at` as a normal message by
 * the chat.scheduled job (mentions and pushes happen then). `sending` is a short claim so
 * two workers never post the same one.
 */
export const scheduledMessages = pgTable(
  'chat_scheduled_messages',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    text: text('text').notNull().default(''),
    replyToId: uuid('reply_to_id').references(() => messages.id, { onDelete: 'set null' }),
    attachmentNodeIds: uuid('attachment_node_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    refs: jsonb('refs').$type<{ kind: 'node' | 'card'; id: string }[]>().notNull().default([]),
    confirmMentionAll: boolean('confirm_mention_all').notNull().default(false),
    sendAt: tz('send_at').notNull(),
    status: scheduledMessageStatus('status').notNull().default('scheduled'),
    error: text('error'),
    messageId: uuid('message_id').references(() => messages.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  (t) => [
    index('chat_scheduled_due_idx')
      .on(t.sendAt)
      .where(sql`${t.status} = 'scheduled'`),
    index('chat_scheduled_author_idx').on(t.authorId, t.conversationId),
  ],
);

/**
 * GIFs in chat (Yönetim › Entegrasyonlar › GIF): the org's own GIPHY key, encrypted like the AI
 * key (AUTH_SECRET, org id as associated data) and never returned. No row: GIFs are off.
 */
export const chatGifSettings = pgTable('chat_gif_settings', {
  orgId: uuid('org_id')
    .primaryKey()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  enabled: boolean('enabled').notNull().default(false),
  apiKeyEnc: text('api_key_enc'),
  apiKeyHint: text('api_key_hint'),
  apiKeyUpdatedAt: tz('api_key_updated_at'),
  rating: text('rating', { enum: ['g', 'pg', 'pg-13', 'r'] })
    .notNull()
    .default('g'),
  lang: text('lang').notNull().default('tr'),
  /** beta: an hourly budget of GIPHY calls (about 100/hour on GIPHY's side); production: none. */
  keyTier: text('key_tier', { enum: ['beta', 'production'] })
    .notNull()
    .default('beta'),
  /** GIPHY calls in the current hour (cache hits do not count). */
  usageHour: tz('usage_hour'),
  usageCount: integer('usage_count').notNull().default(0),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  ...timestamps(),
});
