import { bigint, index, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './auth';
import { organizations } from './org';
import { id, timestamps, tz } from './types';

/**
 * Corporate compliance (roadmap 25): retention rules and DLP rules per org, legal holds
 * that exempt people's and spaces' content from every purge, the original text of held
 * chat messages that were edited or deleted, and eDiscovery exports built by the worker.
 */

/** One row per org; a missing row means no retention rules and no DLP rules. */
export const compliancePolicies = pgTable('compliance_policies', {
  orgId: uuid('org_id')
    .primaryKey()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  /** CompliancePolicy.retention */
  retention: jsonb('retention').$type<Record<string, unknown>>().notNull().default({}),
  /** CompliancePolicy.dlp */
  dlp: jsonb('dlp').$type<Record<string, unknown>>().notNull().default({}),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  ...timestamps(),
});

export const legalHolds = pgTable(
  'legal_holds',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    reason: text('reason'),
    /** Custodians: what they wrote, sent or created is held. */
    userIds: uuid('user_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    /** Everything in these spaces is held. */
    spaceIds: uuid('space_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: tz('created_at').notNull().defaultNow(),
    releasedAt: tz('released_at'),
    releasedBy: uuid('released_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [index('legal_holds_org_idx').on(t.orgId)],
);

/** Original text of a held message before an edit or a delete (kept while holds last). */
export const heldMessages = pgTable(
  'held_messages',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    messageId: uuid('message_id').notNull(),
    conversationId: uuid('conversation_id').notNull(),
    authorId: uuid('author_id'),
    /** edit | delete | conversation_delete */
    kind: text('kind').notNull(),
    text: text('text'),
    body: jsonb('body'),
    sentAt: tz('sent_at').notNull(),
    archivedAt: tz('archived_at').notNull().defaultNow(),
  },
  (t) => [
    index('held_messages_org_idx').on(t.orgId, t.sentAt),
    index('held_messages_author_idx').on(t.authorId),
  ],
);

export const ediscoveryExports = pgTable(
  'ediscovery_exports',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    requestedBy: uuid('requested_by').references(() => users.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    /** EdiscoveryScope */
    scope: jsonb('scope').$type<Record<string, unknown>>().notNull(),
    /** queued | running | ready | failed */
    status: text('status').notNull().default('queued'),
    storageKey: text('storage_key'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    /** Per-kind counts in the archive. */
    counts: jsonb('counts').$type<Record<string, number>>(),
    error: text('error'),
    createdAt: tz('created_at').notNull().defaultNow(),
    finishedAt: tz('finished_at'),
    expiresAt: tz('expires_at'),
  },
  (t) => [index('ediscovery_exports_org_idx').on(t.orgId, t.createdAt)],
);
