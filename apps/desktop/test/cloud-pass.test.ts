// A sync pass with placeholders instead of downloads: against a fake on any OS, and against the real
// Cloud Files API where the add-on is built. Reads of files not yet here are not part of this.
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMaterializer } from '../src/cloud/materializer';
import { loadCloudFiles } from '../src/cloud/native';
import { runPass, type Materializer, type PassResult } from '../src/sync/pass';
import type { BaseEntry } from '../src/sync/types';
import { FakeDrive } from './fake-drive';

const native = loadCloudFiles(
  join(import.meta.dirname, '../native/cloudfiles/build/Release/cloudfiles.node'),
);
const PROVIDER = 'CrewhallDevTest';

interface Harness {
  materializer: Materializer;
  /** What the item was placed as; undefined for an ordinary file. */
  identity(abs: string): Promise<string | undefined>;
  close(): Promise<void>;
}

/** Stand-ins on the plain file system, known by file id: a rename keeps them, a new file does not. */
function fakeHarness(): Harness {
  const placed = new Map<bigint, string>();
  const idOf = async (abs: string) => (await stat(abs, { bigint: true })).ino;
  const write = async (abs: string, size: number, updatedAt: string) => {
    await writeFile(abs, Buffer.alloc(size));
    await utimes(abs, new Date(updatedAt), new Date(updatedAt));
  };
  return {
    materializer: {
      async placeFile(abs, r) {
        await write(abs, r.size, r.updatedAt);
        placed.set(await idOf(abs), r.nodeId);
      },
      async placeFolder(abs, r) {
        await mkdir(abs);
        placed.set(await idOf(abs), r.nodeId);
      },
      async replaceFile(abs, r) {
        await write(abs, r.size, r.updatedAt);
        placed.set(await idOf(abs), r.nodeId);
      },
      async settle(abs, nodeId) {
        placed.set(await idOf(abs), nodeId);
      },
      async isCurrent(abs, nodeId) {
        return placed.get(await idOf(abs)) === nodeId;
      },
    },
    identity: async (abs) => placed.get(await idOf(abs)),
    close: () => Promise.resolve(),
  };
}

async function realHarness(root: string): Promise<Harness> {
  const cf = native!;
  const options = { root, provider: PROVIDER, account: 'pass' };
  await cf.registerRoot({ ...options, version: '1.0' });
  const key = await cf.connect(root, () => undefined);
  return {
    materializer: createMaterializer(cf),
    identity: async (abs) => {
      const info = await cf.info(abs);
      return info.placeholder ? info.identity : undefined;
    },
    close: async () => {
      await cf.disconnect(key);
      await cf.unregisterRoot(options);
    },
  };
}

const kinds: Array<[string, boolean]> = [
  ['fake', true],
  ['real Cloud Files API', native !== null],
];

describe.each(kinds)('a pass with placeholders (%s)', (kind, available) => {
  let dir: string;
  let root: string;
  let drive: FakeDrive;
  let base: Map<string, BaseEntry>;
  let harness: Harness;
  let mtime = Date.parse('2026-10-22T09:00:00.000Z');

  const abs = (path: string) => join(root, ...path.split('/'));

  const pass = async (): Promise<PassResult> => {
    const result = await runPass({
      root,
      spaceId: drive.spaceId,
      folderId: null,
      drive,
      base,
      platform: 'win32',
      device: 'LAPTOP',
      conflictLabel: 'çakışan kopya',
      trash: (p) => rm(p, { recursive: true, force: true }),
      now: () => new Date(2026, 9, 22, 14, 5),
      materializer: harness.materializer,
    });
    base = result.base;
    expect(result.errors).toEqual([]);
    return result;
  };

  /** Passes until nothing is left to do; a pass that keeps finding work is a bug here. */
  const settled = async (): Promise<void> => {
    drive.calls.length = 0;
    const result = await pass();
    expect(result.stats).toEqual({
      uploaded: 0,
      moved: 0,
      movedLocal: 0,
      downloaded: 0,
      deletedLocal: 0,
      deletedRemote: 0,
      conflicts: 0,
    });
    expect(drive.calls.filter((c) => !c.startsWith('list'))).toEqual([]);
  };

  const writeLocal = async (path: string, content: string): Promise<void> => {
    await mkdir(dirname(abs(path)), { recursive: true });
    await writeFile(abs(path), content);
    mtime += 60_000;
    await utimes(abs(path), new Date(mtime), new Date(mtime));
  };

  const names = async (path = ''): Promise<string[]> => (await readdir(abs(path))).sort();

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'crewhall-cf-pass-')));
    root = join(dir, 'kok');
    await mkdir(root);
    drive = new FakeDrive();
    base = new Map();
    if (available) harness = kind === 'fake' ? fakeHarness() : await realHarness(root);
  });

  afterEach(async () => {
    if (available) await harness.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it.runIf(available)('shows what is on the server without downloading it', async () => {
    const file = drive.put('docs/rapor ğ.txt', 'on bayt var');
    await pass();
    expect(drive.calls.filter((c) => c.startsWith('download'))).toEqual([]);
    const s = await stat(abs('docs/rapor ğ.txt'));
    expect(s.size).toBe('on bayt var'.length);
    expect(s.mtimeMs).toBe(Date.parse(file.updatedAt));
    expect(await harness.identity(abs('docs/rapor ğ.txt'))).toBe(file.id);
    expect(await harness.identity(abs('docs'))).toBe(drive.find('docs')!.id);
    await settled();
  });

  it.runIf(available)('takes a new version from the server without downloading it', async () => {
    const file = drive.put('a.txt', 'eski');
    await pass();
    drive.put('a.txt', 'çok daha uzun içerik');
    drive.calls.length = 0;
    const result = await pass();
    expect(result.stats.downloaded).toBe(1);
    expect(drive.calls.filter((c) => c.startsWith('download'))).toEqual([]);
    expect((await stat(abs('a.txt'))).size).toBe(Buffer.byteLength('çok daha uzun içerik'));
    expect((await stat(abs('a.txt'))).mtimeMs).toBe(Date.parse(file.updatedAt));
    await settled();
  });

  it.runIf(available)('uploads a new file once and makes it one of ours', async () => {
    await writeLocal('yeni.txt', 'burada yazıldı');
    const before = await stat(abs('yeni.txt'), { bigint: true });
    expect((await pass()).stats.uploaded).toBe(1);
    const node = drive.find('yeni.txt')!;
    expect(node.content.toString()).toBe('burada yazıldı');
    expect(await harness.identity(abs('yeni.txt'))).toBe(node.id);
    const after = await stat(abs('yeni.txt'), { bigint: true });
    expect([after.ino, after.mtimeMs, after.size]).toEqual([
      before.ino,
      before.mtimeMs,
      before.size,
    ]);
    expect(await readFile(abs('yeni.txt'), 'utf8')).toBe('burada yazıldı');
    await settled();
  });

  it.runIf(available)('uploads a new folder with what is in it', async () => {
    await writeLocal('Klasör/iç/a.txt', 'alt');
    await pass();
    expect(drive.tree()).toEqual(['Klasör/', 'Klasör/iç/', 'Klasör/iç/a.txt=alt']);
    expect(await harness.identity(abs('Klasör/iç'))).toBe(drive.find('Klasör/iç')!.id);
    await settled();
  });

  it.runIf(available)('sends a save over a file as a new version of the same node', async () => {
    await writeLocal('a.txt', 'ilk');
    await pass();
    const node = drive.find('a.txt')!;
    await writeLocal('a.txt', 'ikinci hali');
    expect((await pass()).stats.uploaded).toBe(1);
    expect(drive.find('a.txt')!.id).toBe(node.id);
    expect(node.version).toBe(2);
    expect(await harness.identity(abs('a.txt'))).toBe(node.id);
    await settled();
  });

  it.runIf(available)(
    'follows a rename on the server: the placeholder moves as it is',
    async () => {
      const file = drive.put('d/a.txt', 'içerik');
      await pass();
      drive.relocate('d', 'yeni');
      const result = await pass();
      expect(result.stats).toMatchObject({ movedLocal: 1, downloaded: 0, deletedLocal: 0 });
      expect(await harness.identity(abs('yeni/a.txt'))).toBe(file.id);
      expect(await names()).toEqual(['yeni']);
      await settled();
    },
  );

  it.runIf(available)('carries a rename made here to the server', async () => {
    const file = drive.put('a.txt', 'içerik');
    await pass();
    await rename(abs('a.txt'), abs('b.txt'));
    expect((await pass()).stats.moved).toBe(1);
    expect(drive.find('b.txt')!.id).toBe(file.id);
    expect(await harness.identity(abs('b.txt'))).toBe(file.id);
    await settled();
  });

  it.runIf(available)('takes a new version after a rename on either side', async () => {
    const there = drive.put('sunucuda.txt', 'x');
    const here = drive.put('burada.txt', 'y');
    const within = drive.put('d/ic.txt', 'z');
    await pass();

    drive.relocate('sunucuda.txt', 'sunucuda2.txt');
    await rename(abs('burada.txt'), abs('burada2.txt'));
    drive.relocate('d', 'e');
    await pass();
    for (const [path, node] of [
      ['sunucuda2.txt', there],
      ['burada2.txt', here],
      ['e/ic.txt', within],
    ] as const) {
      expect(await harness.materializer.isCurrent(abs(path), node.id)).toBe(true);
      drive.put(path, 'yepyeni uzun içerik');
    }
    const result = await pass();
    expect(result.stats).toMatchObject({ downloaded: 3, conflicts: 0, uploaded: 0 });
    expect((await stat(abs('e/ic.txt'))).size).toBe(Buffer.byteLength('yepyeni uzun içerik'));
    await settled();
  });

  it.runIf(available)(
    'removes what the server deleted and deletes what is removed here',
    async () => {
      drive.put('sunucu/a.txt', 'x');
      drive.put('burada.txt', 'y');
      await pass();
      drive.remove('sunucu');
      await rm(abs('burada.txt'));
      expect((await pass()).stats).toMatchObject({ deletedLocal: 1, deletedRemote: 1 });
      expect(await names()).toEqual([]);
      expect(drive.tree()).toEqual([]);
      await settled();
    },
  );

  it.runIf(available)('keeps both when both sides changed', async () => {
    const file = drive.put('a.txt', 'ilk');
    await pass();
    await rm(abs('a.txt'));
    await writeLocal('a.txt', 'buradaki hal');
    drive.put('a.txt', 'sunucudaki hal');
    await pass();
    const copy = (await names()).find((n) => n !== 'a.txt')!;
    expect(copy).toContain('çakışan kopya');
    expect(await readFile(abs(copy), 'utf8')).toBe('buradaki hal');
    expect(await harness.identity(abs('a.txt'))).toBe(file.id);
    expect((await stat(abs('a.txt'))).size).toBe('sunucudaki hal'.length);
    await pass();
    expect(await harness.identity(abs(copy))).toBe(drive.find(copy)!.id);
    expect(drive.read(copy)).toBe('buradaki hal');
    await settled();
  });

  it.runIf(available)('adopts the same folder made on both sides', async () => {
    const folder = drive.mkdir('Ortak');
    await mkdir(abs('Ortak'));
    await pass();
    expect(await harness.identity(abs('Ortak'))).toBe(folder.id);
    await settled();
  });

  it.runIf(available)('recognizes its own placeholders when the sync state is lost', async () => {
    const file = drive.put('d/a.txt', 'içerik');
    await pass();
    base = new Map();
    await settled();
    expect(await harness.identity(abs('d/a.txt'))).toBe(file.id);
    expect(base.get('d/a.txt')?.nodeId).toBe(file.id);
  });

  it.runIf(available)('with the state lost, still catches a version it does not have', async () => {
    drive.put('a.txt', 'eski');
    await pass();
    base = new Map();
    drive.put('a.txt', 'yepyeni içerik');
    drive.calls.length = 0;
    const result = await pass();
    expect(result.stats).toMatchObject({ downloaded: 1, conflicts: 0, uploaded: 0 });
    expect(drive.calls.filter((c) => c.startsWith('download'))).toEqual([]);
    expect((await stat(abs('a.txt'))).size).toBe(Buffer.byteLength('yepyeni içerik'));
    await settled();
  });

  it.runIf(available)('with the state lost, an edit made here is not taken for ours', async () => {
    const file = drive.put('a.txt', 'eski');
    await pass();
    base = new Map();
    await rm(abs('a.txt'));
    await writeLocal('a.txt', 'buradaki farklı hal');
    await pass();
    const copy = (await names()).find((n) => n !== 'a.txt')!;
    expect(await readFile(abs(copy), 'utf8')).toBe('buradaki farklı hal');
    expect(await harness.identity(abs('a.txt'))).toBe(file.id);
  });

  it.runIf(available)(
    'turns an ordinary file back into a placeholder for a new version',
    async () => {
      await writeLocal('a.txt', 'ilk');
      await pass();
      const node = drive.find('a.txt')!;
      // What is left if the conversion after an upload failed.
      const { size, mtimeMs } = await stat(abs('a.txt'));
      await rm(abs('a.txt'));
      await writeFile(abs('a.txt'), 'ilk');
      await utimes(abs('a.txt'), new Date(mtimeMs), new Date(mtimeMs));
      expect((await stat(abs('a.txt'))).size).toBe(size);
      base.set('a.txt', { ...base.get('a.txt')!, localId: undefined });
      drive.put('a.txt', 'sunucudan yeni');
      const result = await pass();
      expect(result.stats).toMatchObject({ downloaded: 1, conflicts: 0 });
      expect(await harness.identity(abs('a.txt'))).toBe(node.id);
      expect((await stat(abs('a.txt'))).size).toBe('sunucudan yeni'.length);
      await settled();
    },
  );

  it.runIf(available)(
    'does not fail an upload when marking the file afterwards fails',
    async () => {
      await writeLocal('a.txt', 'içerik');
      const { settle } = harness.materializer;
      harness.materializer.settle = () => Promise.reject(new Error('sharing violation'));
      try {
        const result = await pass();
        expect(result.stats.uploaded).toBe(1);
        expect(drive.read('a.txt')).toBe('içerik');
      } finally {
        harness.materializer.settle = settle;
      }
      await settled();
    },
  );
});
