import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { organizations } from './org';
import { citext, id, textTr, timestamps, tz } from './types';

/**
 * better-auth tables. JS property names are better-auth field names
 * (the drizzle adapter maps by them); SQL names follow our snake_case convention.
 * People belong to the system, not to an org, so these tables have no org_id.
 */
export const users = pgTable('users', {
  id: id(),
  email: citext('email').notNull().unique(),
  name: textTr('name').notNull(),
  emailVerified: boolean('email_verified').notNull().default(false),
  /** Served avatar URL; image_blob_id takes over once the blob layer lands (phase 1). */
  image: text('image'),
  imageBlobId: uuid('image_blob_id'),
  locale: text('locale', { enum: ['tr', 'en'] })
    .notNull()
    .default('tr'),
  twoFactorEnabled: boolean('two_factor_enabled').notNull().default(false),
  lastSeenAt: tz('last_seen_at'),
  ...timestamps(),
});

export const sessions = pgTable(
  'sessions',
  {
    id: id(),
    token: text('token').notNull().unique(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: tz('expires_at').notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    activeOrganizationId: uuid('active_org_id').references((): AnyPgColumn => organizations.id, {
      onDelete: 'set null',
    }),
    ...timestamps(),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

export const accounts = pgTable(
  'accounts',
  {
    id: id(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: tz('access_token_expires_at'),
    refreshTokenExpiresAt: tz('refresh_token_expires_at'),
    scope: text('scope'),
    /** Password hash for the credential provider. */
    password: text('password'),
    ...timestamps(),
  },
  (t) => [
    index('accounts_user_idx').on(t.userId),
    uniqueIndex('accounts_provider_account_uq').on(t.providerId, t.accountId),
  ],
);

export const verifications = pgTable(
  'verifications',
  {
    id: id(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: tz('expires_at').notNull(),
    ...timestamps(),
  },
  (t) => [index('verifications_identifier_idx').on(t.identifier)],
);

/** TOTP secret and backup codes, both encrypted with the app secret by better-auth. */
export const twoFactors = pgTable('two_factors', {
  id: id(),
  userId: uuid('user_id')
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: 'cascade' }),
  secret: text('secret').notNull(),
  backupCodes: text('backup_codes').notNull(),
  verified: boolean('verified').notNull().default(true),
  failedVerificationCount: integer('failed_verification_count').notNull().default(0),
  lockedUntil: tz('locked_until'),
  ...timestamps(),
});

export const passkeys = pgTable(
  'passkeys',
  {
    id: id(),
    name: text('name'),
    publicKey: text('public_key').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    credentialID: text('credential_id').notNull().unique(),
    counter: integer('counter').notNull(),
    deviceType: text('device_type').notNull(),
    backedUp: boolean('backed_up').notNull(),
    transports: text('transports'),
    aaguid: text('aaguid'),
    ...timestamps(),
  },
  (t) => [index('passkeys_user_idx').on(t.userId)],
);
