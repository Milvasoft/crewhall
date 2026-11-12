import { type BackupOverview, type BackupRun, type BackupSnapshot } from '@crewhall/shared';
import { memberOf, MockApiError, requireUser, type Resolvers } from './core';
import { newId } from './db';
import type { MockState } from './seed';

/**
 * Yönetim › Yedekler in mock mode (roadmap 3). The org owner stands in for the install admin;
 * "Şimdi yedek al" finishes at once with a made-up snapshot.
 */
interface BackupMock {
  configured: boolean;
  settings: BackupOverview['settings'];
  runs: BackupRun[];
  snapshots: BackupSnapshot[];
}

function state(s: MockState): BackupMock {
  const holder = s as MockState & { backups?: BackupMock };
  holder.backups ??= {
    configured: false,
    settings: { enabled: false, time: '03:00', timezone: 'UTC', keep: 7 },
    runs: [],
    snapshots: [
      {
        id: '2026-10-21T00-00-04-120Z',
        createdAt: '2026-10-21T00:00:04.120Z',
        trigger: 'nightly',
        version: '1.4.0',
        note: null,
        dbBytes: 48_200_000,
        objectCount: 1_284,
        objectBytes: 3_900_000_000,
        config: false,
      },
    ],
  };
  return holder.backups;
}

function requireInstallAdmin(s: MockState) {
  const u = requireUser(s);
  if (memberOf(s, u.id)?.role !== 'owner') throw new MockApiError('forbidden');
  return u;
}

function nextRun(settings: BackupOverview['settings']) {
  if (!settings.enabled) return null;
  const [h, m] = settings.time.split(':').map(Number) as [number, number];
  const next = new Date();
  next.setHours(h, m, 0, 0);
  if (next.getTime() <= Date.now()) next.setDate(next.getDate() + 1);
  return next.toISOString();
}

function overview(s: MockState): BackupOverview {
  const b = state(s);
  return {
    settings: b.settings,
    configured: b.configured,
    available: true,
    nextRunAt: nextRun(b.settings),
    runs: b.runs,
    snapshots: b.snapshots,
    diskBytes: b.snapshots.reduce((n, x) => n + x.dbBytes, 0) + (b.snapshots[0]?.objectBytes ?? 0),
  };
}

export const backupResolvers: Resolvers<'getBackups' | 'updateBackupSettings' | 'startBackup'> = {
  getBackups: ({ s }) => {
    requireInstallAdmin(s);
    return overview(s);
  },
  updateBackupSettings: ({ s, body }) => {
    requireInstallAdmin(s);
    state(s).settings = body;
    state(s).configured = true;
    return overview(s);
  },
  startBackup: ({ s }) => {
    const u = requireInstallAdmin(s);
    const b = state(s);
    const now = new Date();
    const id = now.toISOString().replace(/[:.]/g, '-');
    const prev = b.snapshots[0];
    const snapshot: BackupSnapshot = {
      id,
      createdAt: now.toISOString(),
      trigger: 'manual',
      version: prev?.version ?? '1.4.0',
      note: 'Yönetim › Yedekler',
      dbBytes: prev?.dbBytes ?? 40_000_000,
      objectCount: prev?.objectCount ?? 1_000,
      objectBytes: prev?.objectBytes ?? 3_000_000_000,
      config: false,
    };
    const run: BackupRun = {
      id: newId(),
      trigger: 'manual',
      status: 'succeeded',
      snapshotId: id,
      dbBytes: snapshot.dbBytes,
      objectCount: snapshot.objectCount,
      objectBytes: snapshot.objectBytes,
      error: null,
      requestedBy: { id: u.id, name: u.name, email: u.email, imageUrl: u.imageUrl },
      createdAt: now.toISOString(),
      startedAt: now.toISOString(),
      finishedAt: now.toISOString(),
    };
    b.snapshots.unshift(snapshot);
    b.runs.unshift(run);
    return run;
  },
};
