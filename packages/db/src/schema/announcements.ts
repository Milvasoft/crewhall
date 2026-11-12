import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { conversations } from './chat';
import { users } from './auth';
import { organizations } from './org';
import { id, timestamps, tz } from './types';

/**
 * Internal announcements and news feed (roadmap 19). Inward-facing: every active member of
 * the org (guests excluded) is the audience; the portal stays the outward-facing site.
 */
export const announcements = pgTable(
  'announcements',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    /** Plain text with line breaks and links (chat-like rendering, no HTML). */
    body: text('body').notNull(),
    /** Important ones stay on top of the feed and on the home card. */
    pinnedAt: tz('pinned_at'),
    /** Readers are asked to confirm "Okudum"; the author sees who has not. */
    requiresAck: boolean('requires_ack').notNull().default(false),
    publishedAt: tz('published_at').notNull().defaultNow(),
    editedAt: tz('edited_at'),
    ...timestamps(),
  },
  (t) => [
    index('announcements_org_idx').on(t.orgId, t.publishedAt),
    index('announcements_pinned_idx')
      .on(t.orgId, t.pinnedAt)
      .where(sql`${t.pinnedAt} is not null`),
  ],
);

/** One row per person who opened it; `acked_at` once they confirmed "Okudum". */
export const announcementReads = pgTable(
  'announcement_reads',
  {
    announcementId: uuid('announcement_id')
      .notNull()
      .references(() => announcements.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    readAt: tz('read_at').notNull().defaultNow(),
    ackedAt: tz('acked_at'),
  },
  (t) => [
    primaryKey({ columns: [t.announcementId, t.userId] }),
    index('announcement_reads_user_idx').on(t.userId, t.orgId),
  ],
);

/**
 * Kudos badges (thank-you wall): six ready ones per org (`key` set, name from i18n until the
 * org renames it) plus the org's own. Archived ones stay on old cards but cannot be given.
 */
export const kudosBadges = pgTable(
  'kudos_badges',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** One of DEFAULT_KUDOS_BADGES for the ready ones; null for the org's own. */
    key: text('key'),
    emoji: text('emoji').notNull(),
    /** Null on a ready badge = its translated default name. */
    name: text('name'),
    position: integer('position').notNull().default(0),
    archivedAt: tz('archived_at'),
    ...timestamps(),
  },
  (t) => [
    index('kudos_badges_org_idx').on(t.orgId, t.position),
    uniqueIndex('kudos_badges_org_key_uq')
      .on(t.orgId, t.key)
      .where(sql`${t.key} is not null`),
  ],
);

/** A thank-you card: one person to another, with a badge and an optional message. */
export const kudos = pgTable(
  'kudos',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    fromUserId: uuid('from_user_id').references(() => users.id, { onDelete: 'set null' }),
    toUserId: uuid('to_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    badgeId: uuid('badge_id').references(() => kudosBadges.id, { onDelete: 'set null' }),
    message: text('message'),
    ...timestamps(),
  },
  (t) => [
    index('kudos_org_idx').on(t.orgId, t.createdAt),
    index('kudos_to_idx').on(t.orgId, t.toUserId, t.createdAt),
  ],
);

/** Per org: where and what the daily celebration post announces (off until a channel is set). */
export const celebrationSettings = pgTable('celebration_settings', {
  orgId: uuid('org_id')
    .primaryKey()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  channelId: uuid('channel_id').references(() => conversations.id, { onDelete: 'set null' }),
  birthdays: boolean('birthdays').notNull().default(true),
  anniversaries: boolean('anniversaries').notNull().default(true),
  /** Each new kudos card is also posted to the channel. */
  kudos: boolean('kudos').notNull().default(false),
  /** The org's day: when "today" starts and the morning post goes out. */
  timeZone: text('time_zone').notNull().default('Europe/Istanbul'),
  ...timestamps(),
});

/** One row per celebration posted, so the hourly job never posts the same one twice. */
export const celebrationPosts = pgTable(
  'celebration_posts',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['birthday', 'anniversary'] }).notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The org-local day it was for ('YYYY-MM-DD'). */
    day: text('day').notNull(),
    postedAt: tz('posted_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('celebration_posts_uq').on(t.orgId, t.kind, t.userId, t.day)],
);
