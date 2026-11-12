import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgTable,
  smallint,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './auth';
import { id, tz } from './types';

/**
 * Nightly backup from Yönetim › Yedekler (roadmap 3). These rows belong to the install, not
 * to an org: a backup covers the whole database and bucket (kararlar.md, 2026-10-22). The
 * snapshots themselves live in the backups volume (apps/backend/src/ops); this keeps the
 * schedule and the history of runs.
 */

/** Single row (id = 1); a missing row means the defaults (off, 03:00, 7 kept). */
export const backupSettings = pgTable(
  'backup_settings',
  {
    id: smallint('id').primaryKey().default(1),
    enabled: boolean('enabled').notNull().default(false),
    /** Local time "HH:MM" in `timezone`. */
    time: text('time').notNull().default('03:00'),
    /** IANA zone, e.g. Europe/Istanbul. */
    timezone: text('timezone').notNull().default('UTC'),
    /** Nightly snapshots kept; older ones and files only they used are deleted. */
    keep: integer('keep').notNull().default(7),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    updatedAt: tz('updated_at').notNull().defaultNow(),
  },
  (t) => [check('backup_settings_single_row', sql`${t.id} = 1`)],
);

export const backupRuns = pgTable(
  'backup_runs',
  {
    id: id(),
    /** nightly | manual ("Şimdi yedek al"). */
    trigger: text('trigger').notNull(),
    /** queued | running | succeeded | failed */
    status: text('status').notNull().default('queued'),
    /** Nightly runs: the local date they belong to; one run per date. */
    scheduledFor: text('scheduled_for'),
    snapshotId: text('snapshot_id'),
    dbBytes: bigint('db_bytes', { mode: 'number' }),
    objectCount: integer('object_count'),
    objectBytes: bigint('object_bytes', { mode: 'number' }),
    error: text('error'),
    requestedBy: uuid('requested_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: tz('created_at').notNull().defaultNow(),
    startedAt: tz('started_at'),
    finishedAt: tz('finished_at'),
  },
  (t) => [
    index('backup_runs_created_idx').on(t.createdAt),
    uniqueIndex('backup_runs_nightly_uq')
      .on(t.scheduledFor)
      .where(sql`${t.trigger} = 'nightly'`),
  ],
);
