import { sql } from 'drizzle-orm';
import {
  boolean,
  customType,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { users } from './auth';
import { nodeVersions, versionSource } from './drive';
import { organizations } from './org';
import { nodes } from './space';
import { id, timestamps, tz } from './types';
import { bytea } from './vault';

/**
 * Wiki / Sayfalar (doc 17 §4 "Sayfa, pano, çizim" and "comments · page_refs"; §6
 * "Ortak düzenleme"). Owned by the wiki session.
 *
 * The Yjs state in `pages.ydoc` is the source of truth; markdown, body text, the search
 * vector, word count and page_refs are derived from it by the worker (`page.snapshot`).
 * Clients never write those columns.
 */

const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });

export const pageRefKind = pgEnum('page_ref_kind', ['link', 'mention', 'embed']);

/** Search vector over both stemmers: Turkish and English queries match the same row. */
export const bilingualTsvector = (expr: string) =>
  `to_tsvector('turkish'::regconfig, ${expr}) || to_tsvector('english'::regconfig, ${expr})`;

export const pages = pgTable(
  'pages',
  {
    nodeId: uuid('node_id')
      .primaryKey()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** Y.encodeStateAsUpdate of the page document; written by the collab server. */
    ydoc: bytea('ydoc'),
    markdown: text('markdown').notNull().default(''),
    /** Plain text of the body (search snippets, reading time). */
    bodyText: text('body_text').notNull().default(''),
    /** Title (weight A) + body (weight B), both stemmers; set by the worker. */
    search: tsvector('search'),
    wordCount: integer('word_count').notNull().default(0),
    icon: text('icon'),
    cover: text('cover'),
    fullWidth: boolean('full_width').notNull().default(false),
    smallText: boolean('small_text').notNull().default(false),
    locked: boolean('locked').notNull().default(false),
    /** Bumped on every store; the worker derives when snapshot_rev > derived_rev. */
    snapshotRev: integer('snapshot_rev').notNull().default(0),
    derivedRev: integer('derived_rev').notNull().default(0),
    /** Revision the newest version was taken at (no version when nothing changed). */
    versionedRev: integer('versioned_rev').notNull().default(0),
    /** People who edited since the last version (collab appends, the version job clears). */
    pendingEditors: uuid('pending_editors')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    lastSource: versionSource('last_source'),
    editedAt: tz('edited_at'),
    editedBy: uuid('edited_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  (t) => [index('pages_search_gin').using('gin', t.search), index('pages_org_idx').on(t.orgId)],
);

/**
 * Page comment threads (doc 17 "comments"; named page_comments so other modules keep the
 * plain name free). A thread is its root row; replies point at it with root_id.
 */
export const pageComments = pgTable(
  'page_comments',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    nodeId: uuid('node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    rootId: uuid('root_id').references((): AnyPgColumn => pageComments.id, {
      onDelete: 'cascade',
    }),
    authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
    body: text('body').notNull(),
    mentions: uuid('mentions')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    /** Yjs relative positions (Y.encodeRelativePosition) of the commented range. */
    anchorStart: bytea('anchor_start'),
    anchorEnd: bytea('anchor_end'),
    quote: text('quote'),
    resolvedAt: tz('resolved_at'),
    resolvedBy: uuid('resolved_by').references(() => users.id, { onDelete: 'set null' }),
    editedAt: tz('edited_at'),
    search: tsvector('search').generatedAlwaysAs(sql.raw(bilingualTsvector('body'))),
    ...timestamps(),
  },
  (t) => [
    index('page_comments_node_idx').on(t.nodeId, t.rootId),
    index('page_comments_search_gin').using('gin', t.search),
  ],
);

/** Links, mentions and embeds between nodes; feeds backlinks (doc 17 "page_refs"). */
export const pageRefs = pgTable(
  'page_refs',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    fromNodeId: uuid('from_node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    toNodeId: uuid('to_node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    kind: pageRefKind('kind').notNull(),
    ...timestamps(),
  },
  (t) => [
    primaryKey({ columns: [t.fromNodeId, t.toNodeId, t.kind] }),
    index('page_refs_to_idx').on(t.toNodeId),
  ],
);

/** People @mentioned in a page body; a person is notified once per page (first mention). */
export const pageMentions = pgTable(
  'page_mentions',
  {
    nodeId: uuid('node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    mentionedBy: uuid('mentioned_by').references(() => users.id, { onDelete: 'set null' }),
    notifiedAt: tz('notified_at'),
    ...timestamps(),
  },
  (t) => [primaryKey({ columns: [t.nodeId, t.userId] })],
);

/**
 * Yjs snapshot of a page version. The version itself is a node_versions row (shared with
 * Drive's history); doc 17 puts `ydoc` on node_versions, kept here 1:1 so the Drive table
 * stays as phase 1 shipped it.
 */
export const pageSnapshots = pgTable(
  'page_snapshots',
  {
    versionId: uuid('version_id')
      .primaryKey()
      .references(() => nodeVersions.id, { onDelete: 'cascade' }),
    nodeId: uuid('node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    ydoc: bytea('ydoc').notNull(),
    markdown: text('markdown').notNull().default(''),
    editorIds: uuid('editor_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    restoredFrom: integer('restored_from'),
    ...timestamps(),
  },
  (t) => [index('page_snapshots_node_idx').on(t.nodeId)],
);

export const pageExportFormat = pgEnum('page_export_format', ['md', 'html', 'docx', 'pdf']);
export const pageExportStatus = pgEnum('page_export_status', [
  'queued',
  'running',
  'ready',
  'failed',
]);

/**
 * "Dışa aktar" (roadmap 6): one export of a page (and its sub-pages) built by the worker
 * (`page.export`). The file lives in object storage under `storage_key` until `expires_at`;
 * the sweep removes both. Only the person who asked can download it.
 */
export const pageExports = pgTable(
  'page_exports',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    nodeId: uuid('node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    format: pageExportFormat('format').notNull(),
    children: boolean('children').notNull().default(false),
    status: pageExportStatus('status').notNull().default('queued'),
    fileName: text('file_name'),
    storageKey: text('storage_key'),
    sizeBytes: integer('size_bytes'),
    pageCount: integer('page_count'),
    /** Files that could not be included (too large, unreadable), by name. */
    skipped: text('skipped')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    error: text('error'),
    finishedAt: tz('finished_at'),
    expiresAt: tz('expires_at'),
    ...timestamps(),
  },
  (t) => [
    index('page_exports_user_idx').on(t.userId, t.createdAt),
    index('page_exports_expires_idx').on(t.expiresAt),
  ],
);
