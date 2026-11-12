import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetDesktopCache } from '../src/services/desktop/releases';
import { Client, createTestApp, type TestApp } from './helpers';

const FEED_WIN = `version: 0.3.0
files:
  - url: Crewhall-Setup-0.3.0.exe
    sha512: abc
    size: 300
path: Crewhall-Setup-0.3.0.exe
sha512: abc
releaseDate: '2026-10-23T08:00:00.000Z'
`;

/** 300 bytes, each its own index mod 256: a range is easy to check. */
const INSTALLER = Buffer.from(Array.from({ length: 300 }, (_, i) => i % 256));

/**
 * Releases uploaded by hand to the S3 bucket (`desktop-updates/<platform>/`), behind an empty
 * DESKTOP_UPDATES_DIR the way the image sets it.
 */
describe('desktop updates from S3', { timeout: 120_000 }, () => {
  let app: TestApp;
  let dir: string;

  const get = (path: string, headers: Record<string, string> = {}, method = 'GET') =>
    app.app.request(`http://localhost:3000/api/v1/desktop/updates/${path}`, {
      method,
      headers: { 'x-forwarded-for': '198.51.100.9', ...headers },
    });

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'crewhall-desktop-empty-'));
    app = await createTestApp({ DESKTOP_UPDATES_DIR: dir });
    const storage = app.deps.storage!;
    await storage.ensureBucket();
    await storage.put('desktop-updates/win/latest.yml', Buffer.from(FEED_WIN), 'text/yaml');
    await storage.put(
      'desktop-updates/win/Crewhall-Setup-0.3.0.exe',
      INSTALLER,
      'application/octet-stream',
    );
    resetDesktopCache();
  });
  afterAll(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('serves the feed and the whole installer', async () => {
    const feed = await get('win/latest.yml');
    expect(feed.status).toBe(200);
    expect(feed.headers.get('cache-control')).toBe('no-cache');
    expect(await feed.text()).toBe(FEED_WIN);

    const file = await get('win/Crewhall-Setup-0.3.0.exe');
    expect(file.status).toBe(200);
    expect(file.headers.get('accept-ranges')).toBe('bytes');
    expect(file.headers.get('content-length')).toBe('300');
    expect(file.headers.get('etag')).toBeTruthy();
    expect(Buffer.from(await file.arrayBuffer())).toEqual(INSTALLER);
  });

  it('passes a byte range on to S3', async () => {
    const part = await get('win/Crewhall-Setup-0.3.0.exe', { range: 'bytes=250-259' });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe('bytes 250-259/300');
    expect(part.headers.get('content-length')).toBe('10');
    expect(Buffer.from(await part.arrayBuffer())).toEqual(INSTALLER.subarray(250, 260));

    const tail = await get('win/Crewhall-Setup-0.3.0.exe', { range: 'bytes=-5' });
    expect(tail.status).toBe(206);
    expect(Buffer.from(await tail.arrayBuffer())).toEqual(INSTALLER.subarray(295));

    const beyond = await get('win/Crewhall-Setup-0.3.0.exe', { range: 'bytes=400-' });
    expect(beyond.status).toBe(416);
    expect(beyond.headers.get('content-range')).toBe('bytes */300');
  });

  it('answers HEAD without a body', async () => {
    const head = await get('win/Crewhall-Setup-0.3.0.exe', {}, 'HEAD');
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe('300');
    expect(await head.text()).toBe('');
  });

  it('404s a missing file, a missing platform feed and names that are not plain file names', async () => {
    expect((await get('win/Crewhall-Setup-9.9.9.exe')).status).toBe(404);
    expect((await get('mac/latest-mac.yml')).status).toBe(404);
    for (const bad of ['.latest.yml', '..%2Fwin%2Flatest.yml', 'latest.yml%00', 'a%2Fb.exe']) {
      expect((await get(`win/${bad}`)).status).toBe(404);
    }
    expect((await get('linux/latest.yml')).status).toBe(404);
  });

  it('reads the server version from the feed in S3', async () => {
    resetDesktopCache();
    const boot = await new Client(app).api.call('bootstrap');
    expect(boot.desktop).toEqual({
      version: '0.3.0',
      platforms: [
        {
          platform: 'win',
          version: '0.3.0',
          url: '/api/v1/desktop/updates/win/Crewhall-Setup-0.3.0.exe',
          sizeBytes: 300,
          releasedAt: '2026-10-23T08:00:00.000Z',
        },
      ],
    });
  });

  it('still lets a folder with releases win over S3', async () => {
    await mkdir(join(dir, 'win'));
    await writeFile(join(dir, 'win', 'latest.yml'), FEED_WIN.replaceAll('0.3.0', '0.4.0'));
    expect(await (await get('win/latest.yml')).text()).toContain('version: 0.4.0');
    // A file only S3 has is still served from there.
    expect((await get('win/Crewhall-Setup-0.3.0.exe')).status).toBe(200);
    resetDesktopCache();
    expect((await new Client(app).api.call('bootstrap')).desktop?.version).toBe('0.4.0');
  });
});
