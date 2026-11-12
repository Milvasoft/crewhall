import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
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
import { organizations } from './org';
import { id, ltree, textC, textTr, timestamps, tz } from './types';

export const spaceKind = pgEnum('space_kind', ['personal', 'shared']);
export const spaceRole = pgEnum('space_role', ['owner', 'admin', 'editor', 'viewer']);
export const spaceColor = pgEnum('space_color', ['s1', 's2', 's3', 's4', 's5', 's6']);
export const nodeType = pgEnum('node_type', ['folder', 'file', 'page', 'board', 'drawing']);

export type SpaceRoleValue = (typeof spaceRole.enumValues)[number];

export interface SpaceSettingsData {
  /** Editors may create public links (design doc 17 §5). */
  editorsCanShareLinks?: boolean;
}

export const spaces = pgTable(
  'spaces',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    kind: spaceKind('kind').notNull(),
    ownerUserId: uuid('owner_user_id').references(() => users.id, { onDelete: 'set null' }),
    name: textTr('name').notNull(),
    slug: text('slug').notNull(),
    color: spaceColor('color').notNull(),
    icon: text('icon'),
    /** New members join default spaces automatically (setup wizard 1.12). */
    isDefault: boolean('is_default').notNull().default(false),
    settings: jsonb('settings').$type<SpaceSettingsData>().notNull().default({}),
    usedBytes: bigint('used_bytes', { mode: 'number' }).notNull().default(0),
    quotaBytes: bigint('quota_bytes', { mode: 'number' }),
    archivedAt: tz('archived_at'),
    /** Design 3.2: short text under the name. */
    description: text('description'),
    /** invite_only, or listed for everyone in the org to join. */
    visibility: text('visibility', { enum: ['invite_only', 'org'] })
      .notNull()
      .default('invite_only'),
    /** Deleted by the owner; removed for good 30 days later unless restored. */
    deletedAt: tz('deleted_at'),
    deletedBy: uuid('deleted_by').references(() => users.id, { onDelete: 'set null' }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('spaces_org_slug_uq').on(t.orgId, t.slug),
    uniqueIndex('spaces_personal_owner_uq')
      .on(t.orgId, t.ownerUserId)
      .where(sql`${t.kind} = 'personal'`),
  ],
);

export const spaceMembers = pgTable(
  'space_members',
  {
    spaceId: uuid('space_id')
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    role: spaceRole('role').notNull(),
    addedBy: uuid('added_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  (t) => [
    primaryKey({ columns: [t.spaceId, t.userId] }),
    index('space_members_user_idx').on(t.userId),
  ],
);

/**
 * The single node tree (design doc 17 §4). Phase 0 ships the table only;
 * Drive (phase 1) adds the services on top.
 */
export const nodes = pgTable(
  'nodes',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    spaceId: uuid('space_id')
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    parentId: uuid('parent_id').references((): AnyPgColumn => nodes.id, { onDelete: 'cascade' }),
    type: nodeType('type').notNull(),
    name: textTr('name').notNull(),
    /** Fractional index key; compared in byte order. */
    position: textC('position').notNull(),
    path: ltree('path').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull().default(0),
    mime: text('mime'),
    /** node_versions row with the file's current content (files only; loose to avoid an FK cycle). */
    currentVersionId: uuid('current_version_id'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    deletedAt: tz('deleted_at'),
    deletedBy: uuid('deleted_by').references(() => users.id, { onDelete: 'set null' }),
    /**
     * A folder the app keeps for itself (page images, card and table attachments...): it is
     * found by this role, not by name, and Drive lists, searches and child counts leave it out.
     */
    systemRole: text('system_role'),
    ...timestamps(),
  },
  (t) => [
    index('nodes_path_gist').using('gist', t.path),
    index('nodes_space_parent_pos_idx').on(t.spaceId, t.parentId, t.position),
    // One live name per folder (design 3.14); trashed nodes do not block the name, nor do the
    // app's own folders, which nobody sees.
    uniqueIndex('nodes_live_name_uq')
      .on(
        t.spaceId,
        sql`coalesce(${t.parentId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
        t.name,
      )
      .where(sql`${t.deletedAt} is null and ${t.systemRole} is null`),
    // One live system folder per role and place.
    uniqueIndex('nodes_system_role_uq')
      .on(
        t.spaceId,
        sql`coalesce(${t.parentId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
        t.systemRole,
      )
      .where(sql`${t.deletedAt} is null and ${t.systemRole} is not null`),
    // Name search: pg_trgm GIN (doc 17 §4).
    index('nodes_name_trgm_idx').using('gin', sql`${t.name} gin_trgm_ops`),
    index('nodes_deleted_idx').on(t.spaceId, t.deletedAt),
  ],
);

/** ltree label for a node: its uuid without dashes. */
export const nodeLabel = (nodeId: string) => nodeId.replaceAll('-', '');
