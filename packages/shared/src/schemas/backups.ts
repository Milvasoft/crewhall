import { z } from 'zod';
import { Id, Timestamp } from './common';
import { UserSummary } from './org';

/**
 * Nightly backup from Yönetim › Yedekler (roadmap 3). Settings and runs belong to the
 * install (one database, one bucket), so only the install admin sees them: an owner of the
 * org created by the setup wizard.
 */

export const BackupSettings = z.object({
  enabled: z.boolean(),
  /** Local time "HH:MM" in `timezone`. */
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  /** IANA time zone, e.g. Europe/Istanbul. */
  timezone: z.string().min(1).max(64),
  /** Nightly snapshots kept (1-365). */
  keep: z.number().int().min(1).max(365),
});
export type BackupSettings = z.infer<typeof BackupSettings>;

export const BackupRunStatus = z.enum(['queued', 'running', 'succeeded', 'failed']);
export type BackupRunStatus = z.infer<typeof BackupRunStatus>;

export const BackupRun = z.object({
  id: Id,
  trigger: z.enum(['nightly', 'manual']),
  status: BackupRunStatus,
  snapshotId: z.string().nullable(),
  dbBytes: z.number().int().nullable(),
  objectCount: z.number().int().nullable(),
  objectBytes: z.number().nullable(),
  /** Failure reason in English (server log wording). */
  error: z.string().nullable(),
  requestedBy: UserSummary.nullable(),
  createdAt: Timestamp,
  startedAt: Timestamp.nullable(),
  finishedAt: Timestamp.nullable(),
});
export type BackupRun = z.infer<typeof BackupRun>;

/** A snapshot in the backups volume (CLI, nightly or update). */
export const BackupSnapshot = z.object({
  id: z.string(),
  createdAt: Timestamp,
  trigger: z.enum(['manual', 'nightly', 'update']),
  version: z.string(),
  note: z.string().nullable(),
  dbBytes: z.number().int(),
  objectCount: z.number().int(),
  objectBytes: z.number(),
  config: z.boolean(),
});
export type BackupSnapshot = z.infer<typeof BackupSnapshot>;

export const BackupOverview = z.object({
  settings: BackupSettings,
  /** False until the schedule was saved once (settings are the defaults). */
  configured: z.boolean().optional(),
  /** False when the server has no writable backup folder (CREWHALL_BACKUP_DIR). */
  available: z.boolean(),
  /** Next nightly run while enabled. */
  nextRunAt: Timestamp.nullable(),
  /** Latest runs, newest first (at most 20). */
  runs: z.array(BackupRun),
  snapshots: z.array(BackupSnapshot),
  /** Space the backups folder uses on disk (snapshots share unchanged files). */
  diskBytes: z.number().nullable(),
  /**
   * pg_dump's major version against the database server's. Not compatible (pg_dump older, or
   * missing): every backup fails until the server's tools are updated; the page warns.
   */
  pgTools: z
    .object({
      client: z.number().int().nullable(),
      server: z.number().int().nullable(),
      compatible: z.boolean(),
    })
    .optional(),
});
export type BackupOverview = z.infer<typeof BackupOverview>;
