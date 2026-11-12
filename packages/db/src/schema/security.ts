import { index, integer, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth';
import { organizations } from './org';
import { citext, id, timestamps, tz } from './types';

/**
 * Sign-in failure counter (design 01 · 1.2, 1.16). Keyed by e-mail, not user, so an
 * unknown address is counted and answered exactly like a real one. Like `users`, it has
 * no org_id: people and their credentials belong to the system, not to one org.
 */
export const authLockouts = pgTable('auth_lockouts', {
  email: citext('email').primaryKey(),
  /** Failures since the last success or lock; resets to 0 when a lock starts. */
  failedCount: integer('failed_count').notNull().default(0),
  lastFailedAt: tz('last_failed_at'),
  lastFailedIp: text('last_failed_ip'),
  /** End of the current or most recent lock (kept after it passes, to double the next one). */
  lockedUntil: tz('locked_until'),
  /** 0, 1, 2 → 15, 30, 60 minutes. */
  lockLevel: integer('lock_level').notNull().default(0),
  ...timestamps(),
});

/** Mobile connect QR tokens (design 12.3): 5 minutes, single use, stored as sha256. */
export const mobileConnectTokens = pgTable(
  'mobile_connect_tokens',
  {
    id: id(),
    orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: tz('expires_at').notNull(),
    consumedAt: tz('consumed_at'),
    ...timestamps(),
  },
  (t) => [index('mobile_connect_tokens_user_idx').on(t.userId)],
);

/**
 * One-time codes handing a browser session over to the mobile app (PKCE S256, 60 s).
 * Only the code's sha256 is stored.
 */
export const mobileHandoffs = pgTable(
  'mobile_handoffs',
  {
    id: id(),
    orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull().unique(),
    codeChallenge: text('code_challenge').notNull(),
    redirectUri: text('redirect_uri').notNull(),
    expiresAt: tz('expires_at').notNull(),
    consumedAt: tz('consumed_at'),
    ...timestamps(),
  },
  (t) => [index('mobile_handoffs_user_idx').on(t.userId)],
);
