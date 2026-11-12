import { bigint, date, index, integer, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth';
import { organizations } from './org';
import { tz } from './types';

/**
 * Admin statistics (roadmap 21). The api counts requests in memory and adds them here in
 * batches: one row per person, UTC day and area (module). The hourly stats.rollup job turns
 * these into org_stats_daily and drops activity older than ACTIVITY_KEEP_DAYS; the dashboard
 * reads only the rollup.
 */
export const activityDaily = pgTable(
  'activity_daily',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    day: date('day', { mode: 'string' }).notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** STATS_AREAS: a module key, 'drive', 'quick' or 'core'. */
    area: text('area').notNull(),
    requests: integer('requests').notNull().default(0),
    /** POST / PUT / PATCH / DELETE requests: changes made. */
    writes: integer('writes').notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.day, t.userId, t.area] }),
    index('activity_daily_day_idx').on(t.day),
  ],
);

/**
 * Daily rollup, one value per (org, day, metric, dimension). Metrics: dau / wau / mau,
 * members, storage_bytes (dimension ''), module_users / module_actions (dimension = area),
 * space_bytes / space_items (dimension = space id), user_bytes (dimension = user id).
 * Re-running a day overwrites it, so the job is idempotent.
 */
export const orgStatsDaily = pgTable(
  'org_stats_daily',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    day: date('day', { mode: 'string' }).notNull(),
    metric: text('metric').notNull(),
    dim: text('dim').notNull().default(''),
    value: bigint('value', { mode: 'number' }).notNull(),
    computedAt: tz('computed_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.day, t.metric, t.dim] }),
    index('org_stats_daily_metric_idx').on(t.orgId, t.metric, t.day),
  ],
);
