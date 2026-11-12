import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  compareVersions,
  parseFeed,
  parseRange,
  resetDesktopCache,
} from '../src/services/desktop/releases';
import { Client, createTestApp, setupWithOwner, type TestApp } from './helpers';

const FEED_WIN = `version: 0.2.0
files:
  - url: Crewhall-Setup-0.2.0.exe
    sha512: abc
    size: 26
path: Crewhall-Setup-0.2.0.exe
sha512: abc
releaseDate: '2026-10-22T08:00:00.000Z'
`;

const FEED_MAC = `version: 0.2.1
files:
  - url: Crewhall-0.2.1-mac.zip
    sha512: def
    size: 10
  - url: Crewhall-0.2.1-mac.dmg
    sha512: ghi
    size: 12
path: Crewhall-0.2.1-mac.zip
sha512: def
releaseDate: '2026-10-22T09:00:00.000Z'
`;

const INSTALLER = 'abcdefghijklmnopqrstuvwxyz';

describe('desktop update feed', { timeout: 120_000 }, () => {
  let app: TestApp;
  let dir: string;

  const get = (path: string, headers: Record<string, string> = {}, method = 'GET') =>
    app.app.request(`http://localhost:3000/api/v1/desktop/updates/${path}`, {
      method,
      headers: { 'x-forwarded-for': '198.51.100.7', ...headers },
    });

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'crewhall-desktop-'));
    await mkdir(join(dir, 'win'));
    await mkdir(join(dir, 'mac'));
    await writeFile(join(dir, 'win', 'latest.yml'), FEED_WIN);
    await writeFile(join(dir, 'win', 'Crewhall-Setup-0.2.0.exe'), INSTALLER);
    await writeFile(join(dir, 'mac', 'latest-mac.yml'), FEED_MAC);
    app = await createTestApp({ DESKTOP_UPDATES_DIR: dir });
    resetDesktopCache();
  });
  afterAll(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('serves the feed fresh and the installer whole', async () => {
    const feed = await get('win/latest.yml');
    expect(feed.status).toBe(200);
    expect(feed.headers.get('cache-control')).toBe('no-cache');
    expect(await feed.text()).toBe(FEED_WIN);

    const file = await get('win/Crewhall-Setup-0.2.0.exe');
    expect(file.status).toBe(200);
    expect(file.headers.get('accept-ranges')).toBe('bytes');
    expect(file.headers.get('content-length')).toBe('26');
    expect(file.headers.get('content-disposition')).toContain('Crewhall-Setup-0.2.0.exe');
    expect(await file.text()).toBe(INSTALLER);

    const head = await get('win/Crewhall-Setup-0.2.0.exe', {}, 'HEAD');
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe('26');
  });

  it('answers byte ranges for differential updates', async () => {
    const part = await get('win/Crewhall-Setup-0.2.0.exe', { range: 'bytes=2-5' });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe('bytes 2-5/26');
    expect(part.headers.get('content-length')).toBe('4');
    expect(await part.text()).toBe('cdef');

    const tail = await get('win/Crewhall-Setup-0.2.0.exe', { range: 'bytes=-3' });
    expect(await tail.text()).toBe('xyz');

    const outside = await get('win/Crewhall-Setup-0.2.0.exe', { range: 'bytes=40-' });
    expect(outside.status).toBe(416);
    expect(outside.headers.get('content-range')).toBe('bytes */26');

    // Several ranges at once: the whole file (allowed by the RFC).
    const many = await get('win/Crewhall-Setup-0.2.0.exe', { range: 'bytes=0-1,4-5' });
    expect(many.status).toBe(200);
  });

  it('answers 404 for anything that is not a release file', async () => {
    expect((await get('linux/latest.yml')).status).toBe(404);
    expect((await get('win/missing.exe')).status).toBe(404);
    expect((await get('win/..%2F..%2Fpackage.json')).status).toBe(404);
    expect((await get('mac/Crewhall-0.2.1-mac.zip')).status).toBe(404);
  });

  it('lists the releases in the public bootstrap', async () => {
    await setupWithOwner(app);
    const boot = await new Client(app).api.call('bootstrap');
    expect(boot.desktop).toEqual({
      version: '0.2.1',
      platforms: [
        {
          platform: 'win',
          version: '0.2.0',
          url: '/api/v1/desktop/updates/win/Crewhall-Setup-0.2.0.exe',
          sizeBytes: 26,
          releasedAt: '2026-10-22T08:00:00.000Z',
        },
        {
          platform: 'mac',
          version: '0.2.1',
          url: '/api/v1/desktop/updates/mac/Crewhall-0.2.1-mac.dmg',
          sizeBytes: 12,
          releasedAt: '2026-10-22T09:00:00.000Z',
        },
      ],
    });
  });

  it('limits full downloads per address', async () => {
    let limited: Response | null = null;
    for (let i = 0; i < 70 && !limited; i++) {
      const res = await app.app.request(
        'http://localhost:3000/api/v1/desktop/updates/win/latest.yml',
        {
          headers: { 'x-forwarded-for': '203.0.113.9' },
        },
      );
      if (res.status === 429) limited = res;
    }
    expect(limited?.headers.get('retry-after')).toBeTruthy();
  });
});

describe('desktop update feed without releases', { timeout: 120_000 }, () => {
  let app: TestApp;
  beforeAll(async () => {
    app = await createTestApp({ DESKTOP_UPDATES_DIR: join(tmpdir(), 'crewhall-no-such-dir') });
    resetDesktopCache();
  });
  afterAll(() => app.close());

  it('answers 404 and leaves the bootstrap without desktop', async () => {
    const res = await app.app.request(
      'http://localhost:3000/api/v1/desktop/updates/win/latest.yml',
    );
    expect(res.status).toBe(404);
    await setupWithOwner(app);
    expect((await new Client(app).api.call('bootstrap')).desktop).toBeUndefined();
  });
});

describe('desktop release helpers', () => {
  it('reads the keys of latest.yml', () => {
    expect(parseFeed(FEED_MAC)).toEqual({
      version: '0.2.1',
      path: 'Crewhall-0.2.1-mac.zip',
      releaseDate: '2026-10-22T09:00:00.000Z',
      files: [
        { url: 'Crewhall-0.2.1-mac.zip', size: 10, sha512: 'def' },
        { url: 'Crewhall-0.2.1-mac.dmg', size: 12, sha512: 'ghi' },
      ],
    });
  });

  it('parses one range and refuses impossible ones', () => {
    expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=95-200', 100)).toEqual({ start: 95, end: 99 });
    expect(parseRange('bytes=100-', 100)).toBe('unsatisfiable');
    expect(parseRange('bytes=5-2', 100)).toBe('unsatisfiable');
    expect(parseRange('items=0-1', 100)).toBeNull();
    expect(parseRange(undefined, 100)).toBeNull();
  });

  it('orders versions numerically', () => {
    expect(compareVersions('0.10.0', '0.9.3')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0-beta.1', '1.0.0')).toBeLessThan(0);
    expect(compareVersions('v1.2.0', '1.2.0')).toBe(0);
  });
});
