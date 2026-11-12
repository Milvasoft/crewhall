import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './auth';
import { conversations, messages } from './chat';
import { organizations } from './org';
import { nodes } from './space';
import { id, timestamps, tz } from './types';

/**
 * Federation (roadmap 26, docs/contracts/federasyon.md): other Crewhall installations this
 * one chats and shares with. Every table carries org_id.
 */

/** The installation's Ed25519 key; the private half is AES-GCM encrypted with AUTH_SECRET. */
export const federationKeys = pgTable('federation_keys', {
  orgId: uuid('org_id')
    .primaryKey()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  /** SPKI DER, base64. */
  publicKey: text('public_key').notNull(),
  privateKeyEnc: text('private_key_enc').notNull(),
  /**
   * This database's identity, sent in `peer.request`. A new one (a restored or reset
   * installation, the hourly demo) tells peers that their links to us are gone.
   */
  instanceId: uuid('instance_id')
    .notNull()
    .default(sql`gen_random_uuid()`),
  createdAt: tz('created_at').notNull().defaultNow(),
});

/**
 * An installation we federate with. Active when both sides added each other (`weAdded` and
 * `theyAdded`) and the domain is on the allowed list; anything else is pending.
 */
export const federationPeers = pgTable(
  'federation_peers',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    domain: text('domain').notNull(),
    name: text('name'),
    /** SPKI DER, base64, from their discovery document. */
    publicKey: text('public_key'),
    weAdded: boolean('we_added').notNull().default(false),
    theyAdded: boolean('they_added').notNull().default(false),
    addedBy: uuid('added_by').references(() => users.id, { onDelete: 'set null' }),
    /** Their `instanceId` from the last `peer.request`. */
    remoteInstanceId: uuid('remote_instance_id'),
    lastSeenAt: tz('last_seen_at'),
    ...timestamps(),
  },
  (t) => [uniqueIndex('federation_peers_domain_uq').on(t.orgId, t.domain)],
);

/** A local person's federated handle (`handle@domain`), fixed once given. */
export const federationHandles = pgTable(
  'federation_handles',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    handle: text('handle').notNull(),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('federation_handles_handle_uq').on(t.orgId, t.handle)],
);

/** A person on a peer installation; never a row in `users` (cannot sign in here). */
export const federationUsers = pgTable(
  'federation_users',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    peerId: uuid('peer_id')
      .notNull()
      .references(() => federationPeers.id, { onDelete: 'cascade' }),
    handle: text('handle').notNull(),
    name: text('name').notNull(),
    ...timestamps(),
  },
  (t) => [uniqueIndex('federation_users_handle_uq').on(t.peerId, t.handle)],
);

/**
 * A local conversation shared with a peer. `remoteConversationId` is the peer's copy (null
 * until it answers the invite); `homeDomain` is the installation that relays messages.
 */
export const federationConversations = pgTable(
  'federation_conversations',
  {
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    peerId: uuid('peer_id')
      .notNull()
      .references(() => federationPeers.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    remoteConversationId: uuid('remote_conversation_id'),
    homeDomain: text('home_domain').notNull(),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.conversationId, t.peerId] }),
    index('federation_conversations_remote_idx').on(t.peerId, t.remoteConversationId),
  ],
);

/** Remote people in a conversation. */
export const federationMembers = pgTable(
  'federation_members',
  {
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    remoteUserId: uuid('remote_user_id')
      .notNull()
      .references(() => federationUsers.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    addedBy: uuid('added_by').references(() => users.id, { onDelete: 'set null' }),
    /** Blocked by a moderator: their messages and reactions are refused here. */
    blockedAt: tz('blocked_at'),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.conversationId, t.remoteUserId] })],
);

/**
 * A channel shared at organization level (kararlar.md 2026-10-29). The host keeps one row per
 * guest organization, each guest one row for the host; both carry the host's row id
 * (`hostShareId`), which every share activity names.
 */
export const federationSharedChannels = pgTable(
  'federation_shared_channels',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    peerId: uuid('peer_id')
      .notNull()
      .references(() => federationPeers.id, { onDelete: 'cascade' }),
    role: text('role').$type<'host' | 'guest'>().notNull(),
    status: text('status')
      .$type<
        'invited' | 'pending' | 'active' | 'declined' | 'expired' | 'removed' | 'left' | 'ended'
      >()
      .notNull(),
    hostShareId: uuid('host_share_id').notNull(),
    /** Host: the shared channel; guest: the local copy (null until accepted). */
    conversationId: uuid('conversation_id').references(() => conversations.id, {
      onDelete: 'set null',
    }),
    /** Guest: the host's channel id, from the invite. */
    remoteConversationId: uuid('remote_conversation_id'),
    channelName: text('channel_name').notNull(),
    invitedBy: text('invited_by'),
    invitedById: uuid('invited_by_id').references(() => users.id, { onDelete: 'set null' }),
    acceptedById: uuid('accepted_by_id').references(() => users.id, { onDelete: 'set null' }),
    expiresAt: tz('expires_at'),
    /**
     * Guest side: the host's channel meeting while it is going on (`meeting.status`); null
     * when no meeting is live (shared channels 2).
     */
    meetingTitle: text('meeting_title'),
    meetingStartedAt: tz('meeting_started_at'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('federation_shared_channels_uq').on(t.orgId, t.peerId, t.hostShareId),
    index('federation_shared_channels_conversation_idx').on(t.conversationId),
  ],
);

/** Reactions of people on other installations (they have no `users` row here). */
export const federationReactions = pgTable(
  'federation_reactions',
  {
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    address: text('address').notNull(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    emoji: text('emoji').notNull(),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.messageId, t.address, t.emoji] })],
);

/**
 * Files of shared-channel messages. `out`: a file of ours offered to peers under a random
 * id (`id`), served by POST /api/federation/v1/files; `in`: a peer's file announced with a
 * message, pulled by the `federation.file_pull` job into this channel's Ekler folder.
 */
export const federationFiles = pgTable(
  'federation_files',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<'out' | 'in'>().notNull(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    /** out: the file offered; in: the local copy once pulled. */
    nodeId: uuid('node_id').references(() => nodes.id, { onDelete: 'set null' }),
    /** in: the installation and id to pull from. */
    peerId: uuid('peer_id').references(() => federationPeers.id, { onDelete: 'cascade' }),
    originRef: uuid('origin_ref'),
    name: text('name').notNull(),
    mime: text('mime'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    position: integer('position').notNull().default(0),
    status: text('status').$type<'ready' | 'pending' | 'done' | 'failed'>().notNull(),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('federation_files_message_idx').on(t.messageId),
    index('federation_files_node_idx').on(t.nodeId),
  ],
);

/**
 * Activities received, for 24 hours: a replayed or retried one gets the first answer and is
 * not applied twice.
 */
export const federationInbox = pgTable(
  'federation_inbox',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    domain: text('domain').notNull(),
    activityId: uuid('activity_id').notNull(),
    response: jsonb('response').$type<Record<string, unknown>>().notNull(),
    receivedAt: tz('received_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.domain, t.activityId] }),
    index('federation_inbox_received_idx').on(t.receivedAt),
  ],
);

/**
 * Shared channels 2: a Drive folder of a shared channel, kept in step with the other
 * organizations. The host keeps one row per folder, each guest one row for its copy; both
 * carry the host's row id (`hostFolderId`).
 */
export const federationSharedFolders = pgTable(
  'federation_shared_folders',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    /** Guest: the host it came from; null on the host. */
    peerId: uuid('peer_id').references(() => federationPeers.id, { onDelete: 'cascade' }),
    role: text('role').$type<'host' | 'guest'>().notNull(),
    status: text('status').$type<'active' | 'ended'>().notNull(),
    hostFolderId: uuid('host_folder_id').notNull(),
    /** This organization's copy; null once it was deleted here. */
    rootNodeId: uuid('root_node_id').references(() => nodes.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('federation_shared_folders_uq').on(t.orgId, t.hostFolderId),
    index('federation_shared_folders_conversation_idx').on(t.conversationId),
  ],
);

/**
 * One file or folder of a shared folder as last sent or applied here: the scan compares Drive
 * with it to find local changes. `originDomain`/`originId` is the item's identity everywhere;
 * `version` the content stamp (a file's current version where it last changed).
 */
export const federationFolderItems = pgTable(
  'federation_folder_items',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    folderId: uuid('folder_id')
      .notNull()
      .references(() => federationSharedFolders.id, { onDelete: 'cascade' }),
    originDomain: text('origin_domain').notNull(),
    originId: uuid('origin_id').notNull(),
    nodeId: uuid('node_id').references(() => nodes.id, { onDelete: 'set null' }),
    type: text('type').$type<'file' | 'folder'>().notNull(),
    name: text('name').notNull(),
    /** The parent item's identity; null for the shared folder's top level. */
    parentDomain: text('parent_domain'),
    parentOriginId: uuid('parent_origin_id'),
    /** Local state when last synced: the scan's baseline. */
    localParentId: uuid('local_parent_id'),
    localVersionId: uuid('local_version_id'),
    version: text('version'),
    /** A newer content stamp being pulled. */
    pendingVersion: text('pending_version'),
    /** Last change time from the origin (last writer wins for name and place). */
    changedAt: tz('changed_at').notNull(),
    deletedAt: tz('deleted_at'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('federation_folder_items_origin_uq').on(t.folderId, t.originDomain, t.originId),
    index('federation_folder_items_node_idx').on(t.nodeId),
  ],
);
