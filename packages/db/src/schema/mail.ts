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
import { spaces } from './space';
import { id, timestamps, tz } from './types';

/**
 * Mail module (roadmap 24): a webmail client for the org's own IMAP/SMTP server. Mail itself
 * stays on that server. Passwords and OAuth tokens are stored encrypted with a key derived
 * from AUTH_SECRET (AES-256-GCM); OAuth states only for the few minutes of the sign-in.
 */

export const mailSecurity = pgEnum('mail_security', ['tls', 'starttls', 'none']);
export const mailAuthMode = pgEnum('mail_auth_mode', [
  'password',
  'oauth_microsoft',
  'oauth_google',
]);
/** `shared`: a shared inbox's address (mail_shared_inboxes), not a person's mailbox. */
export const mailAccountKind = pgEnum('mail_account_kind', ['personal', 'shared']);

export const mailAccountStatus = pgEnum('mail_account_status', [
  'ok',
  'auth_failed',
  'unreachable',
]);

/** Per-org server settings; a missing row means the module is not configured yet. */
export const mailSettings = pgTable('mail_settings', {
  orgId: uuid('org_id')
    .primaryKey()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  imapHost: text('imap_host').notNull(),
  imapPort: integer('imap_port').notNull(),
  imapSecurity: mailSecurity('imap_security').notNull(),
  smtpHost: text('smtp_host').notNull(),
  smtpPort: integer('smtp_port').notNull(),
  smtpSecurity: mailSecurity('smtp_security').notNull(),
  authMode: mailAuthMode('auth_mode').notNull().default('password'),
  /** `email` or `local`: what is sent as the login name when the user gives none. */
  usernameFormat: text('username_format').notNull().default('email'),
  oauthClientId: text('oauth_client_id'),
  oauthClientSecretEnc: text('oauth_client_secret_enc'),
  oauthTenant: text('oauth_tenant'),
  saveSentCopy: boolean('save_sent_copy').notNull().default(true),
  allowRemoteImages: boolean('allow_remote_images').notNull().default(true),
  pollMinutes: integer('poll_minutes').notNull().default(5),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  ...timestamps(),
});

/** One mailbox per user and org. */
export const mailAccounts = pgTable(
  'mail_accounts',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Personal: the owner. Shared: the admin who added the inbox (the inbox is the space's). */
    kind: mailAccountKind('kind').notNull().default('personal'),
    email: text('email').notNull(),
    displayName: text('display_name').notNull().default(''),
    username: text('username').notNull(),
    authMode: mailAuthMode('auth_mode').notNull(),
    passwordEnc: text('password_enc'),
    oauthAccessEnc: text('oauth_access_enc'),
    oauthRefreshEnc: text('oauth_refresh_enc'),
    oauthExpiresAt: tz('oauth_expires_at'),
    /**
     * Shared inbox signed in by an admin: whose token it is. Microsoft 365 opens the shared
     * mailbox over IMAP as the inbox's address, but SMTP signs in as the token's owner (who sends
     * as the inbox with SendAs).
     */
    oauthUser: text('oauth_user'),
    status: mailAccountStatus('status').notNull().default('ok'),
    signatureHtml: text('signature_html').notNull().default(''),
    notify: boolean('notify').notNull().default(true),
    /** New-mail watermark of INBOX for the worker (UIDVALIDITY and the highest UID seen). */
    inboxUidValidity: bigint('inbox_uid_validity', { mode: 'number' }),
    inboxLastUid: bigint('inbox_last_uid', { mode: 'number' }),
    lastCheckedAt: tz('last_checked_at'),
    /**
     * Last folder list (paths, special uses, counters) from the server: the sidebar is drawn
     * from it at once while the background asks again (services/mail/folders.ts).
     */
    folders: jsonb('folders').$type<MailFolderSnapshot[]>(),
    foldersAt: tz('folders_at'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('mail_accounts_org_user_idx')
      .on(t.orgId, t.userId)
      .where(sql`${t.kind} = 'personal'`),
    index('mail_accounts_org_idx').on(t.orgId),
  ],
);

/** OAuth2 sign-ins in progress (state → PKCE verifier); rows live ten minutes. */
export const mailOauthStates = pgTable('mail_oauth_states', {
  /** sha256 of the `state` parameter. */
  stateHash: text('state_hash').primaryKey(),
  orgId: uuid('org_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  codeVerifierEnc: text('code_verifier_enc').notNull(),
  /** Signing in a shared inbox (its admin's token reads the inbox's mailbox); null: own mailbox. */
  inboxId: uuid('inbox_id').references(() => mailSharedInboxes.id, { onDelete: 'cascade' }),
  expiresAt: tz('expires_at').notNull(),
  createdAt: tz('created_at').notNull().defaultNow(),
});

/** Addresses a user wrote to, for recipient autocomplete. */
export const mailRecentRecipients = pgTable(
  'mail_recent_recipients',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Lower-cased address. */
    address: text('address').notNull(),
    name: text('name'),
    useCount: integer('use_count').notNull().default(1),
    lastUsedAt: tz('last_used_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.userId, t.address] })],
);

/** Folder-wide read / unread / move / delete jobs (worker `mail.bulk`); progress for the client. */
export const mailBulkJobs = pgTable(
  'mail_bulk_jobs',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => mailAccounts.id, { onDelete: 'cascade' }),
    folder: text('folder').notNull(),
    action: text('action', { enum: ['seen', 'unseen', 'move', 'delete'] }).notNull(),
    target: text('target'),
    status: text('status', { enum: ['queued', 'running', 'done', 'failed'] })
      .notNull()
      .default('queued'),
    total: integer('total'),
    done: integer('done').notNull().default(0),
    error: text('error'),
    finishedAt: tz('finished_at'),
    ...timestamps(),
  },
  (t) => [index('mail_bulk_jobs_account_idx').on(t.accountId, t.status)],
);

/** One folder of `mail_accounts.folders` (the MailFolder shape of the API). */
export interface MailFolderSnapshot {
  path: string;
  name: string;
  parent: string | null;
  delimiter: string | null;
  specialUse: 'inbox' | 'sent' | 'drafts' | 'trash' | 'junk' | 'archive' | null;
  total: number;
  unread: number;
}

/** One MIME leaf of a cached message (from BODYSTRUCTURE): enough to fetch only what is shown. */
export interface MailPartInfo {
  part: string;
  type: string;
  disposition: string | null;
  filename: string | null;
  size: number;
  contentId: string | null;
  /** Content-Transfer-Encoding (base64, quoted-printable, 7bit…); BODY[part] arrives encoded. */
  encoding?: string | null;
  charset?: string | null;
}

/**
 * Header cache of a folder (envelope, flags, structure; never bodies). Lists, conversations and
 * searches read it instead of searching the IMAP folder each time; `mail_folder_state` says how
 * far it is in sync with the server (UIDVALIDITY, UIDNEXT, MODSEQ).
 */
export const mailHeaders = pgTable(
  'mail_headers',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => mailAccounts.id, { onDelete: 'cascade' }),
    folder: text('folder').notNull(),
    uid: bigint('uid', { mode: 'number' }).notNull(),
    messageId: text('message_id'),
    threadId: text('thread_id').notNull(),
    subject: text('subject').notNull().default(''),
    fromName: text('from_name'),
    fromAddress: text('from_address'),
    to: jsonb('to').$type<{ name: string | null; address: string }[]>().notNull().default([]),
    cc: jsonb('cc').$type<{ name: string | null; address: string }[]>().notNull().default([]),
    bcc: jsonb('bcc').$type<{ name: string | null; address: string }[]>().notNull().default([]),
    replyTo: jsonb('reply_to')
      .$type<{ name: string | null; address: string }[]>()
      .notNull()
      .default([]),
    inReplyTo: text('in_reply_to'),
    references: text('references')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    date: tz('date'),
    seen: boolean('seen').notNull().default(false),
    flagged: boolean('flagged').notNull().default(false),
    answered: boolean('answered').notNull().default(false),
    hasAttachments: boolean('has_attachments').notNull().default(false),
    size: integer('size').notNull().default(0),
    parts: jsonb('parts').$type<MailPartInfo[]>().notNull().default([]),
  },
  (t) => [
    primaryKey({ columns: [t.accountId, t.folder, t.uid] }),
    index('mail_headers_thread_idx').on(t.accountId, t.threadId),
  ],
);

export const mailFolderState = pgTable(
  'mail_folder_state',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => mailAccounts.id, { onDelete: 'cascade' }),
    folder: text('folder').notNull(),
    uidValidity: bigint('uid_validity', { mode: 'number' }).notNull(),
    /** Highest UID in the cache + 1 (the server's UIDNEXT when last synced). */
    uidNext: bigint('uid_next', { mode: 'number' }).notNull(),
    /** CONDSTORE HIGHESTMODSEQ when last synced (servers without CONDSTORE: null). */
    modseq: text('modseq'),
    /** Every message of the folder is cached (the first sync of a large folder runs in chunks). */
    complete: boolean('complete').notNull().default(false),
    /** Flags of old messages were last re-read (other devices' changes without CONDSTORE). */
    flagsSyncedAt: tz('flags_synced_at'),
    syncedAt: tz('synced_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.folder] })],
);

/* ------------------------------------------------------------------------------------- */
/* Shared inbox (sonraki-isler.md "Ortak gelen kutusu")                                   */
/* ------------------------------------------------------------------------------------- */

/**
 * An org address (destek@) worked by a space's members. Its IMAP side is an ordinary
 * `mail_accounts` row (kind `shared`), so the header cache, the background watcher and the body
 * cache serve it as they serve a person's mailbox; this row adds the team side.
 */
export const mailSharedInboxes = pgTable(
  'mail_shared_inboxes',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    spaceId: uuid('space_id')
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => mailAccounts.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** First response target; null = no SLA. */
    slaFirstResponseMinutes: integer('sla_first_response_minutes'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('mail_shared_inboxes_account_idx').on(t.accountId),
    index('mail_shared_inboxes_space_idx').on(t.spaceId),
    index('mail_shared_inboxes_org_idx').on(t.orgId),
  ],
);

export const mailConversationStatus = pgEnum('mail_conversation_status', [
  'open',
  'pending',
  'resolved',
]);

/** One mail thread of a shared inbox and its team state. Message facts come from mail_headers. */
export const mailConversations = pgTable(
  'mail_conversations',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    inboxId: uuid('inbox_id')
      .notNull()
      .references(() => mailSharedInboxes.id, { onDelete: 'cascade' }),
    threadId: text('thread_id').notNull(),
    subject: text('subject').notNull().default(''),
    customerName: text('customer_name'),
    customerAddress: text('customer_address'),
    status: mailConversationStatus('status').notNull().default('open'),
    assigneeId: uuid('assignee_id').references(() => users.id, { onDelete: 'set null' }),
    tags: text('tags')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    messageCount: integer('message_count').notNull().default(0),
    /** Incoming messages: one more than before reopens a pending or resolved conversation. */
    inboundCount: integer('inbound_count').notNull().default(0),
    unread: boolean('unread').notNull().default(false),
    firstMessageAt: tz('first_message_at').notNull(),
    /** First incoming message: the SLA clock starts here. */
    firstInboundAt: tz('first_inbound_at'),
    lastMessageAt: tz('last_message_at').notNull(),
    lastInboundAt: tz('last_inbound_at'),
    firstResponseAt: tz('first_response_at'),
    /** Last status change (a newer incoming message reopens a pending or resolved one). */
    statusChangedAt: tz('status_changed_at'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('mail_conversations_thread_idx').on(t.inboxId, t.threadId),
    index('mail_conversations_list_idx').on(t.inboxId, t.status, t.lastMessageAt),
    index('mail_conversations_assignee_idx').on(t.inboxId, t.assigneeId),
  ],
);

/** Internal notes of a conversation (never sent to the customer). */
export const mailConversationNotes = pgTable(
  'mail_conversation_notes',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => mailConversations.id, { onDelete: 'cascade' }),
    authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
    body: text('body').notNull(),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t) => [index('mail_conversation_notes_conversation_idx').on(t.conversationId)],
);

/** Saved replies of a shared inbox. */
export const mailCannedResponses = pgTable(
  'mail_canned_responses',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    inboxId: uuid('inbox_id')
      .notNull()
      .references(() => mailSharedInboxes.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    html: text('html').notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  (t) => [index('mail_canned_responses_inbox_idx').on(t.inboxId)],
);
