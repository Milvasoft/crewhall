import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { users } from './auth';
import { organizations } from './org';
import { id, timestamps, tz } from './types';

export const surfaceOwnerType = pgEnum('surface_owner_type', ['user', 'space']);
export const linkStatus = pgEnum('link_status', ['up', 'warn', 'down', 'unknown']);

/** Quick access surfaces (design 02): the person's "Benim" and one per shared space. */
export const surfaces = pgTable(
  'surfaces',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    ownerType: surfaceOwnerType('owner_type').notNull(),
    /** users.id or spaces.id. */
    ownerId: uuid('owner_id').notNull(),
    layoutRev: integer('layout_rev').notNull().default(0),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  (t) => [uniqueIndex('surfaces_owner_uq').on(t.orgId, t.ownerType, t.ownerId)],
);

export const surfaceCards = pgTable(
  'surface_cards',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    surfaceId: uuid('surface_id')
      .notNull()
      .references(() => surfaces.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    x: integer('x').notNull(),
    y: integer('y').notNull(),
    w: integer('w').notNull(),
    h: integer('h').notNull(),
    mobileOrder: integer('mobile_order'),
    /** Per-type config, validated by @crewhall/shared (doc 17 §4 cards.config). */
    config: jsonb('config').$type<Record<string, unknown>>().notNull(),
    /** Node for node cards (cards.target_id). */
    targetId: uuid('target_id'),
    /** Pinned cards show this source card's content (design 2.8). */
    pinnedFromCardId: uuid('pinned_from_card_id').references((): AnyPgColumn => surfaceCards.id, {
      onDelete: 'set null',
    }),
    /** Pinned card whose source was removed ("Kaynak kaldırıldı"). */
    sourceRemovedAt: tz('source_removed_at'),
    deletedAt: tz('deleted_at'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  (t) => [
    index('surface_cards_surface_idx').on(t.surfaceId),
    index('surface_cards_pinned_idx').on(t.pinnedFromCardId),
  ],
);

/** A URL known to the org; (org_id, url_hash) unique so it is checked once (doc 17 §4, §10). */
export const links = pgTable(
  'links',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    urlHash: text('url_hash').notNull(),
    host: text('host').notNull(),
    siteTitle: text('site_title'),
    faviconUrl: text('favicon_url'),
    checkEnabled: boolean('check_enabled').notNull().default(true),
    intervalSeconds: integer('interval_seconds').notNull().default(60),
    status: linkStatus('status').notNull().default('unknown'),
    statusSince: tz('status_since'),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    lastCheckedAt: tz('last_checked_at'),
    nextCheckAt: tz('next_check_at'),
    lastHttpStatus: integer('last_http_status'),
    lastLatencyMs: integer('last_latency_ms'),
    tlsExpiresAt: tz('tls_expires_at'),
    lastReason: text('last_reason'),
    lastUpAt: tz('last_up_at'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('links_org_url_hash_uq').on(t.orgId, t.urlHash),
    index('links_next_check_idx').on(t.nextCheckAt),
  ],
);

/** Check history, kept 30 days (doc 17 §4). */
export const linkChecks = pgTable(
  'link_checks',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    linkId: uuid('link_id')
      .notNull()
      .references(() => links.id, { onDelete: 'cascade' }),
    at: tz('at').notNull().defaultNow(),
    status: linkStatus('status').notNull(),
    httpStatus: integer('http_status'),
    latencyMs: integer('latency_ms'),
    tlsExpiresAt: tz('tls_expires_at'),
    error: text('error'),
  },
  (t) => [index('link_checks_link_at_idx').on(t.linkId, t.at.desc())],
);

/** Link opens for the "most opened, last 30 days" sort (design 2.5). */
export const linkOpens = pgTable(
  'link_opens',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    linkId: uuid('link_id')
      .notNull()
      .references(() => links.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    at: tz('at').notNull().defaultNow(),
  },
  (t) => [index('link_opens_link_at_idx').on(t.linkId, t.at)],
);
