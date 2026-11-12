// Another provider's placeholders in an ordinary sync pair: never fetched, never taken for deleted.
// "Another provider" is the real Cloud Files API under a dev name, in a temp folder.
import { spawn } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadCloudFiles, type CloudFetchEvent } from '../src/cloud/native';
import { isOnlineOnly } from '../src/sync/local';
import { runPass, type PassResult } from '../src/sync/pass';
import type { BaseEntry } from '../src/sync/types';
import { FakeDrive } from './fake-drive';

describe('isOnlineOnly', () => {
  it.each([
    ['an ordinary file', 0x20, false],
    ['a folder', 0x10, false],
    ['a downloaded placeholder', 0x20 | 0x400, false],
    ['offline', 0x1000, true],
    ['recalled on open', 0x40000, true],
    ['recalled on data access', 0x400000, true],
    ['OneDrive, freed up', 0x20 | 0x400 | 0x1000 | 0x400000, true],
  ])('%s', (_name, attributes, expected) => {
    expect(isOnlineOnly(attributes)).toBe(expected);
  });
});

const native = loadCloudFiles(
  join(import.meta.dirname, '../native/cloudfiles/build/Release/cloudfiles.node'),
);

describe.skipIf(!native)('another provider in a sync pair', () => {
  const cf = native!;
  const options = { provider: 'CrewhallDevTest', account: 'foreign' };
  let dir: string;
  let root: string;
  let key: string;
  let drive: FakeDrive;
  let base: Map<string, BaseEntry>;
  let fetches: CloudFetchEvent[];
  let contents: Map<string, Buffer>;

  const pass = async (
    extra: { attributes?: (abs: string) => Promise<number> } = {
      attributes: (abs) => cf.attributes(abs),
    },
  ): Promise<PassResult> => {
    const result = await runPass({
      root,
      spaceId: drive.spaceId,
      folderId: null,
      drive,
      base,
      platform: 'win32',
      device: 'LAPTOP',
      conflictLabel: 'çakışan kopya',
      trash: (abs) => rm(abs, { recursive: true, force: true }),
      ...extra,
    });
    base = result.base;
    expect(result.errors).toEqual([]);
    return result;
  };

  const place = async (name: string, content: string, parent = root): Promise<string> => {
    const path = join(parent, name);
    contents.set(path, Buffer.from(content));
    expect(
      await cf.createPlaceholders(parent, [
        { name, identity: name, size: Buffer.byteLength(content), mtimeMs: Date.now() },
      ]),
    ).toEqual(['0x00000000']);
    return path;
  };

  /** Brings it down as a program reading it would: the "provider" answers. */
  const download = (path: string): Promise<void> =>
    new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        ['-e', "require('fs').readFileSync(process.argv[1])", path],
        { windowsHide: true },
      );
      child.on('close', () => resolve());
    });

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'crewhall-cf-foreign-')));
    root = join(dir, 'Eşitlenen');
    await mkdir(root);
    drive = new FakeDrive();
    base = new Map();
    fetches = [];
    contents = new Map();
    await cf.registerRoot({ root, ...options, version: '1.0' });
    key = await cf.connect(root, (e) => {
      if (e.type !== 'fetch') return;
      fetches.push(e);
      const content = contents.get(e.path);
      if (content) void cf.transfer(key, e.transferKey, content, 0, content.length);
    });
  });

  afterEach(async () => {
    await cf.disconnect(key);
    await cf.unregisterRoot({ root, ...options });
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('reads the marks of a file without bringing it down', async () => {
    const path = await place('bulutta.txt', 'içerik');
    expect(isOnlineOnly(await cf.attributes(path))).toBe(true);
    expect(fetches).toEqual([]);
    await download(path);
    expect(isOnlineOnly(await cf.attributes(path))).toBe(false);
    const plain = join(root, 'sade.txt');
    await writeFile(plain, 'x');
    expect(isOnlineOnly(await cf.attributes(plain))).toBe(false);
    await expect(cf.attributes(join(root, 'yok.txt'))).rejects.toMatchObject({
      hresult: '0x80070002',
    });
  });

  it('skips an online-only file: nothing comes down, nothing goes up, and it says why', async () => {
    const path = await place('bulutta.txt', 'bulutun içeriği');
    await writeFile(join(root, 'burada.txt'), 'burada');
    const result = await pass();
    expect(result.skipped).toEqual([{ path: 'bulutta.txt', side: 'local', reason: 'online_only' }]);
    expect(fetches).toEqual([]);
    expect((await cf.info(path)).onDisk).toBe(0);
    expect(drive.tree()).toEqual(['burada.txt=burada']);
  });

  it('looks inside a folder and skips what is online-only there', async () => {
    const folder = join(root, 'Klasör');
    await mkdir(folder);
    await place('derin.txt', 'içerik', folder);
    await writeFile(join(folder, 'sade.txt'), 'sade');
    const result = await pass();
    expect(result.skipped.map((s) => s.path)).toEqual(['Klasör/derin.txt']);
    expect(drive.tree()).toEqual(['Klasör/', 'Klasör/sade.txt=sade']);
    expect(fetches).toEqual([]);
  });

  it('syncs a file once it has been brought down here', async () => {
    const path = await place('indirilmis.txt', 'indirilmiş içerik');
    await download(path);
    fetches = [];
    expect((await pass()).skipped).toEqual([]);
    expect(drive.tree()).toEqual(['indirilmis.txt=indirilmiş içerik']);
  });

  it('does not take a file freed up by the provider for deleted', async () => {
    const path = await place('a.txt', 'kalsın');
    await download(path);
    await pass();
    expect(drive.tree()).toEqual(['a.txt=kalsın']);

    await cf.dehydrate(path);
    fetches = [];
    drive.calls.length = 0;
    const result = await pass();
    expect(result.stats).toMatchObject({ deletedRemote: 0, deletedLocal: 0, uploaded: 0 });
    expect(result.skipped.map((s) => s.reason)).toEqual(['online_only']);
    expect(drive.tree()).toEqual(['a.txt=kalsın']);
    expect(drive.calls.filter((c) => !c.startsWith('list'))).toEqual([]);
    expect(fetches).toEqual([]);
  });

  it('leaves a freed-up file alone when the server has a new version, then takes it up again', async () => {
    const path = await place('a.txt', 'ilk');
    await download(path);
    await pass();
    await cf.dehydrate(path);
    fetches = [];
    drive.put('a.txt', 'sunucudan yeni içerik');
    const result = await pass();
    expect(result.stats).toMatchObject({ downloaded: 0, conflicts: 0 });
    expect((await cf.info(path)).placeholder).toBe(true);
    expect(fetches).toEqual([]);

    await download(path);
    const after = await pass();
    expect(after.skipped).toEqual([]);
    expect(after.errors).toEqual([]);
  });

  it('does not put a server file over an online-only one of the same name', async () => {
    const path = await place('ayni.txt', 'bulutun');
    drive.put('ayni.txt', 'sunucunun, başka uzunlukta');
    const result = await pass();
    expect(result.stats).toMatchObject({ downloaded: 0, conflicts: 0, uploaded: 0 });
    expect((await cf.info(path)).placeholder).toBe(true);
    expect(await readdir(root)).toEqual(['ayni.txt']);
    expect(drive.read('ayni.txt')).toBe('sunucunun, başka uzunlukta');
  });

  it('without the add-on, leaves every placeholder alone', async () => {
    const online = await place('bulutta.txt', 'x');
    const here = await place('indirilmis.txt', 'y');
    await download(here);
    fetches = [];
    const result = await pass({});
    expect(result.skipped.map((s) => s.path).sort()).toEqual(['bulutta.txt', 'indirilmis.txt']);
    expect(drive.tree()).toEqual([]);
    expect((await cf.info(online)).onDisk).toBe(0);
    expect(fetches).toEqual([]);
  });

  it('when reading the marks fails, leaves it alone', async () => {
    await place('bulutta.txt', 'x');
    const result = await pass({ attributes: () => Promise.reject(new Error('denied')) });
    expect(result.skipped.map((s) => s.reason)).toEqual(['online_only']);
    expect(drive.tree()).toEqual([]);
  });

  it('still calls a real link a link', async () => {
    const target = join(dir, 'hedef');
    await mkdir(target);
    await writeFile(join(target, 'gizli.txt'), 'x');
    await symlink(target, join(root, 'baglanti'), 'junction');
    const result = await pass();
    expect(result.skipped).toEqual([{ path: 'baglanti', side: 'local', reason: 'symlink' }]);
    expect(drive.tree()).toEqual([]);
    expect(await readFile(join(target, 'gizli.txt'), 'utf8')).toBe('x');
  });
});
