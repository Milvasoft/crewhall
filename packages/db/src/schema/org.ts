import { sql } from 'drizzle-orm';
import {
  bigint,
  index,
  inet,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './auth';
import { citext, id, textTr, timestamps, tz } from './types';

export const orgRole = pgEnum('org_role', ['owner', 'admin', 'member', 'guest']);
export const memberStatus = pgEnum('member_status', ['active', 'invited', 'suspended']);

export type OrgRoleValue = (typeof orgRole.enumValues)[number];

/** Same shape as Branding in @crewhall/shared; db stays independent of the contract package. */
export interface BrandingData {
  orgName: string;
  appName: string;
  logoLightUrl: string | null;
  logoDarkUrl: string | null;
  markUrl: string | null;
  faviconUrl: string | null;
  showPoweredBy: boolean;
  defaultLocale: 'tr' | 'en';
}

export interface OrgSettingsData {
  requireTwoFactor: boolean;
  defaultLocale: 'tr' | 'en';
  membersCanCreateSpaces: boolean;
  publicLinksEnabled: boolean;
  maxFileBytes?: number;
  storageQuotaBytes?: number | null;
  /** Module switches (OrgSettings.modules); a missing key means on. */
  modules?: Partial<Record<string, boolean>>;
  /** OrgSettings.chatDeleteForEveryone; missing = allowed. */
  chatDeleteForEveryone?: boolean;
  /** OrgSettings.chatLinkPreviews (link preview cards in chat); missing = on. */
  chatLinkPreviews?: boolean;
  /** OrgSettings.meetRemoteControl (remote control of shared screens); missing = allowed. */
  meetRemoteControl?: boolean;
  /** OrgSettings.federationEnabled; missing = off (roadmap 26). */
  federationEnabled?: boolean;
  federationAllowedDomains?: string[];
  /** OrgSettings.federationSharedChannels; missing = off (kararlar.md 2026-10-29). */
  federationSharedChannels?: {
    enabled?: boolean;
    whoCanInvite?: 'admins' | 'managers';
    maxFileMb?: number;
  };
  /** OrgSettings.trashRetentionDays; missing = 30. */
  trashRetentionDays?: number;
  /** OrgSettings.integrations (Microsoft); missing key = off. */
  integrations?: Partial<Record<'entra' | 'outlook' | 'teams' | 'externalStorage', boolean>>;
}

export interface ThemeData {
  light: { bg: string; surface: string; accent: string };
  dark: { bg: string; surface: string; accent: string };
  radius: 'sm' | 'md' | 'lg';
  density: 'compact' | 'comfortable';
  login: {
    source: 'scene' | 'image' | 'color';
    imageUrl: string | null;
    darkImageUrl: string | null;
    texts: { tr?: string; en?: string };
  };
}

/** better-auth "organization" model plus Crewhall fields. */
export const organizations = pgTable('organizations', {
  id: id(),
  slug: text('slug').notNull().unique(),
  name: textTr('name').notNull(),
  logo: text('logo'),
  metadata: text('metadata'),
  branding: jsonb('branding').$type<BrandingData>().notNull(),
  plan: text('plan').notNull().default('self_hosted'),
  settings: jsonb('settings').$type<OrgSettingsData>().notNull(),
  licenseKey: text('license_key'),
  ...timestamps(),
});

/** Published themes, one row per version; the highest version is live. */
export const orgThemes = pgTable(
  'org_themes',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    data: jsonb('data').$type<ThemeData>().notNull(),
    publishedBy: uuid('published_by').references(() => users.id, { onDelete: 'set null' }),
    publishedAt: tz('published_at').notNull().defaultNow(),
    ...timestamps(),
  },
  (t) => [unique('org_themes_org_version_uq').on(t.orgId, t.version)],
);

/** better-auth "member" model; organizationId is the org_id column. */
export const orgMembers = pgTable(
  'org_members',
  {
    id: id(),
    organizationId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: orgRole('role').notNull(),
    permissions: text('permissions')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    status: memberStatus('status').notNull().default('active'),
    joinedAt: tz('joined_at'),
    /** Guests: access ends at this time (roadmap 13); the hourly job then suspends them. */
    expiresAt: tz('expires_at'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('org_members_org_user_uq').on(t.organizationId, t.userId),
    index('org_members_user_idx').on(t.userId),
  ],
);

/**
 * better-auth "invitation" model plus Crewhall fields. The accept link carries a
 * random token; only its sha256 (token_hash) is stored.
 */
export const invitations = pgTable(
  'invitations',
  {
    id: id(),
    organizationId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    email: citext('email').notNull(),
    role: orgRole('role').notNull(),
    status: text('status', { enum: ['pending', 'accepted', 'canceled', 'rejected'] })
      .notNull()
      .default('pending'),
    expiresAt: tz('expires_at').notNull(),
    inviterId: uuid('inviter_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    spaceIds: uuid('space_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    /** Guest invitations: access end for the membership created on accept. */
    memberExpiresAt: tz('member_expires_at'),
    /** Guest invitations: role in the listed spaces (viewer or editor; default viewer). */
    spaceRole: text('space_role', { enum: ['viewer', 'editor'] }),
    acceptedAt: tz('accepted_at'),
    acceptedBy: uuid('accepted_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  (t) => [index('invitations_org_email_idx').on(t.organizationId, t.email)],
);

/**
 * Append-only audit trail (design doc 17 §4). Monthly partitioning comes later;
 * rows are written only through the audit service and never updated.
 */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    ip: inet('ip'),
    userAgent: text('user_agent'),
    meta: jsonb('meta').$type<Record<string, unknown>>().notNull().default({}),
    via: jsonb('via').$type<Record<string, unknown>>(),
    at: tz('at').notNull().defaultNow(),
  },
  (t) => [
    index('audit_logs_org_at_idx').on(t.orgId, t.at.desc()),
    index('audit_logs_target_idx').on(t.targetType, t.targetId),
  ],
);

/** Stored responses for Idempotency-Key replays (kept 24 h). */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    userId: uuid('user_id').notNull(),
    key: text('key').notNull(),
    method: text('method').notNull(),
    path: text('path').notNull(),
    requestHash: text('request_hash').notNull(),
    /** Null while the first request is still running. */
    status: integer('status'),
    response: jsonb('response'),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('idempotency_keys_user_key_uq').on(t.userId, t.key),
    index('idempotency_keys_created_idx').on(t.createdAt),
  ],
);
