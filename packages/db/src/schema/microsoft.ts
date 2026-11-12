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
import { identityProviders } from './identity';
import { organizations } from './org';
import { nodes, spaces } from './space';
import { id, timestamps, tz } from './types';

/**
 * Microsoft integrations (sonraki-isler.md "Microsoft entegrasyonları"): the org's Entra app
 * registration, SCIM provisioning state, Outlook upload requests, Teams links and drafts,
 * external storage mounts and their copy jobs. Secrets are AES-256-GCM with a key derived
 * from AUTH_SECRET; tokens and codes are stored as SHA-256 hashes.
 */

/** One row per org: the Entra app registration (Graph) and the Teams bot. */
export const microsoftApps = pgTable('microsoft_apps', {
  orgId: uuid('org_id')
    .primaryKey()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  tenantId: text('tenant_id'),
  clientId: text('client_id'),
  secretEnc: text('secret_enc'),
  secretHint: text('secret_hint'),
  /** Microsoft App ID of the org's Azure Bot (Teams message extension). */
  teamsBotAppId: text('teams_bot_app_id'),
  /** Stable id of the org's Teams app package (manifest `id`). */
  teamsAppId: uuid('teams_app_id'),
  lastTestAt: tz('last_test_at'),
  lastTestOk: boolean('last_test_ok'),
  lastError: text('last_error'),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  ...timestamps(),
});

/** Bearer tokens of the SCIM server; each belongs to the provider whose mappings apply. */
export const scimTokens = pgTable(
  'scim_tokens',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    providerId: uuid('provider_id')
      .notNull()
      .references(() => identityProviders.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    hint: text('hint').notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    lastUsedAt: tz('last_used_at'),
    revokedAt: tz('revoked_at'),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t) => [index('scim_tokens_org_idx').on(t.orgId)],
);

/**
 * People SCIM created or adopted (Users resource): the SCIM id is the Crewhall user id.
 * `active` is what the IdP last said; the org membership follows it.
 */
export const scimUsers = pgTable(
  'scim_users',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    providerId: uuid('provider_id')
      .notNull()
      .references(() => identityProviders.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    userName: text('user_name').notNull(),
    externalId: text('external_id'),
    active: boolean('active').notNull().default(true),
    /** DELETE from the IdP: the person stays suspended and the resource answers 404. */
    deletedAt: tz('deleted_at'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('scim_users_user_uq').on(t.providerId, t.userId),
    uniqueIndex('scim_users_name_uq').on(t.providerId, sql`lower(${t.userName})`),
  ],
);

/** Groups pushed by SCIM; their names (and Entra object ids) feed the role mappings. */
export const scimGroups = pgTable(
  'scim_groups',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    providerId: uuid('provider_id')
      .notNull()
      .references(() => identityProviders.id, { onDelete: 'cascade' }),
    displayName: text('display_name').notNull(),
    externalId: text('external_id'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('scim_groups_external_uq')
      .on(t.providerId, t.externalId)
      .where(sql`${t.externalId} is not null`),
    index('scim_groups_provider_idx').on(t.providerId),
  ],
);

export const scimGroupMembers = pgTable(
  'scim_group_members',
  {
    groupId: uuid('group_id')
      .notNull()
      .references(() => scimGroups.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.userId] }), index('scim_gm_user_idx').on(t.userId)],
);

/** "Bana dosya yükle" links: anyone with the link uploads into one folder until it expires. */
export const uploadRequests = pgTable(
  'upload_requests',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    spaceId: uuid('space_id')
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    folderId: uuid('folder_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    passwordHash: text('password_hash'),
    expiresAt: tz('expires_at').notNull(),
    revokedAt: tz('revoked_at'),
    uploads: integer('uploads').notNull().default(0),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t) => [index('upload_requests_creator_idx').on(t.createdBy)],
);

/** A Teams user (tenant + AAD object id) linked to a Crewhall person of the org. */
export const teamsLinks = pgTable(
  'teams_links',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    tenantId: text('tenant_id').notNull(),
    aadObjectId: text('aad_object_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('teams_links_uq').on(t.orgId, t.tenantId, t.aadObjectId)],
);

/** Single-use codes from the Teams sign-in popup (10 minutes). */
export const teamsLinkCodes = pgTable('teams_link_codes', {
  codeHash: text('code_hash').primaryKey(),
  orgId: uuid('org_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: tz('expires_at').notNull(),
});

/** Teams messages waiting in the "Crewhall'a kaydet" dialog (15 minutes). */
export const teamsDrafts = pgTable('teams_drafts', {
  id: id(),
  orgId: uuid('org_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  text: text('text').notNull(),
  from: text('from'),
  sentAt: tz('sent_at'),
  link: text('link'),
  expiresAt: tz('expires_at').notNull(),
});

export const mountKind = pgEnum('mount_kind', ['sharepoint', 'onedrive', 'smb']);

/** SharePoint / OneDrive (Graph) and SMB shares shown in a space's Drive. */
export const driveMounts = pgTable(
  'drive_mounts',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    spaceId: uuid('space_id')
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    kind: mountKind('kind').notNull(),
    /** Kind-specific settings (zod-validated); Graph mounts also keep the resolved drive id. */
    config: jsonb('config').$type<Record<string, unknown>>().notNull(),
    /** SMB password. */
    secretEnc: text('secret_enc'),
    readOnly: boolean('read_only').notNull().default(false),
    lastCheckAt: tz('last_check_at'),
    lastOk: boolean('last_ok'),
    lastError: text('last_error'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  (t) => [index('drive_mounts_space_idx').on(t.spaceId)],
);

export const importStatus = pgEnum('import_status', ['queued', 'running', 'done', 'failed']);

/** Background copies from a mount or a OneDrive into Drive. */
export const importJobs = pgTable(
  'import_jobs',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** Who started it; the copy is done with this person's rights. */
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** OneDrive moves: the person whose personal space receives the files. */
    ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'cascade' }),
    source: jsonb('source').$type<Record<string, unknown>>().notNull(),
    sourceLabel: text('source_label').notNull(),
    targetSpaceId: uuid('target_space_id')
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    targetFolderId: uuid('target_folder_id').references(() => nodes.id, { onDelete: 'set null' }),
    status: importStatus('status').notNull().default('queued'),
    files: integer('files').notNull().default(0),
    bytes: bigint('bytes', { mode: 'number' }).notNull().default(0),
    skipped: integer('skipped').notNull().default(0),
    error: text('error'),
    createdAt: tz('created_at').notNull().defaultNow(),
    finishedAt: tz('finished_at'),
  },
  (t) => [index('import_jobs_org_idx').on(t.orgId, t.createdAt)],
);
