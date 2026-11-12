import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLogs, backupRuns } from '@crewhall/db';
import { opsDepsFromAppEnv } from '../src/ops/deps';
import { runBackup, resetPgToolsCache } from '../src/services/backups/service';
import {
  backupTick,
  nextRunAt,
  requireInstallAdmin,
  zonedInstant,
} from '../src/services/backups/service';
import { Client, createTestApp, join as joinOrg, setupWithOwner, type TestApp } from './helpers';

/**
 * Yönetim › Yedekler (roadmap 3): the install admin sets the nightly schedule, starts a
 * backup, sees runs and snapshots; the worker's tick runs tonight's backup once and keeps
 * the configured number of nightly snapshots.
 */
describe('nightly backup from the admin area', { timeout: 300_000 }, () => {
  let app: TestApp;
  let owner: Client;
  let admin: Client;
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'crewhall-nightly-'));
    app = await createTestApp({
      CREWHALL_BACKUP_DIR: dir,
      // The image has pg_dump; developer machines and CI may only have Docker.
      CREWHALL_PG_TOOLS: spawnSync('pg_dump', ['--version']).status === 0 ? 'local' : 'docker',
    });
    const setup = await setupWithOwner(app);
    owner = setup.owner;
    const spaceId = (await owner.api.call('listSpaces')).items.find(
      (s) => s.name === 'Milvasoft',
    )!.id;
    admin = (await joinOrg(app, owner, 'uye@milvasoft.com', 'member', [spaceId])).person;
  });
  afterAll(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('is for the install admin only', async () => {
    expect((await owner.api.call('me')).installAdmin).toBe(true);
    expect((await admin.api.call('me')).installAdmin).toBe(false);
    await expect(admin.api.call('getBackups')).rejects.toMatchObject({ code: 'forbidden' });
    await expect(admin.api.call('startBackup')).rejects.toMatchObject({ code: 'forbidden' });
    // An owner of any other org is not the install admin either.
    await expect(requireInstallAdmin(app.deps.db, randomUUID(), 'owner')).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('saves the schedule and tells when the next run is', async () => {
    const empty = await owner.api.call('getBackups');
    expect(empty).toMatchObject({
      settings: { enabled: false, time: '03:00', keep: 7 },
      configured: false,
      available: true,
      nextRunAt: null,
      runs: [],
      snapshots: [],
    });
    await expect(
      owner.api.call('updateBackupSettings', {
        body: { enabled: true, time: '03:00', timezone: 'Mars/Olympus', keep: 2 },
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    const saved = await owner.api.call('updateBackupSettings', {
      body: { enabled: true, time: '03:00', timezone: 'Europe/Istanbul', keep: 2 },
    });
    expect(saved.configured).toBe(true);
    expect(saved.settings).toEqual({
      enabled: true,
      time: '03:00',
      timezone: 'Europe/Istanbul',
      keep: 2,
    });
    // 03:00 in Istanbul is 00:00 UTC.
    expect(saved.nextRunAt).toMatch(/T00:00:00\.000Z$/);
  });

  it('runs "Şimdi yedek al" and lists the snapshot', async () => {
    const run = await owner.api.call('startBackup');
    expect(run.trigger).toBe('manual');
    const view = await owner.api.call('getBackups');
    const done = view.runs.find((r) => r.id === run.id)!;
    expect(done.status, done.error ?? '').toBe('succeeded');
    expect(done.requestedBy?.email).toBe('bugra@milvasoft.com');
    expect(view.snapshots.map((s) => s.id)).toEqual([done.snapshotId]);
    expect(view.diskBytes).toBeGreaterThan(0);

    // One at a time.
    await app.deps.db.insert(backupRuns).values({ trigger: 'manual', status: 'running' });
    await expect(owner.api.call('startBackup')).rejects.toMatchObject({ code: 'conflict' });
    await app.deps.db.delete(backupRuns).where(eq(backupRuns.status, 'running'));
  });

  it('runs once a night in the configured zone and keeps the configured number', async () => {
    const tick = (iso: string) => backupTick(app.deps, new Date(iso));
    // 23:00 in Istanbul: not yet.
    expect(await tick('2026-10-21T20:00:00Z')).toBeNull();
    // 03:30 in Istanbul: tonight's run, once.
    expect(await tick('2026-10-22T00:30:00Z')).not.toBeNull();
    expect(await tick('2026-10-22T00:35:00Z')).toBeNull();
    // More than six hours late: skipped, not caught up in the afternoon.
    expect(await tick('2026-10-23T10:00:00Z')).toBeNull();
    expect(await tick('2026-10-24T00:10:00Z')).not.toBeNull();
    expect(await tick('2026-10-25T00:10:00Z')).not.toBeNull();

    const view = await owner.api.call('getBackups');
    const nightly = view.runs.filter((r) => r.trigger === 'nightly');
    expect(nightly.map((r) => r.status)).toEqual(['succeeded', 'succeeded', 'succeeded']);
    // keep = 2 nightly snapshots; the manual one stays.
    expect(view.snapshots.map((s) => s.trigger).sort()).toEqual(['manual', 'nightly', 'nightly']);
  });

  it('closes runs a stopped worker left running', async () => {
    const [stale] = await app.deps.db
      .insert(backupRuns)
      .values({
        trigger: 'manual',
        status: 'running',
        createdAt: new Date(Date.now() - 13 * 3_600_000),
      })
      .returning();
    await backupTick(app.deps);
    const [row] = await app.deps.db.select().from(backupRuns).where(eq(backupRuns.id, stale!.id));
    expect(row).toMatchObject({ status: 'failed', error: 'interrupted (worker stopped)' });
  });

  it('shows whether pg_dump can dump this server, and fails a run that cannot', async () => {
    resetPgToolsCache();
    const view = await owner.api.call('getBackups');
    expect(view.pgTools).toMatchObject({ compatible: true });
    expect(view.pgTools!.client).toBeGreaterThanOrEqual(view.pgTools!.server!);

    // The server's tools are older than the database (the test server case): the run fails
    // with a clear message before any dump, and the install's audit log says why.
    const ops = opsDepsFromAppEnv(app.deps.env);
    const server = view.pgTools!.server!;
    const [run] = await app.deps.db
      .insert(backupRuns)
      .values({ trigger: 'manual', status: 'queued' })
      .returning();
    await runBackup(
      { db: app.deps.db, logger: app.deps.logger },
      { ...ops, pg: { ...ops.pg, version: async () => server - 1 } },
      run!.id,
    );
    const [failed] = await app.deps.db.select().from(backupRuns).where(eq(backupRuns.id, run!.id));
    expect(failed).toMatchObject({ status: 'failed' });
    expect(failed!.error).toContain(`is older than the PostgreSQL ${server} server`);
    const [log] = await app.deps.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'backup.tools_outdated'));
    expect(log!.meta).toMatchObject({ client: server - 1, server });
  });

  it('computes local times across zones and DST', () => {
    expect(zonedInstant('2026-07-01', '03:00', 'America/New_York').toISOString()).toBe(
      '2026-07-01T07:00:00.000Z',
    );
    expect(zonedInstant('2026-12-01', '03:00', 'America/New_York').toISOString()).toBe(
      '2026-12-01T08:00:00.000Z',
    );
    const settings = { enabled: true, time: '03:00', timezone: 'Europe/Istanbul', keep: 7 };
    // Today's run already happened: the next one is tomorrow.
    expect(
      nextRunAt(settings, new Date('2026-10-22T00:30:00Z'), new Set(['2026-10-22']))?.toISOString(),
    ).toBe('2026-10-23T00:00:00.000Z');
    expect(nextRunAt({ ...settings, enabled: false }, new Date(), new Set())).toBeNull();
  });
});
