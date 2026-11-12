import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  customType,
  index,
  inet,
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
import { blobs } from './drive';
import { organizations } from './org';
import { spaces } from './space';
import { id, timestamps, tz } from './types';

/**
 * Zero-knowledge vault (doc 17 §4 "Toplantı ve kasa", §7). No column holds a secret in clear:
 * item content, names, URLs and attachment names live inside ciphertext; keys are stored
 * wrapped; verifiers only as SHA-256. The server cannot decrypt any of it.
 */

/** Raw bytes (ciphertext, wrapped keys, public keys). */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

export const vaultKind = pgEnum('vault_kind', ['personal', 'space']);
export const vaultRole = pgEnum('vault_role', ['read', 'edit', 'manage']);
export const vaultItemType = pgEnum('vault_item_type', [
  'login',
  'note',
  'card',
  'api_key',
  'ssh_key',
  'identity',
]);
export const vaultUnlockKind = pgEnum('vault_unlock_kind', ['passkey_prf', 'device']);

export interface VaultKdfData {
  alg: 'argon2id';
  m: number;
  t: number;
  p: number;
  salt: string;
}

/**
 * A person's X25519 key pair (doc 17 §4 user_keys). Keys belong to the person, not to an
 * org (like `users`); vault rows below carry org_id.
 */
export const userKeys = pgTable('user_keys', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  publicKey: bytea('public_key').notNull(),
  fingerprint: text('fingerprint').notNull(),
  /** Private key under the KEK derived from the vault password. */
  encryptedPrivateKey: bytea('encrypted_private_key').notNull(),
  kdf: jsonb('kdf').$type<VaultKdfData>().notNull(),
  /** SHA-256 of the password verifier; checked before releasing encryptedPrivateKey. */
  passwordVerifierHash: bytea('password_verifier_hash').notNull(),
  /** Private key under the recovery key. */
  recoveryWrappedKey: bytea('recovery_wrapped_key').notNull(),
  recoveryVerifierHash: bytea('recovery_verifier_hash').notNull(),
  keyVersion: integer('key_version').notNull().default(1),
  /** Encrypted per-account settings and TOFU pins. */
  settings: bytea('settings'),
  recoveryCreatedAt: tz('recovery_created_at').notNull().defaultNow(),
  passwordChangedAt: tz('password_changed_at').notNull().defaultNow(),
  /** Wrong verifiers in a row and the wait they cause (design 8.3: 5 tries / 30 s). */
  failedAttempts: integer('failed_attempts').notNull().default(0),
  lockedUntil: tz('locked_until'),
  ...timestamps(),
});

/** More copies of the private key: passkey PRF, a mobile device (doc 17 §4 user_key_unlocks). */
export const userKeyUnlocks = pgTable(
  'user_key_unlocks',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => userKeys.userId, { onDelete: 'cascade' }),
    method: vaultUnlockKind('method').notNull(),
    label: text('label').notNull(),
    credentialId: text('credential_id'),
    prfSalt: bytea('prf_salt'),
    wrappedPrivateKey: bytea('wrapped_private_key').notNull(),
    verifierHash: bytea('verifier_hash').notNull(),
    lastUsedAt: tz('last_used_at'),
    ...timestamps(),
  },
  (t) => [index('user_key_unlocks_user_idx').on(t.userId)],
);

export const vaultVaults = pgTable(
  'vault_vaults',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    kind: vaultKind('kind').notNull(),
    spaceId: uuid('space_id').references(() => spaces.id, { onDelete: 'cascade' }),
    ownerUserId: uuid('owner_user_id').references(() => users.id, { onDelete: 'cascade' }),
    /** Visible to the server by design (doc 17 §7); null for personal vaults. */
    name: text('name'),
    keyVersion: integer('key_version').notNull().default(1),
    /** Bumped on every change inside the vault (sync hint for clients). */
    revision: bigint('revision', { mode: 'number' }).notNull().default(1),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('vault_vaults_personal_uq')
      .on(t.orgId, t.ownerUserId)
      .where(sql`${t.kind} = 'personal'`),
    index('vault_vaults_space_idx').on(t.spaceId),
  ],
);

/** Space role decides what a person may do; their own wrapped_key decides whether they can. */
export const vaultMembers = pgTable(
  'vault_members',
  {
    vaultId: uuid('vault_id')
      .notNull()
      .references(() => vaultVaults.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    role: vaultRole('role').notNull(),
    /** Vault key sealed to the member's public key. */
    wrappedKey: bytea('wrapped_key').notNull(),
    keyVersion: integer('key_version').notNull(),
    grantedBy: uuid('granted_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  (t) => [
    primaryKey({ columns: [t.vaultId, t.userId] }),
    index('vault_members_user_idx').on(t.userId),
  ],
);

export const vaultItems = pgTable(
  'vault_items',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    vaultId: uuid('vault_id')
      .notNull()
      .references(() => vaultVaults.id, { onDelete: 'cascade' }),
    /** In clear for filtering only; the ciphertext AAD binds it. */
    type: vaultItemType('type').notNull(),
    ciphertext: bytea('ciphertext').notNull(),
    nonce: bytea('nonce').notNull(),
    itemKeyWrapped: bytea('item_key_wrapped').notNull(),
    keyVersion: integer('key_version').notNull(),
    /** Only increases; a save must send exactly current + 1. */
    revision: integer('revision').notNull().default(1),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    deletedAt: tz('deleted_at'),
    deletedBy: uuid('deleted_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  (t) => [
    index('vault_items_vault_idx').on(t.vaultId, t.id),
    index('vault_items_deleted_idx').on(t.deletedAt),
  ],
);

/** Previous revisions of an item; the newest 10 are kept. */
export const vaultItemRevisions = pgTable(
  'vault_item_revisions',
  {
    itemId: uuid('item_id')
      .notNull()
      .references(() => vaultItems.id, { onDelete: 'cascade' }),
    revision: integer('revision').notNull(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    vaultId: uuid('vault_id')
      .notNull()
      .references(() => vaultVaults.id, { onDelete: 'cascade' }),
    type: vaultItemType('type').notNull(),
    ciphertext: bytea('ciphertext').notNull(),
    nonce: bytea('nonce').notNull(),
    itemKeyWrapped: bytea('item_key_wrapped').notNull(),
    keyVersion: integer('key_version').notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    /** When this revision was written (the item's updated_at back then). */
    createdAt: tz('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.itemId, t.revision] })],
);

/**
 * Encrypted attachments: encrypted blobs (blobs.encrypted = true, never deduplicated). The
 * file name and key live inside the item ciphertext.
 */
export const vaultAttachments = pgTable(
  'vault_attachments',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    vaultId: uuid('vault_id')
      .notNull()
      .references(() => vaultVaults.id, { onDelete: 'cascade' }),
    itemId: uuid('item_id')
      .notNull()
      .references(() => vaultItems.id, { onDelete: 'cascade' }),
    blobId: uuid('blob_id')
      .notNull()
      .references(() => blobs.id, { onDelete: 'restrict' }),
    /** Space whose quota the bytes count against. */
    spaceId: uuid('space_id').references(() => spaces.id, { onDelete: 'set null' }),
    size: bigint('size', { mode: 'number' }).notNull(),
    status: text('status', { enum: ['uploading', 'ready'] })
      .notNull()
      .default('uploading'),
    s3UploadId: text('s3_upload_id'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  (t) => [index('vault_attachments_item_idx').on(t.itemId)],
);

/**
 * Vault access log (design 8.11): append-only, kept one year. Server events (unlocks, edits,
 * downloads, sharing) and client-reported "shown / copied" events with the field name only.
 */
export const vaultEvents = pgTable(
  'vault_events',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** No foreign keys: the log outlives deleted vaults and items. */
    vaultId: uuid('vault_id'),
    itemId: uuid('item_id'),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    field: text('field'),
    targetUserId: uuid('target_user_id').references(() => users.id, { onDelete: 'set null' }),
    meta: jsonb('meta').$type<Record<string, unknown>>().notNull().default({}),
    ip: inet('ip'),
    userAgent: text('user_agent'),
    at: tz('at').notNull().defaultNow(),
  },
  (t) => [
    index('vault_events_vault_at_idx').on(t.vaultId, t.at.desc()),
    index('vault_events_actor_at_idx').on(t.actorId, t.at.desc()),
    index('vault_events_org_at_idx').on(t.orgId, t.at.desc()),
  ],
);

/**
 * Org vault policy (roadmap 20). One row per org once an admin changes something; no row means
 * the defaults (leaked password check on through the public range API, share links on).
 */
export const vaultPolicies = pgTable('vault_policies', {
  orgId: uuid('org_id')
    .primaryKey()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  breachCheck: boolean('breach_check').notNull().default(true),
  /** Range API base URL (mirror or proxy); null = the public one. */
  breachRangeUrl: text('breach_range_url'),
  shareLinks: boolean('share_links').notNull().default(true),
  shareMaxHours: integer('share_max_hours').notNull().default(720),
  shareMaxViews: integer('share_max_views').notNull().default(20),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  ...timestamps(),
});

/**
 * One-time share links (roadmap 20). The ciphertext is the item encrypted again on the device
 * under a key that lives only in the URL fragment: the server cannot read it. Only the hash of
 * the link token is stored. The row goes away after the last open, on revoke, or at expiry
 * (vault.purge), ciphertext included.
 */
export const vaultShares = pgTable(
  'vault_shares',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    vaultId: uuid('vault_id')
      .notNull()
      .references(() => vaultVaults.id, { onDelete: 'cascade' }),
    itemId: uuid('item_id')
      .notNull()
      .references(() => vaultItems.id, { onDelete: 'cascade' }),
    tokenHash: bytea('token_hash').notNull(),
    ciphertext: bytea('ciphertext').notNull(),
    nonce: bytea('nonce').notNull(),
    maxViews: integer('max_views').notNull(),
    views: integer('views').notNull().default(0),
    expiresAt: tz('expires_at').notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('vault_shares_token_uq').on(t.tokenHash),
    index('vault_shares_item_idx').on(t.itemId),
    index('vault_shares_expires_idx').on(t.expiresAt),
  ],
);
