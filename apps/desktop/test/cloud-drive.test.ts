// The whole virtual drive against the real Cloud Files API, a fake server and real folder watching.
// Skipped where the add-on is not built. Nothing is written to the registry (`shell: false`).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  appendFile,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DriveChange, DriveChangesPage, DriveNode } from '@crewhall/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CloudDrive, spaceFolders } from '../src/cloud/drive';
import { loadCloudFiles } from '../src/cloud/native';
import type { PairStatus } from '../src/sync/engine';
import type { RemoteDrive } from '../src/sync/remote';
import { FakeDrive } from './fake-drive';

describe('spaceFolders', () => {
  const s = (id: string, name: string) => ({ id, name });

  it('uses the name of the space where it can', () => {
    expect([...spaceFolders([s('a', 'Pazarlama')], 'win32').values()]).toEqual(['Pazarlama']);
  });

  it('replaces what Windows refuses', () => {
    const out = spaceFolders(
      [s('a', 'İK: 2026/Plan?'), s('b', 'con'), s('c', 'nokta...'), s('d', '...')],
      'win32',
    );
    expect(out.get('a')).toBe('İK_ 2026_Plan_');
    expect(out.get('b')).toBe('_con');
    expect(out.get('c')).toBe('nokta');
    expect(out.get('d')).toBe('_');
  });

  it('numbers names that clash, ignoring case on Windows', () => {
    const out = spaceFolders([s('b', 'ortak'), s('a', 'Ortak'), s('c', 'ORTAK')], 'win32');
    expect(out).toEqual(
      new Map([
        ['a', 'Ortak'],
        ['b', 'ortak (2)'],
        ['c', 'ORTAK (3)'],
      ]),
    );
  });

  it('does not number them on a file system that tells them apart', () => {
    expect([...spaceFolders([s('a', 'Ortak'), s('b', 'ortak')], 'linux').values()]).toEqual([
      'Ortak',
      'ortak',
    ]);
  });

  it('keeps a name with its owner when a new space wants it', () => {
    const known = new Map([['z', 'Ortak']]);
    const out = spaceFolders([s('a', 'Ortak'), s('z', 'Ortak')], 'win32', known);
    expect(out.get('z')).toBe('Ortak');
    expect(out.get('a')).toBe('Ortak (2)');
  });

  it('follows a rename', () => {
    const out = spaceFolders([s('a', 'Yeni')], 'win32', new Map([['a', 'Eski']]));
    expect(out.get('a')).toBe('Yeni');
  });
});

const native = loadCloudFiles(
  join(import.meta.dirname, '../native/cloudfiles/build/Release/cloudfiles.node'),
);
const SPACE = 'space-1';
const SECOND = 'space-2';

/** The feed the fake server would give: rows stay behind until `publish`. */
class ServerFeed {
  private rows: DriveChange[] = [];
  private n = 0;
  /** A page in the air: for a feed that lags. */
  publish(rows: DriveChange[]): void {
    this.rows.push(...rows);
  }
  page(cursor?: string): Promise<DriveChangesPage> {
    if (cursor === undefined) {
      return Promise.resolve({ items: [], nextCursor: 'head', hasMore: false });
    }
    const items = this.rows;
    this.rows = [];
    return Promise.resolve({ items, nextCursor: `c${++this.n}`, hasMore: false });
  }
}

function row(drive: FakeDrive, path: string, type: DriveChange['type']): DriveChange {
  const n = drive.find(path)!;
  return {
    type,
    spaceId: SPACE,
    nodeId: n.id,
    node: {
      id: n.id,
      parentId: n.parentId,
      name: n.name,
      type: n.kind,
      sizeBytes: n.content.length,
      version: n.version,
      updatedAt: n.updatedAt,
      deletedAt: null,
      myRole: 'owner',
    } as unknown as DriveNode,
    space: null,
    reason: null,
    at: n.updatedAt,
  };
}

describe.skipIf(!native)('CloudDrive', () => {
  const cf = native!;
  let base: string;
  let root: string;
  let stateDir: string;
  let server: FakeDrive;
  let feed: ServerFeed;
  let drive: CloudDrive;
  let statuses: PairStatus[];
  let downloads: number;
  let reads: string[];
  let uploadsHeld: Promise<void> = Promise.resolve();
  let itemStates: Map<string, string>;

  const spaces = [{ id: SPACE, name: 'Ekip' }];

  const read = (path: string): Promise<{ code: number | null; text: string }> =>
    new Promise((resolve) => {
      const script =
        "try{process.stdout.write(require('fs').readFileSync(process.argv[1]))}" +
        'catch(e){process.exit(3)}';
      const child = spawn(process.execPath, ['-e', script, path], { windowsHide: true });
      let text = '';
      child.stdout.on('data', (d: Buffer) => (text += d.toString()));
      child.on('close', (code) => resolve({ code, text }));
    });

  const make = (): CloudDrive => {
    const remote: RemoteDrive = {
      getNode: (id) => server.getNode(id),
      // The fake holds one space; the second one is empty.
      list: (space, parent) => (space === SPACE ? server.list(space, parent) : Promise.resolve([])),
      createFolder: (...a) => server.createFolder(...a),
      upload: async (space, parent, name, file, nodeId) => {
        await uploadsHeld;
        return server.upload(space, parent, name, file, nodeId);
      },
      move: (...a) => server.move(...a),
      download: (id, dest) => {
        downloads++;
        return server.download(id, dest);
      },
      trash: (id) => server.trash(id),
    };
    return new CloudDrive({
      // Explorer's side needs a registered root, which writes to the registry.
      native: {
        ...cf,
        setItemState: (path, text) => {
          if (text) itemStates.set(path, text);
          else itemStates.delete(path);
          return Promise.resolve();
        },
      },
      describeProblem: (reason) => reason ?? 'yüklenemedi',
      root,
      provider: 'CrewhallDevTest',
      account: 'drive',
      version: '1.0',
      shell: false,
      stateDir,
      createDrive: () => remote,
      feed,
      source: {
        read: (nodeId, from) => {
          reads.push(nodeId);
          const content = server.nodes.get(nodeId)!.content.subarray(from);
          return Promise.resolve(
            (async function* () {
              await Promise.resolve();
              yield content;
            })(),
          );
        },
      },
      platform: 'win32',
      device: () => 'LAPTOP',
      conflictLabel: () => 'çakışan kopya',
      onStatus: (s) => (statuses = s),
      debounceMs: 30,
      intervalMs: 3_600_000,
      pollMs: 3_600_000,
    });
  };

  const settle = async (ms = 200): Promise<void> => {
    await drive.idle();
    // Folder events of what the last pass did arrive a moment later.
    await new Promise((r) => setTimeout(r, ms));
    await drive.idle();
  };

  const until = async (what: string, check: () => boolean | Promise<boolean>): Promise<void> => {
    const end = Date.now() + 10_000;
    while (!(await check())) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  const p = (...parts: string[]) => join(root, 'Ekip', ...parts);

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'crewhall-cf-drive-')));
    root = join(base, 'Crewhall');
    stateDir = join(base, 'state');
    server = new FakeDrive(SPACE);
    feed = new ServerFeed();
    statuses = [];
    downloads = 0;
    reads = [];
    itemStates = new Map();
    uploadsHeld = Promise.resolve();
    drive = make();
  });

  afterEach(async () => {
    await drive.remove().catch(() => undefined);
    await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('shows the server in the folder and downloads a file only when it is read', async () => {
    server.put('docs/rapor ğ.txt', 'içerik burada');
    await drive.start(spaces);
    await settle();
    expect(await readdir(root)).toEqual(['Ekip']);
    expect((await stat(p('docs', 'rapor ğ.txt'))).size).toBe(Buffer.byteLength('içerik burada'));
    expect((await cf.info(p('docs', 'rapor ğ.txt'))).onDisk).toBe(0);
    expect(downloads).toBe(0);
    expect(reads).toEqual([]);

    expect((await read(p('docs', 'rapor ğ.txt'))).text).toBe('içerik burada');
    expect(reads).toEqual([server.find('docs/rapor ğ.txt')!.id]);
    await settle();
    expect(statuses[0]).toMatchObject({ state: 'idle', error: null, failed: [] });
    expect(server.tree()).toEqual(['docs/', 'docs/rapor ğ.txt=içerik burada']);
  });

  it('takes a change on the server when the feed says so', async () => {
    server.put('a.txt', 'eski');
    server.put('sil.txt', 'x');
    server.mkdir('kalan');
    await drive.start(spaces);
    await settle();
    expect((await read(p('a.txt'))).text).toBe('eski');

    server.put('a.txt', 'yepyeni içerik');
    server.put('yeni.txt', 'y');
    server.relocate('kalan', 'adlandi');
    const trashed = server.find('sil.txt')!.id;
    server.remove('sil.txt');
    feed.publish([
      row(server, 'a.txt', 'updated'),
      row(server, 'yeni.txt', 'created'),
      row(server, 'adlandi', 'updated'),
      {
        type: 'deleted',
        spaceId: SPACE,
        nodeId: trashed,
        node: null,
        space: null,
        reason: 'trashed',
        at: '2026-11-05T10:00:00.000Z',
      },
    ]);
    drive.notifyChange();
    await until('the new file', () => existsSync(p('yeni.txt')));
    await settle();
    expect((await readdir(p())).sort()).toEqual(['a.txt', 'adlandi', 'yeni.txt']);
    expect((await read(p('a.txt'))).text).toBe('yepyeni içerik');
    expect(downloads).toBe(0);
  });

  it('uploads a new file and does not take it for deleted while the feed lags', async () => {
    await drive.start(spaces);
    await settle();
    await writeFile(p('yeni.txt'), 'burada yazıldı');
    await until('the upload', () => server.find('yeni.txt') !== undefined);
    await settle();

    // The feed has not mentioned this file yet, and several passes have run since.
    drive.syncNow();
    await settle();
    drive.syncNow();
    await settle();
    expect(await readFile(p('yeni.txt'), 'utf8')).toBe('burada yazıldı');
    expect(server.read('yeni.txt')).toBe('burada yazıldı');
    expect(server.calls.filter((c) => c.startsWith('upload'))).toHaveLength(1);
    expect(await cf.info(p('yeni.txt'))).toMatchObject({
      placeholder: true,
      inSync: true,
      identity: server.find('yeni.txt')!.id,
    });

    // Then the feed catches up, which changes nothing.
    feed.publish([row(server, 'yeni.txt', 'created')]);
    drive.notifyChange();
    await settle();
    expect(await readFile(p('yeni.txt'), 'utf8')).toBe('burada yazıldı');
    expect(server.calls.filter((c) => c.startsWith('upload'))).toHaveLength(1);
  });

  it('sends a save over a file as a new version and marks it again', async () => {
    const node = server.put('a.txt', 'ilk hali');
    await drive.start(spaces);
    await settle();
    expect((await read(p('a.txt'))).text).toBe('ilk hali');
    await writeFile(p('a.txt'), 'kaydedilen yeni hal');
    await until('the new version', () => server.read('a.txt') === 'kaydedilen yeni hal');
    await settle();
    expect(node.version).toBe(2);
    expect(await cf.info(p('a.txt'))).toMatchObject({ placeholder: true, inSync: true });
    expect(await readFile(p('a.txt'), 'utf8')).toBe('kaydedilen yeni hal');
  });

  it('carries renames, moves and deletes made in Explorer to the server', async () => {
    const a = server.put('a.txt', 'a');
    server.put('sil.txt', 's');
    server.mkdir('d');
    await drive.start(spaces);
    await settle();

    await rename(p('a.txt'), p('d', 'b.txt'));
    await rm(p('sil.txt'));
    await until('the server', () => server.tree().join() === 'd/,d/b.txt=a');
    await settle();
    expect(server.find('d/b.txt')!.id).toBe(a.id);
    expect(downloads).toBe(0);
    expect(reads).toEqual([]);
  });

  it('never takes a space folder that was deleted for everything deleted', async () => {
    server.put('d/a.txt', 'kalsın');
    server.put('b.txt', 'kalsın');
    await drive.start(spaces);
    await settle();
    await rm(p(), { recursive: true });
    await settle();
    expect(server.tree()).toEqual(['b.txt=kalsın', 'd/', 'd/a.txt=kalsın']);

    drive.notifyChange();
    await until('the folder back', () => existsSync(p('d', 'a.txt')));
    await settle();
    expect(server.tree()).toEqual(['b.txt=kalsın', 'd/', 'd/a.txt=kalsın']);
    expect((await read(p('b.txt'))).text).toBe('kalsın');
  });

  it('adds, renames and takes away spaces', async () => {
    server.put('a.txt', 'x');
    await drive.start(spaces);
    await settle();

    await drive.setSpaces([...spaces, { id: SECOND, name: 'İkinci' }]);
    await settle();
    expect((await readdir(root)).sort()).toEqual(['Ekip', 'İkinci']);

    await drive.setSpaces([
      { id: SPACE, name: 'Yeni Ad' },
      { id: SECOND, name: 'İkinci' },
    ]);
    await settle();
    expect((await readdir(root)).sort()).toEqual(['Yeni Ad', 'İkinci']);
    expect((await read(join(root, 'Yeni Ad', 'a.txt'))).text).toBe('x');
    expect(server.tree()).toEqual(['a.txt=x']);

    // The folder is still watched under its new name.
    await writeFile(join(root, 'Yeni Ad', 'b.txt'), 'y');
    await until('the upload', () => server.read('b.txt') === 'y');
    await settle();

    await drive.setSpaces([{ id: SECOND, name: 'İkinci' }]);
    await settle();
    expect(await readdir(root)).toEqual(['İkinci']);
    expect(server.tree()).toEqual(['a.txt=x', 'b.txt=y']);
  });

  it('loses nothing written just as a space goes away', async () => {
    server.put('a.txt', 'x');
    await drive.start(spaces);
    await settle();
    await writeFile(p('kalsin.txt'), 'yalnız burada');
    await drive.setSpaces([]);
    await settle();
    // Kept here, or uploaded if a pass got there first: either way it still exists.
    const here = existsSync(p('kalsin.txt')) ? await readFile(p('kalsin.txt'), 'utf8') : undefined;
    expect(here ?? server.read('kalsin.txt')).toBe('yalnız burada');
    expect(existsSync(p('a.txt'))).toBe(false);
  });

  it('keeps its state over a restart: nothing is listed as new or downloaded', async () => {
    server.put('d/a.txt', 'içerik');
    await drive.start(spaces);
    await settle();
    expect((await read(p('d', 'a.txt'))).text).toBe('içerik');
    await drive.stop();
    expect((await read(p('d', 'a.txt'))).text).toBe('içerik');

    server.calls.length = 0;
    drive = make();
    await drive.start(spaces);
    await settle();
    expect(server.calls.filter((c) => !c.startsWith('list'))).toEqual([]);
    expect(downloads).toBe(0);
    expect(statuses[0]).toMatchObject({ state: 'idle', error: null, failed: [] });
    expect(statuses[0]!.stats).toMatchObject({
      uploaded: 0,
      downloaded: 0,
      deletedLocal: 0,
      deletedRemote: 0,
    });
  });

  it('shows files as unavailable while the app is closed, then serves them again', async () => {
    server.put('a.txt', 'içerik');
    await drive.start(spaces);
    await settle();
    await drive.stop();
    expect(await readdir(p())).toEqual(['a.txt']);
    expect((await read(p('a.txt'))).code).toBe(3);

    drive = make();
    await drive.start(spaces);
    await settle();
    expect((await read(p('a.txt'))).text).toBe('içerik');
  });

  describe('warnings in Explorer', () => {
    it('warns about a file that cannot be uploaded, until it can', async () => {
      await drive.start(spaces);
      await settle();
      uploadsHeld = Promise.reject(new Error('görüntüleyici'));
      uploadsHeld.catch(() => undefined);
      await writeFile(p('yazılamaz.txt'), 'x');
      await until('the warning', () => itemStates.get(p('yazılamaz.txt')) === 'yüklenemedi');

      uploadsHeld = Promise.resolve();
      drive.syncNow();
      await until('it to go', () => !itemStates.has(p('yazılamaz.txt')));
      expect(server.find('yazılamaz.txt')).toBeTruthy();
    });

    it('warns about a file put beside the space folders', async () => {
      await drive.start(spaces);
      await settle();
      expect(itemStates.size).toBe(0);
      await writeFile(join(root, 'kök.txt'), 'x');
      drive.syncNow();
      await until('the warning', () => itemStates.get(join(root, 'kök.txt')) === 'outside_space');
      expect(itemStates.has(p())).toBe(false);

      await rm(join(root, 'kök.txt'));
      drive.syncNow();
      await until('it to go', () => itemStates.size === 0);
    });
  });

  describe('Explorer commands', () => {
    const PINNED = 1;
    const UNPINNED = 2;
    const onDisk = async (path: string) => (await cf.info(path)).onDisk;

    it('"always keep" brings the file down with nothing reading it', async () => {
      server.put('a.txt', 'içerik');
      await drive.start(spaces);
      await settle();
      expect(await onDisk(p('a.txt'))).toBe(0);

      expect(spawnSync('attrib', ['+P', p('a.txt')]).status).toBe(0);
      await until('the file to come down', async () => (await onDisk(p('a.txt'))) > 0);
      expect(reads).toEqual([server.find('a.txt')!.id]);
      expect(await cf.info(p('a.txt'))).toMatchObject({ inSync: true, pin: PINNED });
      await settle();
      expect(server.tree()).toEqual(['a.txt=içerik']);
    });

    it('a kept folder brings down what is added to it later', async () => {
      server.put('klasör/a.txt', 'bir');
      await drive.start(spaces);
      await settle();
      await cf.setPin(p('klasör'), PINNED, true);
      await until('the file', async () => (await onDisk(p('klasör', 'a.txt'))) > 0);

      server.put('klasör/yeni.txt', 'iki');
      feed.publish([row(server, 'klasör/yeni.txt', 'created')]);
      drive.notifyChange();
      await until('the new file', async () => {
        const info = await cf.info(p('klasör', 'yeni.txt')).catch(() => null);
        return !!info && info.onDisk > 0;
      });
      expect((await cf.info(p('klasör', 'yeni.txt'))).pin).toBe(PINNED);
      expect(await readFile(p('klasör', 'yeni.txt'), 'utf8')).toBe('iki');
    });

    it('a kept file takes a new version from the server and stays kept', async () => {
      server.put('a.txt', 'eski');
      await drive.start(spaces);
      await settle();
      await cf.setPin(p('a.txt'), PINNED);
      await until('the file', async () => (await onDisk(p('a.txt'))) > 0);

      server.put('a.txt', 'yepyeni içerik');
      feed.publish([row(server, 'a.txt', 'updated')]);
      drive.notifyChange();
      const size = Buffer.byteLength('yepyeni içerik');
      await until('the new version', async () => (await onDisk(p('a.txt'))) === size);
      expect(await readFile(p('a.txt'), 'utf8')).toBe('yepyeni içerik');
      expect(await cf.info(p('a.txt'))).toMatchObject({ pin: PINNED, inSync: true });
      await settle();
      expect(statuses[0]).toMatchObject({ failed: [] });
    });

    it('"free up space" drops the bytes; the next read brings them back', async () => {
      server.put('a.txt', 'içerik');
      await drive.start(spaces);
      await settle();
      expect((await read(p('a.txt'))).text).toBe('içerik');
      await settle();
      const before = await stat(p('a.txt'));
      expect(before.size).toBe(Buffer.byteLength('içerik'));

      expect(spawnSync('attrib', ['+U', p('a.txt')]).status).toBe(0);
      await until('the bytes to go', async () => (await onDisk(p('a.txt'))) === 0);
      expect((await stat(p('a.txt'))).mtimeMs).toBe(before.mtimeMs);
      expect((await cf.info(p('a.txt'))).inSync).toBe(true);
      await settle();
      expect(server.tree()).toEqual(['a.txt=içerik']);

      // Reading clears the mark, or the file would go again as soon as it came down.
      expect((await read(p('a.txt'))).text).toBe('içerik');
      await settle(400);
      expect(await cf.info(p('a.txt'))).toMatchObject({ pin: 0 });
      expect(await onDisk(p('a.txt'))).toBeGreaterThan(0);
    });

    it('never frees a change the server does not have, even one Windows does not notice', async () => {
      server.put('a.txt', 'içerik');
      await drive.start(spaces);
      await settle();
      expect((await read(p('a.txt'))).text).toBe('içerik');
      await settle();
      let release = () => {};
      uploadsHeld = new Promise((r) => (release = r));

      // Writing at the end of a file leaves its in-sync mark on.
      await appendFile(p('a.txt'), ' ve ek');
      expect((await cf.info(p('a.txt'))).inSync).toBe(true);
      await cf.setPin(p('a.txt'), UNPINNED);
      await new Promise((r) => setTimeout(r, 400));
      expect(await readFile(p('a.txt'), 'utf8')).toBe('içerik ve ek');

      // Once it is uploaded there is nothing left to lose.
      release();
      uploadsHeld = Promise.resolve();
      await until('the upload', () => server.find('a.txt')!.content.toString() === 'içerik ve ek');
      await until('the bytes to go', async () => (await onDisk(p('a.txt'))) === 0);
      expect((await read(p('a.txt'))).text).toBe('içerik ve ek');
    });

    it('does what was asked while the app was closed', async () => {
      server.put('kalsın.txt', 'bir');
      server.put('gitsin.txt', 'iki');
      await drive.start(spaces);
      await settle();
      expect((await read(p('gitsin.txt'))).text).toBe('iki');
      await settle();
      await drive.stop();

      await cf.setPin(p('kalsın.txt'), PINNED);
      await cf.setPin(p('gitsin.txt'), UNPINNED);
      drive = make();
      await drive.start(spaces);
      await until('both', async () => {
        return (await onDisk(p('kalsın.txt'))) > 0 && (await onDisk(p('gitsin.txt'))) === 0;
      });
    });

    it('a kept file can still be deleted, and the server hears of it', async () => {
      server.put('a.txt', 'içerik');
      await drive.start(spaces);
      await settle();
      await cf.setPin(p('a.txt'), PINNED);
      await until('the file', async () => (await onDisk(p('a.txt'))) > 0);
      await rm(p('a.txt'));
      await until('the delete', () => !server.find('a.txt'));
    });
  });

  it('comes off the computer leaving only what the server does not have', async () => {
    server.put('d/a.txt', 'sunucuda var');
    await drive.start(spaces);
    await settle();
    expect((await read(p('d', 'a.txt'))).text).toBe('sunucuda var');
    await drive.stop();
    await writeFile(p('yalniz-burada.txt'), 'yüklenmedi');

    await drive.remove();
    expect(await readdir(root)).toEqual(['Ekip']);
    expect(await readdir(p())).toEqual(['yalniz-burada.txt']);
    expect(await readFile(p('yalniz-burada.txt'), 'utf8')).toBe('yüklenmedi');
    expect(existsSync(stateDir)).toBe(false);
    await expect(cf.connect(root, () => undefined)).rejects.toMatchObject({
      hresult: expect.stringMatching(/^0x8/) as string,
    });
    expect(server.tree()).toEqual(['d/', 'd/a.txt=sunucuda var']);
  });
});
