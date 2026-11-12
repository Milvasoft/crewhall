import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './auth';
import { organizations } from './org';
import { nodes, spaces } from './space';
import { id, textC, timestamps, tz } from './types';

export const blobStatus = pgEnum('blob_status', ['pending', 'ready', 'quarantined']);
export const derivativeKind = pgEnum('derivative_kind', [
  'thumb_256',
  'thumb_1024',
  'pdf_p1',
  'poster',
]);
export const versionSource = pgEnum('version_source', ['web', 'mobile', 'mcp', 'api']);
export const uploadStatus = pgEnum('upload_status', [
  'uploading',
  'completed',
  'aborted',
  'expired',
]);
export const shareKind = pgEnum('share_kind', ['user', 'link']);
export const shareRole = pgEnum('share_role', ['viewer', 'editor']);

/**
 * Every byte goes through blobs (doc 17 §4, §8). sha256 is computed by the worker after
 * upload; (org_id, sha256) is unique among unencrypted ready blobs, which is the dedup.
 */
export const blobs = pgTable(
  'blobs',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    sha256: text('sha256'),
    size: bigint('size', { mode: 'number' }).notNull(),
    mime: text('mime'),
    storageKey: text('storage_key').notNull().unique(),
    encrypted: boolean('encrypted').notNull().default(false),
    status: blobStatus('status').notNull().default('pending'),
    /** Versions and attachments pointing here; 0 = the purge job may delete the object. */
    refCount: integer('ref_count').notNull().default(0),
    /** Preview generation result for the derivatives below. */
    previewStatus: text('preview_status', { enum: ['none', 'pending', 'ready', 'failed'] })
      .notNull()
      .default('none'),
    /** Set when ref_count dropped to 0; the object is deleted a day later (design 03). */
    orphanedAt: tz('orphaned_at'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('blobs_org_sha256_uq')
      .on(t.orgId, t.sha256)
      .where(sql`${t.encrypted} = false and ${t.status} = 'ready' and ${t.sha256} is not null`),
    index('blobs_orphaned_idx').on(t.orphanedAt),
  ],
);

export const blobDerivatives = pgTable(
  'blob_derivatives',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    blobId: uuid('blob_id')
      .notNull()
      .references(() => blobs.id, { onDelete: 'cascade' }),
    kind: derivativeKind('kind').notNull(),
    storageKey: text('storage_key').notNull(),
    mime: text('mime').notNull(),
    width: integer('width'),
    height: integer('height'),
    size: bigint('size', { mode: 'number' }).notNull().default(0),
    ...timestamps(),
  },
  (t) => [unique('blob_derivatives_blob_kind_uq').on(t.blobId, t.kind)],
);

/** Every upload of a file is a version (design 3.8); restore copies an old one on top. */
export const nodeVersions = pgTable(
  'node_versions',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    nodeId: uuid('node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    blobId: uuid('blob_id').references(() => blobs.id, { onDelete: 'restrict' }),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull().default(0),
    mime: text('mime'),
    label: text('label'),
    source: versionSource('source').notNull().default('web'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  (t) => [unique('node_versions_node_version_uq').on(t.nodeId, t.version)],
);

/** Resumable multipart uploads (doc 17 §8): the bytes go straight to S3. */
export const uploads = pgTable(
  'uploads',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    spaceId: uuid('space_id')
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    parentId: uuid('parent_id').references(() => nodes.id, { onDelete: 'set null' }),
    /** Target file for a new version; set on completion for new files. */
    nodeId: uuid('node_id').references(() => nodes.id, { onDelete: 'set null' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    mime: text('mime'),
    onConflict: text('on_conflict', { enum: ['ask', 'version', 'rename', 'replace'] }).notNull(),
    /** New version only if the file is still at this version (optimistic save). */
    baseVersion: integer('base_version'),
    source: versionSource('source').notNull().default('web'),
    storageKey: text('storage_key').notNull(),
    s3UploadId: text('s3_upload_id').notNull(),
    partSize: integer('part_size').notNull(),
    partCount: integer('part_count').notNull(),
    status: uploadStatus('status').notNull().default('uploading'),
    expiresAt: tz('expires_at').notNull(),
    completedAt: tz('completed_at'),
    ...timestamps(),
  },
  (t) => [
    index('uploads_status_expires_idx').on(t.status, t.expiresAt),
    index('uploads_space_idx').on(t.spaceId),
  ],
);

/**
 * Node shares (doc 17 §4): a person or a public link. They reach descendants through
 * the ltree path. Link tokens are stored as sha256 only.
 */
export const shares = pgTable(
  'shares',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    nodeId: uuid('node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    kind: shareKind('kind').notNull(),
    granteeUserId: uuid('grantee_user_id').references(() => users.id, { onDelete: 'cascade' }),
    role: shareRole('role').notNull(),
    tokenHash: text('token_hash').unique(),
    /**
     * The link token encrypted with a key derived from AUTH_SECRET (H16), so the address can be
     * shown again. Null for links made before it: they work, their address can't be shown.
     */
    tokenEnc: text('token_enc'),
    passwordHash: text('password_hash'),
    expiresAt: tz('expires_at'),
    allowDownload: boolean('allow_download').notNull().default(true),
    openCount: integer('open_count').notNull().default(0),
    firstOpenedAt: tz('first_opened_at'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  (t) => [
    index('shares_node_idx').on(t.nodeId),
    index('shares_grantee_idx').on(t.granteeUserId),
    uniqueIndex('shares_node_user_uq')
      .on(t.nodeId, t.granteeUserId)
      .where(sql`${t.kind} = 'user'`),
  ],
);

/** Wrong passwords on a public link, per link and IP (19.2: 5 tries, 15 min). */
export const shareAttempts = pgTable(
  'share_attempts',
  {
    shareId: uuid('share_id')
      .notNull()
      .references(() => shares.id, { onDelete: 'cascade' }),
    ip: text('ip').notNull(),
    failedCount: integer('failed_count').notNull().default(0),
    lockedUntil: tz('locked_until'),
    ...timestamps(),
  },
  (t) => [primaryKey({ columns: [t.shareId, t.ip] })],
);

/** Per-person node state: favorites and "recently opened" (doc 17 §4). */
export const nodeUserState = pgTable(
  'node_user_state',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    nodeId: uuid('node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    favorite: boolean('favorite').notNull().default(false),
    /** Fractional key for the favorites strip order. */
    favoritePosition: textC('favorite_position'),
    lastOpenedAt: tz('last_opened_at'),
    /** Pages: tell this person when the page changes. */
    following: boolean('following').notNull().default(false),
    /** With `following`: changes to the page's sub-pages (all depths) are told as well. */
    followDescendants: boolean('follow_descendants').notNull().default(false),
    /** The last such notice, so that an afternoon of edits is not one notice per save. */
    followNotifiedAt: tz('follow_notified_at'),
    ...timestamps(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.nodeId] }),
    index('node_user_state_recent_idx').on(t.userId, t.lastOpenedAt),
    index('node_user_state_following_idx')
      .on(t.nodeId)
      .where(sql`${t.following}`),
  ],
);
