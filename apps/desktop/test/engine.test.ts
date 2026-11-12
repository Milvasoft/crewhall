import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SyncEngine, type PairStatus, type SyncPair } from '../src/sync/engine';
import { FakeDrive } from './fake-drive';

let dir: string;
let drive: FakeDrive;
let engine: SyncEngine;
let statuses: PairStatus[];
let notifyLocal: (() => void) | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'crewhall-engine-'));
  await mkdir(join(dir, 'local'));
  drive = new FakeDrive();
  statuses = [];
  engine = new SyncEngine({
    createDrive: () => drive,
    platform: 'win32',
    device: () => 'PC',
    conflictLabel: () => 'çakışan kopya',
    trash: (abs) => rm(abs, { recursive: true, force: true }),
    stateDir: join(dir, 'state'),
    onStatus: (s) => (statuses = s),
    watchFolder: (_root, onChange) => {
      notifyLocal = onChange;
      return () => (notifyLocal = undefined);
    },
    debounceMs: 5,
    intervalMs: 60_000,
  });
});

afterEach(async () => {
  engine.stop();
  await rm(dir, { recursive: true, force: true });
});

const pair = (patch: Partial<SyncPair> = {}): SyncPair => ({
  id: 'p1',
  spaceId: drive.spaceId,
  spaceName: 'Pazarlama',
  folderId: null,
  folderPath: '',
  localPath: join(dir, 'local'),
  paused: false,
  ...patch,
});

describe('SyncEngine with real folder watching', () => {
  let watched: SyncEngine;

  const until = async (what: string, check: () => boolean): Promise<void> => {
    const end = Date.now() + 10_000;
    while (!check()) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  beforeEach(() => {
    watched = new SyncEngine({
      createDrive: () => drive,
      platform: 'win32',
      device: () => 'PC',
      conflictLabel: () => 'çakışan kopya',
      trash: (abs) => rm(abs, { recursive: true, force: true }),
      stateDir: join(dir, 'state'),
      onStatus: (s) => (statuses = s),
      debounceMs: 5,
      intervalMs: 60_000,
    });
  });

  afterEach(() => watched.stop());

  it('reports a deleted folder instead of drowning in its events, and picks it up again', async () => {
    watched.setPairs([pair()]);
    await watched.idle();
    await rm(join(dir, 'local'), { recursive: true });
    await until('the error', () => statuses[0]?.error?.code === 'local_root_missing');
    await watched.idle();

    await mkdir(join(dir, 'local'));
    watched.syncNow();
    await until('the recovery', () => statuses[0]?.state === 'idle');
    await watched.idle();

    await writeFile(join(dir, 'local', 'geri.txt'), 'G');
    await until('the upload', () => drive.read('geri.txt') === 'G');
    await watched.idle();
  });

  it('holds a pair: no pass until it is listed again, and its state stays', async () => {
    drive.put('a.txt', 'A');
    watched.setPairs([pair()]);
    await watched.idle();
    await watched.hold('p1');
    expect(statuses.length).toBe(1);
    await writeFile(join(dir, 'local', 'b.txt'), 'B');
    await new Promise((r) => setTimeout(r, 50));
    await watched.idle();
    expect(drive.read('b.txt')).toBeUndefined();
    await readFile(join(dir, 'state', 'p1.json'));

    watched.setPairs([pair()]);
    await until('the upload', () => drive.read('b.txt') === 'B');
    await watched.idle();
  });

  it('forgets a pair: what is missing no longer reads as deleted', async () => {
    drive.put('a.txt', 'A');
    watched.setPairs([pair()]);
    await watched.idle();
    await watched.forget('p1');
    await rm(join(dir, 'local', 'a.txt'));
    watched.setPairs([pair()]);
    await until('the file back', () => existsSync(join(dir, 'local', 'a.txt')));
    await watched.idle();
    expect(drive.read('a.txt')).toBe('A');
    expect(await readFile(join(dir, 'local', 'a.txt'), 'utf8')).toBe('A');
  });
});

describe('SyncEngine', () => {
  it('syncs a new pair right away and keeps its state between runs', async () => {
    drive.put('a.txt', 'A');
    engine.setPairs([pair()]);
    await engine.idle();
    expect(await readFile(join(dir, 'local', 'a.txt'), 'utf8')).toBe('A');
    expect(statuses[0]).toMatchObject({ state: 'idle', stats: { downloaded: 1 } });
    const saved = JSON.parse(await readFile(join(dir, 'state', 'p1.json'), 'utf8'));
    expect(saved.entries.map((e: [string]) => e[0])).toEqual(['a.txt']);
  });

  it('runs again on local and remote change events', async () => {
    engine.setPairs([pair()]);
    await engine.idle();

    await writeFile(join(dir, 'local', 'new.txt'), 'N');
    notifyLocal?.();
    await engine.idle();
    expect(drive.read('new.txt')).toBe('N');

    drive.put('remote.txt', 'R');
    engine.notifyRemoteChange(drive.spaceId);
    await engine.idle();
    expect(await readFile(join(dir, 'local', 'remote.txt'), 'utf8')).toBe('R');
  });

  it('ignores remote changes of other spaces and does not run while paused', async () => {
    engine.setPairs([pair({ paused: true })]);
    drive.put('a.txt', 'A');
    engine.notifyRemoteChange(drive.spaceId);
    engine.syncNow();
    await engine.idle();
    expect(statuses[0]?.state).toBe('paused');
    expect(drive.calls).toEqual([]);

    engine.setPairs([pair()]);
    await engine.idle();
    drive.calls.length = 0;
    engine.notifyRemoteChange('other-space');
    await engine.idle();
    expect(drive.calls).toEqual([]);
  });

  it('asks for confirmation before a large delete and goes on once confirmed', async () => {
    for (let i = 0; i < 60; i++) drive.put(`f${i}.txt`, String(i));
    engine.setPairs([pair()]);
    await engine.idle();
    await rm(join(dir, 'local'), { recursive: true });
    await mkdir(join(dir, 'local'));

    engine.syncNow();
    await engine.idle();
    expect(statuses[0]).toMatchObject({ state: 'confirm', error: { code: 'mass_delete' } });
    expect(drive.tree()).toHaveLength(60);

    engine.confirmDeletes('p1');
    await engine.idle();
    expect(statuses[0]?.state).toBe('idle');
    expect(drive.tree()).toEqual([]);
  });

  it('reports a missing local folder as an error and drops state of removed pairs', async () => {
    engine.setPairs([pair({ localPath: join(dir, 'nope') })]);
    await engine.idle();
    expect(statuses[0]).toMatchObject({ state: 'error', error: { code: 'local_root_missing' } });

    engine.setPairs([pair()]);
    await engine.idle();
    engine.setPairs([]);
    await new Promise((r) => setTimeout(r, 20));
    await expect(readFile(join(dir, 'state', 'p1.json'))).rejects.toThrow();
  });
});
