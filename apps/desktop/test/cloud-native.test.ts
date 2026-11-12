// Against the real Cloud Files API, on Windows with the add-on built (`pnpm run build:native`);
// skipped otherwise. Registers a temp folder only, which leaves nothing in the registry.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadCloudFiles, type CloudFetchEvent } from '../src/cloud/native';

const ADDON = join(import.meta.dirname, '../native/cloudfiles/build/Release/cloudfiles.node');
const native = loadCloudFiles(ADDON);
const PROVIDER = 'CrewhallDevTest';
const OK = '0x00000000';
const CHUNK = 64 * 1024;
/** STATUS_CLOUD_FILE_NETWORK_UNAVAILABLE */
const NETWORK_UNAVAILABLE = 0xc000cf11;
const WHEN = Date.UTC(2026, 0, 15, 10, 30);

/**
 * Reads from another process, the way a program would. This one has to stay free to answer: a
 * synchronous read of a file not yet here, from the process serving it, waits a minute and fails.
 */
function read(path: string): Promise<{ code: number | null; data: Buffer; error: string }> {
  const script =
    "try{process.stdout.write(require('fs').readFileSync(process.argv[1]))}" +
    'catch(e){console.error(e.code);process.exit(3)}';
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', script, path], { windowsHide: true });
    const out: Buffer[] = [];
    let error = '';
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => (error += d.toString()));
    child.on('close', (code) => resolve({ code, data: Buffer.concat(out), error: error.trim() }));
  });
}

async function until(what: string, check: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe.skipIf(!native)('Cloud Files add-on', () => {
  const cf = native!;
  let base: string;
  let root: string;
  let key: string;
  let events: CloudFetchEvent[] = [];
  let failures: unknown[] = [];
  let contents: Map<string, Buffer>;
  /** What a fetch does; serves from `contents` unless a test says otherwise. */
  let onFetch: (e: CloudFetchEvent) => Promise<void>;

  const serve = async (e: CloudFetchEvent): Promise<void> => {
    const content = contents.get(e.path);
    if (!content) throw new Error(`nothing to serve for ${e.path}`);
    const end = Math.min(e.offset + e.length, content.length);
    for (let at = e.offset; at < end; at += CHUNK) {
      const piece = content.subarray(at, Math.min(at + CHUNK, end));
      await cf.transfer(key, e.transferKey, Buffer.from(piece), at, content.length);
    }
  };

  const listener = (e: CloudFetchEvent): void => {
    events.push(e);
    if (e.type === 'fetch') onFetch(e).catch((err: unknown) => failures.push(err));
  };

  /** A placeholder in the root, with `content` waiting on the "server". */
  const place = async (name: string, content: Buffer, identity = name): Promise<string> => {
    const path = join(root, name);
    contents.set(path, content);
    const results = await cf.createPlaceholders(root, [
      { name, identity, size: content.length, mtimeMs: WHEN },
    ]);
    expect(results).toEqual([OK]);
    return path;
  };

  beforeAll(async () => {
    base = mkdtempSync(join(realpathSync.native(tmpdir()), 'crewhall-cf-'));
    root = join(base, 'Kök ğüş');
    mkdirSync(root);
    await cf.registerRoot({ root, provider: PROVIDER, account: 'test', version: '1.0' });
    key = await cf.connect(root, listener);
  });

  afterAll(async () => {
    if (key) await cf.disconnect(key).catch(() => undefined);
    await cf.unregisterRoot({ root, provider: PROVIDER, account: 'test' }).catch(() => undefined);
    // Windows may hold a file briefly after the connection ends.
    rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  beforeEach(() => {
    events = [];
    failures = [];
    contents = new Map();
    onFetch = serve;
  });

  afterEach(() => {
    expect(failures).toEqual([]);
  });

  it('shows a file without downloading it', async () => {
    const path = await place('liste.txt', randomBytes(5000), 'node-1');
    const stat = statSync(path);
    expect(readdirSync(root)).toContain('liste.txt');
    expect(stat.size).toBe(5000);
    expect(stat.mtimeMs).toBe(WHEN);
    expect(await cf.info(path)).toMatchObject({
      placeholder: true,
      inSync: true,
      identity: 'node-1',
      size: 5000,
      onDisk: 0,
    });
    expect(events).toEqual([]);
  });

  it('downloads on read, in pieces, and tells who asked', async () => {
    const content = randomBytes(1024 * 1024 + 123);
    const path = await place('büyük.bin', content, 'node-2');
    const result = await read(path);
    expect(result.code).toBe(0);
    expect(result.data.equals(content)).toBe(true);
    const fetch = events.find((e) => e.type === 'fetch');
    expect(fetch).toMatchObject({ path, identity: 'node-2', fileSize: content.length });
    expect(fetch!.process.toLowerCase()).toContain('node');
    expect((await cf.info(path)).onDisk).toBeGreaterThanOrEqual(content.length);
  });

  it('asks for a whole file once, then has it', async () => {
    const content = randomBytes(300_000);
    const path = await place('tek.bin', content);
    await read(path);
    const asked = events.filter((e) => e.type === 'fetch');
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ offset: 0, length: content.length });
    events = [];
    expect((await read(path)).data.equals(content)).toBe(true);
    expect(events).toEqual([]);
  });

  it('keeps the file id and the dates through a download and a dehydrate', async () => {
    const content = randomBytes(10_000);
    const path = await place('kimlik.bin', content);
    const ids = (): [bigint, bigint, bigint] => {
      const s = statSync(path, { bigint: true });
      return [s.ino, s.birthtimeMs, s.mtimeMs];
    };
    const before = ids();
    await read(path);
    expect(ids()).toEqual(before);
    await cf.dehydrate(path);
    expect(ids()).toEqual(before);
  });

  it('gives the program a read error when the download fails', async () => {
    const path = await place('hata.bin', randomBytes(8192));
    onFetch = (e) => cf.transferFail(key, e.transferKey, e.offset, e.length, NETWORK_UNAVAILABLE);
    const result = await read(path);
    expect(result.code).toBe(3);
    expect(result.error).not.toBe('');
    expect((await cf.info(path)).onDisk).toBe(0);
  });

  // Windows does not cancel when the program dies: a cancel only comes about a minute later, once
  // another program waits for the same file, so a download cannot count on hearing about it.
  it('finishes the download though the program reading it was closed', async () => {
    const content = randomBytes(2 * 1024 * 1024);
    const path = await place('kapandi.bin', content);
    const half = content.length / 2;
    let halfSent = false;
    let rest: CloudFetchEvent | undefined;
    onFetch = async (e) => {
      await cf.transfer(key, e.transferKey, content.subarray(0, half), 0, content.length);
      halfSent = true;
      rest = e;
    };
    const child = spawn(
      process.execPath,
      ['-e', `require('fs').readFileSync(${JSON.stringify(path)})`],
      { windowsHide: true },
    );
    const closed = new Promise((resolve) => child.on('close', resolve));
    await until('the first half', () => halfSent);
    child.kill();
    await closed;
    expect((await cf.info(path)).onDisk).toBe(half);
    await cf.transfer(key, rest!.transferKey, content.subarray(half), half, content.length);
    expect((await cf.info(path)).onDisk).toBe(content.length);
    events = [];
    expect((await read(path)).data.equals(content)).toBe(true);
    expect(events).toEqual([]);
  });

  it('frees the space and downloads again on the next read', async () => {
    const content = randomBytes(40_000);
    const path = await place('bosalt.bin', content);
    await read(path);
    expect((await cf.info(path)).onDisk).toBeGreaterThan(0);
    await cf.dehydrate(path);
    const info = await cf.info(path);
    expect(info).toMatchObject({ placeholder: true, onDisk: 0, size: content.length });
    events = [];
    expect((await read(path)).data.equals(content)).toBe(true);
    expect(events.filter((e) => e.type === 'fetch')).toHaveLength(1);
  });

  it('takes a new version from the server: the next read gets it', async () => {
    const path = await place('surum.bin', randomBytes(20_000), 'v1');
    await read(path);
    const next = randomBytes(33_333);
    contents.set(path, next);
    const later = WHEN + 86_400_000;
    await cf.updatePlaceholder(path, {
      identity: 'v2',
      size: next.length,
      mtimeMs: later,
      dehydrate: true,
    });
    expect(statSync(path).size).toBe(next.length);
    expect(statSync(path).mtimeMs).toBe(later);
    expect(await cf.info(path)).toMatchObject({ identity: 'v2', onDisk: 0, inSync: true });
    expect((await read(path)).data.equals(next)).toBe(true);
    expect(events.filter((e) => e.type === 'fetch').at(-1)).toMatchObject({ identity: 'v2' });
  });

  it('keeps the size when only the date changes', async () => {
    const content = randomBytes(12_345);
    const path = await place('tarih.bin', content);
    const later = WHEN + 1000;
    await cf.updatePlaceholder(path, { mtimeMs: later });
    expect(statSync(path).size).toBe(content.length);
    expect(statSync(path).mtimeMs).toBe(later);
    expect((await read(path)).data.equals(content)).toBe(true);
  });

  it('makes a file created here one of ours without touching its bytes', async () => {
    const path = join(root, 'yeni.txt');
    writeFileSync(path, 'burada yazıldı');
    expect(await cf.info(path)).toMatchObject({ placeholder: false, identity: '' });
    await cf.convertToPlaceholder(path, 'node-yeni');
    expect(await cf.info(path)).toMatchObject({
      placeholder: true,
      inSync: true,
      identity: 'node-yeni',
    });
    expect(readFileSync(path, 'utf8')).toBe('burada yazıldı');
    expect(events).toEqual([]);
  });

  // What the local side has to expect: Windows does not call the provider for an edit.
  describe('a file edited here', () => {
    it('saved over the old one stops being a placeholder but keeps its file id', async () => {
      const path = await place('uzerine.txt', Buffer.from('eski'));
      await read(path);
      const before = statSync(path, { bigint: true });
      events = [];
      writeFileSync(path, 'yeni içerik');
      const after = statSync(path, { bigint: true });
      expect(await cf.info(path)).toMatchObject({ placeholder: false, identity: '' });
      expect(after.ino).toBe(before.ino);
      expect(after.birthtimeMs).toBe(before.birthtimeMs);
      expect(after.mtimeMs).not.toBe(before.mtimeMs);
      expect(events).toEqual([]);
      // Converting it again is what follows the upload.
      await cf.convertToPlaceholder(path, 'node-sonra');
      expect(await cf.info(path)).toMatchObject({ placeholder: true, identity: 'node-sonra' });
      expect(readFileSync(path, 'utf8')).toBe('yeni içerik');
    });

    it('saved over a file never downloaded gets no download first', async () => {
      const path = await place('inmeden.txt', randomBytes(50_000));
      events = [];
      writeFileSync(path, 'kısa');
      expect(events).toEqual([]);
      expect(readFileSync(path, 'utf8')).toBe('kısa');
    });

    it('changed in place stays a placeholder and is no longer in sync', async () => {
      const path = await place('yerinde.txt', Buffer.from('eski içerik'));
      await read(path);
      const fd = openSync(path, 'r+');
      writeSync(fd, 'YENİ');
      closeSync(fd);
      expect(await cf.info(path)).toMatchObject({ placeholder: true, inSync: false });
      expect(statSync(path).mtimeMs).not.toBe(WHEN);
      await expect(
        cf.updatePlaceholder(path, { dehydrate: true, verifyInSync: true }),
      ).rejects.toMatchObject({ hresult: expect.stringMatching(/^0x8/) as string });
      expect(readFileSync(path, 'utf8')).toMatch(/^YENİ/);
      await cf.updatePlaceholder(path, {});
      expect(await cf.info(path)).toMatchObject({ placeholder: true, inSync: true });
    });
  });

  it('a file grown in place reads as its old size once freed, until it is told the new one', async () => {
    const path = join(root, 'büyüyen.txt');
    const placed = Buffer.from('eski');
    contents.set(path, placed);
    expect(
      await cf.createPlaceholders(root, [
        { name: 'büyüyen.txt', identity: 'n', size: placed.length, mtimeMs: WHEN },
      ]),
    ).toEqual([OK]);
    expect((await read(path)).data.toString()).toBe('eski');

    writeFileSync(path, ' ve yeni', { flag: 'a' });
    expect(statSync(path).size).toBe(12);
    const longer = Buffer.from('eski ve yeni');
    contents.set(path, longer);

    await cf.updatePlaceholder(path, { size: longer.length });
    await cf.dehydrate(path);
    events = [];
    expect((await read(path)).data.toString()).toBe('eski ve yeni');
    expect(events.filter((e) => e.type === 'fetch')[0]).toMatchObject({ fileSize: longer.length });
  });

  it('marks to stay or go change nothing by themselves, and Windows clears "go" on a read', async () => {
    const path = join(root, 'işaret.txt');
    const content = randomBytes(CHUNK);
    contents.set(path, content);
    await cf.createPlaceholders(root, [
      { name: 'işaret.txt', identity: 'n', size: content.length, mtimeMs: WHEN },
    ]);
    events = [];
    await cf.setPin(path, 1);
    await new Promise((r) => setTimeout(r, 200));
    expect(await cf.info(path)).toMatchObject({ pin: 1, onDisk: 0 });
    expect(events).toEqual([]);

    await cf.hydrate(path);
    expect((await cf.info(path)).onDisk).toBeGreaterThan(0);
    await expect(cf.dehydrate(path)).rejects.toMatchObject({ hresult: '0x80070188' });
    await expect(cf.updatePlaceholder(path, { dehydrate: true })).rejects.toMatchObject({
      hresult: '0x80070188',
    });

    await cf.setPin(path, 2);
    expect((await cf.info(path)).onDisk).toBeGreaterThan(0);
    await cf.dehydrate(path);
    expect(await cf.info(path)).toMatchObject({ pin: 2, onDisk: 0 });
    expect((await read(path)).data.equals(content)).toBe(true);
    expect(await cf.info(path)).toMatchObject({ pin: 0 });
    expect((await cf.info(path)).onDisk).toBeGreaterThan(0);
  });

  it('a new size or date leaves the marks alone', async () => {
    const path = join(root, 'işaretli.txt');
    await cf.createPlaceholders(root, [
      { name: 'işaretli.txt', identity: 'n', size: 5, mtimeMs: WHEN },
    ]);
    await cf.setPin(path, 1);
    await cf.updatePlaceholder(path, { size: 7, mtimeMs: WHEN + 1000 });
    expect(await cf.info(path)).toMatchObject({ pin: 1, size: 7 });
    expect(statSync(path).mtimeMs).toBe(WHEN + 1000);
  });

  it('a new size alone leaves the date', async () => {
    const path = join(root, 'tarihli.txt');
    await cf.createPlaceholders(root, [
      { name: 'tarihli.txt', identity: 'n', size: 5, mtimeMs: WHEN },
    ]);
    await cf.updatePlaceholder(path, { size: 7 });
    expect(statSync(path).mtimeMs).toBe(WHEN);
  });

  it('a folder passes "stay" on to what is created in it', async () => {
    await cf.createPlaceholders(root, [
      { name: 'Tut', identity: 'd', folder: true, mtimeMs: WHEN },
    ]);
    const folder = join(root, 'Tut');
    await cf.setPin(folder, 1, true);
    await cf.createPlaceholders(folder, [
      { name: 'yeni.txt', identity: 'n', size: 5, mtimeMs: WHEN },
    ]);
    expect((await cf.info(join(folder, 'yeni.txt'))).pin).toBe(1);
  });

  it('hydrating a file whose download fails rejects, and the file stays as it was', async () => {
    const path = join(root, 'yok.txt');
    await cf.createPlaceholders(root, [{ name: 'yok.txt', identity: 'n', size: 5, mtimeMs: WHEN }]);
    onFetch = (e) => cf.transferFail(key, e.transferKey, e.offset, e.length, NETWORK_UNAVAILABLE);
    await expect(cf.hydrate(path)).rejects.toMatchObject({ hresult: '0x80070184' });
    expect((await cf.info(path)).onDisk).toBe(0);
  });

  it('creates folders and what goes inside them', async () => {
    expect(
      await cf.createPlaceholders(root, [
        { name: 'Klasör', identity: 'd1', folder: true, mtimeMs: WHEN },
      ]),
    ).toEqual([OK]);
    const folder = join(root, 'Klasör');
    const content = randomBytes(100);
    contents.set(join(folder, 'iç.txt'), content);
    expect(
      await cf.createPlaceholders(folder, [
        { name: 'iç.txt', identity: 'f1', size: 100, mtimeMs: WHEN },
      ]),
    ).toEqual([OK]);
    expect(statSync(folder).isDirectory()).toBe(true);
    expect(await cf.info(folder)).toMatchObject({ placeholder: true, identity: 'd1' });
    expect((await read(join(folder, 'iç.txt'))).data.equals(content)).toBe(true);
  });

  it('reports each item on its own when one of many fails', async () => {
    await place('var.txt', Buffer.from('x'));
    const results = await cf.createPlaceholders(root, [
      { name: 'ilk.txt', identity: 'a', size: 1, mtimeMs: WHEN },
      { name: 'var.txt', identity: 'b', size: 1, mtimeMs: WHEN },
      { name: 'son.txt', identity: 'c', size: 1, mtimeMs: WHEN },
    ]);
    expect(results).toHaveLength(3);
    expect(results[0]).toBe(OK);
    expect(results[1]).not.toBe(OK);
    expect(results[2]).toBe(OK);
    expect(await cf.info(join(root, 'var.txt'))).toMatchObject({ identity: 'var.txt' });
  });

  it('gives every item the code when the folder is wrong', async () => {
    const results = await cf.createPlaceholders(join(root, 'yok'), [
      { name: 'a.txt', identity: 'a', size: 1 },
      { name: 'b.txt', identity: 'b', size: 1 },
    ]);
    expect(results).toHaveLength(2);
    expect(results[0]).not.toBe(OK);
    expect(results[1]).toBe(results[0]);
  });

  it('accepts an empty list', async () => {
    expect(await cf.createPlaceholders(root, [])).toEqual([]);
  });

  it('rejects with the Windows code', async () => {
    await expect(cf.info(join(root, 'olmayan.txt'))).rejects.toMatchObject({
      hresult: '0x80070002',
    });
    const plain = join(base, 'kok-disi');
    mkdirSync(plain);
    await expect(cf.connect(plain, () => undefined)).rejects.toMatchObject({
      hresult: expect.stringMatching(/^0x8/) as string,
    });
  });

  it('with the app closed: names and downloaded files stay, a new read fails', async () => {
    const kept = randomBytes(3000);
    const had = await place('inmis.bin', kept);
    await read(had);
    const missing = await place('inmemis.bin', randomBytes(3000));
    await cf.disconnect(key);
    key = '';
    try {
      expect(readdirSync(root)).toContain('inmemis.bin');
      expect((await read(had)).data.equals(kept)).toBe(true);
      expect((await read(missing)).code).toBe(3);
    } finally {
      key = await cf.connect(root, listener);
    }
    expect((await read(missing)).code).toBe(0);
  });

  it('leaves nothing in the registry', () => {
    for (const hive of [
      'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\SyncRootManager',
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Desktop\\NameSpace',
      'HKCU\\Software\\Classes\\CLSID',
    ]) {
      const { stdout } = spawnSync('reg', ['query', hive, '/s', '/f', PROVIDER], {
        encoding: 'utf8',
        windowsHide: true,
      });
      expect(stdout).not.toContain(PROVIDER + '!');
      expect(stdout).not.toContain(`${PROVIDER} `);
    }
  });
});

describe('loadCloudFiles', () => {
  it('is null on another OS, for a missing file and for a file that is no add-on', () => {
    expect(loadCloudFiles(ADDON, 'darwin')).toBeNull();
    expect(loadCloudFiles(join(tmpdir(), 'crewhall-yok.node'), 'win32')).toBeNull();
    const dir = mkdtempSync(join(tmpdir(), 'crewhall-cf-bad-'));
    const bad = join(dir, 'bozuk.node');
    writeFileSync(bad, 'not a library');
    try {
      expect(loadCloudFiles(bad, 'win32')).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is null in this process when nothing was packaged next to it', () => {
    expect(loadCloudFiles(undefined, 'win32')).toBeNull();
  });
});
