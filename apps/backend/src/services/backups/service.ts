import { access, constants } from 'node:fs/promises';
import { and, asc, desc, eq, inArray, lt } from 'drizzle-orm';
import {
  backupRuns,
  backupSettings,
  organizations,
  users,
  type Db,
  type DbOrTx,
} from '@crewhall/db';
import type { BackupOverview, BackupRun, BackupSettings } from '@crewhall/shared';
import { AppError } from '../../http/errors';
import type { RequestInfo } from '../../http/types';
import type { Jobs } from '../../jobs/queue';
import type { Logger } from '../../logger';
import { createBackup, type OpsDeps } from '../../ops/backup';
import { checkPgTools, PgVersionMismatchError, type PgTools } from '../../ops/pg';
import type { Repo } from '../../ops/repo';
import { identityAudit } from '../identity/audit';

/**
 * Nightly backup from Yönetim › Yedekler (roadmap 3), on top of the crewhall CLI's code
 * (src/ops). The worker checks every five minutes whether tonight's run is due in the
 * configured zone; a run that could not start within six hours of its time is skipped.
 */

export const DEFAULT_BACKUP_SETTINGS: BackupSettings = {
  enabled: false,
  time: '03:00',
  timezone: 'UTC',
  keep: 7,
};
const DUE_WINDOW_MINUTES = 6 * 60;
const STALE_RUN_MS = 12 * 60 * 60 * 1000;

/** The org the setup wizard created; its owners manage the install. */
export async function installOrgId(db: DbOrTx) {
  const [org] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .orderBy(asc(organizations.createdAt), asc(organizations.id))
    .limit(1);
  return org?.id ?? null;
}

export async function isInstallAdmin(db: DbOrTx, orgId: string, role: string) {
  return role === 'owner' && (await installOrgId(db)) === orgId;
}

export async function requireInstallAdmin(db: DbOrTx, orgId: string, role: string) {
  if (!(await isInstallAdmin(db, orgId, role))) throw new AppError('forbidden');
}

export async function getBackupSettings(db: DbOrTx): Promise<BackupSettings> {
  const [row] = await db.select().from(backupSettings).where(eq(backupSettings.id, 1));
  return row
    ? { enabled: row.enabled, time: row.time, timezone: row.timezone, keep: row.keep }
    : DEFAULT_BACKUP_SETTINGS;
}

function validZone(timezone: string) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** Wall clock in `timezone`: local date (YYYY-MM-DD) and minutes since midnight. */
export function localClock(now: Date, timezone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

const minutesOf = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

/** The UTC instant of `date` + `time` in `timezone` (two passes cover DST changes). */
export function zonedInstant(date: string, time: string, timezone: string) {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const target = Date.UTC(y, m - 1, d, Math.floor(minutesOf(time) / 60), minutesOf(time) % 60);
  let guess = target;
  for (let i = 0; i < 2; i++) {
    const local = localClock(new Date(guess), timezone);
    const [ly, lm, ld] = local.date.split('-').map(Number) as [number, number, number];
    const shown = Date.UTC(ly, lm - 1, ld, Math.floor(local.minutes / 60), local.minutes % 60);
    guess += target - shown;
  }
  return new Date(guess);
}

/** Next nightly start after `now`, skipping a date that already has a run. */
export function nextRunAt(settings: BackupSettings, now: Date, doneDates: Set<string>) {
  if (!settings.enabled) return null;
  const today = localClock(now, settings.timezone);
  const at = zonedInstant(today.date, settings.time, settings.timezone);
  if (at > now && !doneDates.has(today.date)) return at;
  const tomorrow = localClock(new Date(at.getTime() + 36 * 3_600_000), settings.timezone).date;
  return zonedInstant(tomorrow, settings.time, settings.timezone);
}

async function writable(dir: string) {
  return access(dir, constants.W_OK).then(
    () => true,
    () => false,
  );
}

async function runsView(db: DbOrTx, limit = 20): Promise<BackupRun[]> {
  const rows = await db
    .select({ run: backupRuns, user: users })
    .from(backupRuns)
    .leftJoin(users, eq(users.id, backupRuns.requestedBy))
    .orderBy(desc(backupRuns.createdAt))
    .limit(limit);
  return rows.map(({ run, user }) => ({
    id: run.id,
    trigger: run.trigger as BackupRun['trigger'],
    status: run.status as BackupRun['status'],
    snapshotId: run.snapshotId,
    dbBytes: run.dbBytes,
    objectCount: run.objectCount,
    objectBytes: run.objectBytes,
    error: run.error,
    requestedBy: user
      ? { id: user.id, name: user.name, email: user.email, imageUrl: user.image }
      : null,
    createdAt: run.createdAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
  }));
}

/** pg_dump against the server, read at most every 10 minutes (Docker tools start a container). */
let toolsCache: { at: number; value: BackupOverview['pgTools'] } | null = null;

export async function pgToolsStatus(
  tools: PgTools,
  databaseUrl: string,
): Promise<NonNullable<BackupOverview['pgTools']>> {
  if (toolsCache && Date.now() - toolsCache.at < 10 * 60_000 && toolsCache.value) {
    return toolsCache.value;
  }
  const value = await checkPgTools(tools, databaseUrl).catch(() => ({
    client: null,
    server: null,
    compatible: false,
  }));
  toolsCache = { at: Date.now(), value };
  return value;
}

export function resetPgToolsCache() {
  toolsCache = null;
}

export async function backupOverview(
  db: DbOrTx,
  repo: Repo,
  now = new Date(),
  pgTools?: () => Promise<BackupOverview['pgTools']>,
): Promise<BackupOverview> {
  const settings = await getBackupSettings(db);
  const [saved] = await db
    .select({ id: backupSettings.id })
    .from(backupSettings)
    .where(eq(backupSettings.id, 1));
  const runs = await runsView(db);
  const nightly = await db
    .select({ date: backupRuns.scheduledFor })
    .from(backupRuns)
    .where(eq(backupRuns.trigger, 'nightly'))
    .orderBy(desc(backupRuns.createdAt))
    .limit(3);
  const done = new Set(nightly.map((r) => r.date).filter((d): d is string => !!d));
  const available = await writable(repo.root);
  const manifests = available ? await repo.list() : [];
  // Each pooled file once, plus every dump: what the folder holds on disk.
  const pooled = new Map<string, number>();
  for (const m of manifests) for (const o of m.objects.items) pooled.set(o.sha256, o.size);
  const diskBytes = manifests.length
    ? manifests.reduce((n, m) => n + m.database.bytes, 0) +
      [...pooled.values()].reduce((n, s) => n + s, 0)
    : null;
  return {
    settings,
    configured: Boolean(saved),
    available,
    nextRunAt: nextRunAt(settings, now, done)?.toISOString() ?? null,
    runs,
    snapshots: manifests.map((m) => ({
      id: m.id,
      createdAt: m.createdAt,
      trigger: m.trigger,
      version: m.version,
      note: m.note,
      dbBytes: m.database.bytes,
      objectCount: m.objects.count,
      objectBytes: m.objects.bytes,
      config: m.config,
    })),
    diskBytes,
    ...(pgTools ? { pgTools: await pgTools() } : {}),
  };
}

export async function updateBackupSettings(
  db: DbOrTx,
  actor: { orgId: string; userId: string },
  input: BackupSettings,
  req?: RequestInfo,
) {
  if (!validZone(input.timezone)) {
    throw new AppError('validation_failed', { field: 'timezone' });
  }
  await db
    .insert(backupSettings)
    .values({ id: 1, ...input, updatedBy: actor.userId, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: backupSettings.id,
      set: { ...input, updatedBy: actor.userId, updatedAt: new Date() },
    });
  await identityAudit(
    db,
    {
      orgId: actor.orgId,
      actorId: actor.userId,
      action: 'backup.settings.update',
      targetType: 'backup_settings',
      meta: { ...input },
    },
    req,
  );
}

/** "Şimdi yedek al": one queued or running backup at a time. */
export async function startBackup(
  deps: { db: Db; jobs: Jobs },
  actor: { orgId: string; userId: string },
  req?: RequestInfo,
): Promise<BackupRun> {
  const [busy] = await deps.db
    .select({ id: backupRuns.id })
    .from(backupRuns)
    .where(inArray(backupRuns.status, ['queued', 'running']))
    .limit(1);
  if (busy) throw new AppError('conflict', { reason: 'backup_running' });
  const [run] = await deps.db
    .insert(backupRuns)
    .values({ trigger: 'manual', requestedBy: actor.userId })
    .returning();
  await identityAudit(
    deps.db,
    {
      orgId: actor.orgId,
      actorId: actor.userId,
      action: 'backup.start',
      targetType: 'backup_run',
      targetId: run!.id,
    },
    req,
  );
  await deps.jobs.send('backup.run', { runId: run!.id });
  const [view] = (await runsView(deps.db, 20)).filter((r) => r.id === run!.id);
  return view!;
}

/**
 * backup.tick (every 5 min): queues tonight's run when it is due, and closes runs a crashed
 * worker left "running".
 */
export async function backupTick(deps: { db: Db; jobs: Jobs }, now = new Date()) {
  await deps.db
    .update(backupRuns)
    .set({ status: 'failed', error: 'interrupted (worker stopped)', finishedAt: now })
    .where(
      and(
        inArray(backupRuns.status, ['queued', 'running']),
        lt(backupRuns.createdAt, new Date(now.getTime() - STALE_RUN_MS)),
      ),
    );
  const settings = await getBackupSettings(deps.db);
  if (!settings.enabled) return null;
  const clock = localClock(now, settings.timezone);
  const since = clock.minutes - minutesOf(settings.time);
  if (since < 0 || since >= DUE_WINDOW_MINUTES) return null;
  const [run] = await deps.db
    .insert(backupRuns)
    .values({ trigger: 'nightly', scheduledFor: clock.date })
    .onConflictDoNothing()
    .returning({ id: backupRuns.id });
  if (!run) return null;
  await deps.jobs.send('backup.run', { runId: run.id });
  return run.id;
}

/** backup.run: takes the snapshot; a nightly run then prunes to `keep` nightly snapshots. */
export async function runBackup(deps: { db: Db; logger: Logger }, ops: OpsDeps, runId: string) {
  const [run] = await deps.db
    .update(backupRuns)
    .set({ status: 'running', startedAt: new Date() })
    .where(and(eq(backupRuns.id, runId), eq(backupRuns.status, 'queued')))
    .returning();
  if (!run) return;
  try {
    const manifest = await createBackup(ops, {
      trigger: run.trigger === 'nightly' ? 'nightly' : 'manual',
      note: run.trigger === 'nightly' ? null : 'Yönetim › Yedekler',
    });
    await deps.db
      .update(backupRuns)
      .set({
        status: 'succeeded',
        snapshotId: manifest.id,
        dbBytes: manifest.database.bytes,
        objectCount: manifest.objects.count,
        objectBytes: manifest.objects.bytes,
        finishedAt: new Date(),
      })
      .where(eq(backupRuns.id, runId));
    if (run.trigger === 'nightly') {
      const { keep } = await getBackupSettings(deps.db);
      const pruned = await ops.repo.prune(keep, ['nightly']);
      if (pruned.snapshots.length) deps.logger.info(pruned, 'nightly backups pruned');
    }
    deps.logger.info({ snapshot: manifest.id, trigger: run.trigger }, 'backup done');
  } catch (err) {
    deps.logger.error({ err, runId }, 'backup failed');
    if (err instanceof PgVersionMismatchError) {
      resetPgToolsCache();
      await identityAudit(deps.db, {
        orgId: await installOrgId(deps.db),
        actorId: null,
        action: 'backup.tools_outdated',
        targetType: 'backup_run',
        targetId: runId,
        meta: { client: err.client, server: err.server },
      }).catch(() => undefined);
    }
    await deps.db
      .update(backupRuns)
      .set({
        status: 'failed',
        error: (err instanceof Error ? err.message : String(err)).slice(0, 1000),
        finishedAt: new Date(),
      })
      .where(eq(backupRuns.id, runId));
  }
}
