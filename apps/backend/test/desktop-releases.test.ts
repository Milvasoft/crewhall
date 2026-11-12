import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLogs } from '@crewhall/db';
import { DESKTOP_UPLOAD_PART_BYTES } from '@crewhall/shared';
import { fileKind, versionOf } from '../src/services/desktop/admin';
import { parseFeed, resetDesktopCache } from '../src/services/desktop/releases';
import { Client, createTestApp, join, setupWithOwner, type TestApp } from './helpers';

/** Yönetim › Masaüstü sürümleri against the tests' SeaweedFS. */
describe('desktop release management', { timeout: 180_000 }, () => {
  let app: TestApp;
  let owner: Client;
  let member: Client;

  const bytes = (seed: number, size = 4096) =>
    Buffer.from(Array.from({ length: size }, (_, i) => (i * seed) % 251));
  const sha = (b: Buffer) => createHash('sha512').update(b).digest('base64');

  /** Uploads in parts the way the browser does: start, PUT each part, complete. */
  async function upload(platform: 'win' | 'mac', fileName: string, body: Buffer) {
    const start = await owner.api.call('startDesktopUpload', {
      body: { platform, fileName, sizeBytes: body.length },
    });
    const parts = [];
    for (const part of start.parts) {
      const from = (part.partNumber - 1) * start.partSize;
      const res = await fetch(part.url, {
        method: 'PUT',
        body: body.subarray(from, from + start.partSize),
      });
      expect(res.status).toBe(200);
      parts.push({ partNumber: part.partNumber, etag: res.headers.get('etag')! });
    }
    await owner.api.call('completeDesktopUpload', {
      params: { upload: start.uploadId },
      body: { platform, fileName, parts },
    });
  }

  const feed = async (platform = 'win', file = 'latest.yml') => {
    const res = await app.app.request(
      `http://localhost:3000/api/v1/desktop/updates/${platform}/${file}`,
      { headers: { 'x-forwarded-for': '198.51.100.21' } },
    );
    return { status: res.status, text: await res.text() };
  };

  beforeAll(async () => {
    app = await createTestApp();
    await app.deps.storage!.ensureBucket();
    ({ owner } = await setupWithOwner(app));
    member = (await join(app, owner, 'mert@milvasoft.com', 'member')).person;
    resetDesktopCache();
  });
  afterAll(async () => {
    await app.close();
  });

  it('reads kind and version from electron-builder file names', () => {
    expect(versionOf('Crewhall-Setup-0.2.5.exe')).toBe('0.2.5');
    expect(versionOf('Crewhall-Setup-0.2.5.exe.blockmap')).toBe('0.2.5');
    expect(versionOf('Crewhall-0.3.0-beta.1-mac.zip')).toBe('0.3.0-beta.1');
    expect(versionOf('Crewhall-Setup.exe')).toBeNull();
    expect(fileKind('win', 'a-1.0.0.exe')).toBe('installer');
    expect(fileKind('win', 'a-1.0.0.exe.blockmap')).toBe('blockmap');
    expect(fileKind('win', 'a-1.0.0-mac.zip')).toBeNull();
    expect(fileKind('mac', 'a-1.0.0-mac.zip')).toBe('update_zip');
    expect(fileKind('mac', 'a-1.0.0.dmg')).toBe('dmg');
  });

  it('is for the admins of the primary org only', async () => {
    await expect(member.api.call('listDesktopReleases')).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(
      member.api.call('startDesktopUpload', {
        body: { platform: 'win', fileName: 'Crewhall-Setup-0.2.0.exe', sizeBytes: 10 },
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('refuses names that are not plain release files of the platform', async () => {
    for (const fileName of ['../Crewhall-Setup-0.2.0.exe', '.hidden.exe', 'run.sh', 'a/b.exe']) {
      await expect(
        owner.api.call('startDesktopUpload', {
          body: { platform: 'win', fileName, sizeBytes: 10 },
        }),
      ).rejects.toMatchObject({ code: 'validation_failed' });
    }
    for (const fileName of ['Crewhall-0.2.0-mac.zip', 'Crewhall-Setup.exe']) {
      await expect(
        owner.api.call('startDesktopUpload', {
          body: { platform: 'win', fileName, sizeBytes: 10 },
        }),
      ).rejects.toMatchObject({ code: 'desktop_file_invalid' });
    }
  });

  it('uploads, publishes and serves the feed it wrote', async () => {
    const exe = bytes(3);
    await upload('win', 'Crewhall-Setup-0.2.0.exe', exe);
    await upload('win', 'Crewhall-Setup-0.2.0.exe.blockmap', bytes(5, 300));
    expect((await feed()).status).toBe(404);

    const state = await owner.api.call('publishDesktopRelease', {
      body: { platform: 'win', installer: 'Crewhall-Setup-0.2.0.exe' },
    });
    expect(state).toMatchObject({
      platform: 'win',
      servedFrom: 's3',
      current: { version: '0.2.0' },
      versions: [{ version: '0.2.0', current: true }],
    });
    expect(state.versions[0]!.files.map((f) => [f.name, f.kind, f.sizeBytes, f.sha512])).toEqual([
      ['Crewhall-Setup-0.2.0.exe', 'installer', 4096, sha(exe)],
      ['Crewhall-Setup-0.2.0.exe.blockmap', 'blockmap', 300, null],
    ]);

    const served = await feed();
    expect(served.status).toBe(200);
    expect(parseFeed(served.text)).toMatchObject({
      version: '0.2.0',
      path: 'Crewhall-Setup-0.2.0.exe',
      files: [{ url: 'Crewhall-Setup-0.2.0.exe', size: 4096, sha512: sha(exe) }],
    });
    expect(served.text).toContain(`\nsha512: ${sha(exe)}\n`);
    expect(served.text).toMatch(/releaseDate: '\d{4}-\d{2}-\d{2}T/);
    const installer = await feed('win', 'Crewhall-Setup-0.2.0.exe');
    expect(installer.status).toBe(200);
  });

  it('shows a new version at once and keeps the published files from being replaced', async () => {
    await upload('win', 'Crewhall-Setup-0.3.0.exe', bytes(7));
    await upload('win', 'Crewhall-Setup-0.3.0.exe.blockmap', bytes(11, 200));
    // The bootstrap cache is warm with 0.2.0; publishing empties it.
    expect((await new Client(app).api.call('bootstrap')).desktop?.version).toBe('0.2.0');
    await owner.api.call('publishDesktopRelease', {
      body: { platform: 'win', installer: 'Crewhall-Setup-0.3.0.exe' },
    });
    expect((await new Client(app).api.call('bootstrap')).desktop?.version).toBe('0.3.0');
    await expect(
      owner.api.call('startDesktopUpload', {
        body: { platform: 'win', fileName: 'Crewhall-Setup-0.3.0.exe', sizeBytes: 10 },
      }),
    ).rejects.toMatchObject({ code: 'desktop_release_in_use' });
  });

  it('rolls back by publishing an older version', async () => {
    const state = await owner.api.call('publishDesktopRelease', {
      body: { platform: 'win', installer: 'Crewhall-Setup-0.2.0.exe' },
    });
    expect(state.current?.version).toBe('0.2.0');
    expect(state.versions.map((v) => [v.version, v.current])).toEqual([
      ['0.3.0', false],
      ['0.2.0', true],
    ]);
    expect(parseFeed((await feed()).text).version).toBe('0.2.0');
    const [log] = await app.deps.db
      .select()
      .from(auditLogs)
      .where(
        and(eq(auditLogs.action, 'desktop.release.publish'), eq(auditLogs.targetId, 'win/0.2.0')),
      )
      .orderBy(auditLogs.id)
      .offset(1);
    expect(log!.meta).toMatchObject({ previous: '0.3.0', rollback: true });
  });

  it('refuses to publish missing files or a bad version', async () => {
    await expect(
      owner.api.call('publishDesktopRelease', {
        body: { platform: 'win', installer: 'Crewhall-Setup-9.9.9.exe' },
      }),
    ).rejects.toMatchObject({ code: 'desktop_file_missing' });
    await expect(
      owner.api.call('publishDesktopRelease', {
        body: { platform: 'win', installer: 'Crewhall-0.2.0-mac.zip' },
      }),
    ).rejects.toMatchObject({ code: 'desktop_file_invalid' });
    await expect(
      owner.api.call('publishDesktopRelease', {
        body: { platform: 'win', installer: 'Crewhall-Setup-0.2.0.exe', version: '2' },
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('writes the macOS feed with the zip first and the dmg for download', async () => {
    const zip = bytes(13);
    const dmg = bytes(17, 5000);
    await upload('mac', 'Crewhall-0.2.0-mac.zip', zip);
    await upload('mac', 'Crewhall-0.2.0-mac.dmg', dmg);
    await owner.api.call('publishDesktopRelease', {
      body: { platform: 'mac', installer: 'Crewhall-0.2.0-mac.zip', dmg: 'Crewhall-0.2.0-mac.dmg' },
    });
    const mac = parseFeed((await feed('mac', 'latest-mac.yml')).text);
    expect(mac).toMatchObject({
      version: '0.2.0',
      path: 'Crewhall-0.2.0-mac.zip',
      files: [
        { url: 'Crewhall-0.2.0-mac.zip', size: 4096, sha512: sha(zip) },
        { url: 'Crewhall-0.2.0-mac.dmg', size: 5000, sha512: sha(dmg) },
      ],
    });
    const boot = await new Client(app).api.call('bootstrap');
    expect(boot.desktop?.platforms.find((p) => p.platform === 'mac')?.url).toBe(
      '/api/v1/desktop/updates/mac/Crewhall-0.2.0-mac.dmg',
    );
  });

  it('deletes an old version but not the published one, keeping blockmaps by default', async () => {
    await expect(
      owner.api.call('deleteDesktopRelease', { params: { platform: 'win', version: '0.2.0' } }),
    ).rejects.toMatchObject({ code: 'desktop_release_in_use' });
    const state = await owner.api.call('deleteDesktopRelease', {
      params: { platform: 'win', version: '0.3.0' },
    });
    expect(state.versions.find((v) => v.version === '0.3.0')!.files.map((f) => f.kind)).toEqual([
      'blockmap',
    ]);
    expect((await feed('win', 'Crewhall-Setup-0.3.0.exe')).status).toBe(404);
    const gone = await owner.api.call('deleteDesktopRelease', {
      params: { platform: 'win', version: '0.3.0' },
      query: { blockmaps: 'true' },
    });
    expect(gone.versions.map((v) => v.version)).toEqual(['0.2.0']);
    await expect(
      owner.api.call('deleteDesktopRelease', { params: { platform: 'win', version: '0.3.0' } }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('uploads in parts, so a proxy in front of S3 never sees the whole file', async () => {
    // Just over one part: two PUTs, the second a few bytes.
    const big = Buffer.alloc(DESKTOP_UPLOAD_PART_BYTES + 10, 7);
    big.write('crewhall', 0);
    const start = await owner.api.call('startDesktopUpload', {
      body: { platform: 'win', fileName: 'Crewhall-Setup-0.4.0.exe', sizeBytes: big.length },
    });
    expect(start.partSize).toBe(DESKTOP_UPLOAD_PART_BYTES);
    expect(start.parts.map((p) => p.partNumber)).toEqual([1, 2]);
    const etags = [];
    for (const part of start.parts) {
      const from = (part.partNumber - 1) * start.partSize;
      const res = await fetch(part.url, {
        method: 'PUT',
        body: big.subarray(from, from + start.partSize),
      });
      expect(res.status).toBe(200);
      etags.push({ partNumber: part.partNumber, etag: res.headers.get('etag')! });
    }
    const file = await owner.api.call('completeDesktopUpload', {
      params: { upload: start.uploadId },
      body: { platform: 'win', fileName: 'Crewhall-Setup-0.4.0.exe', parts: etags },
    });
    expect(file).toMatchObject({
      name: 'Crewhall-Setup-0.4.0.exe',
      kind: 'installer',
      sizeBytes: big.length,
    });
    const state = await owner.api.call('publishDesktopRelease', {
      body: { platform: 'win', installer: 'Crewhall-Setup-0.4.0.exe' },
    });
    expect(state.versions[0]!.files[0]).toMatchObject({ sha512: sha(big), sizeBytes: big.length });

    // A small file is one part; an abandoned upload is dropped and leaves no file.
    const small = await owner.api.call('startDesktopUpload', {
      body: { platform: 'win', fileName: 'Crewhall-Setup-0.5.0.exe', sizeBytes: 100 },
    });
    expect(small.parts).toHaveLength(1);
    expect(
      await owner.api.call('abortDesktopUpload', {
        params: { upload: small.uploadId },
        query: { platform: 'win', fileName: 'Crewhall-Setup-0.5.0.exe' },
      }),
    ).toEqual({});
    await expect(
      owner.api.call('completeDesktopUpload', {
        params: { upload: small.uploadId },
        body: {
          platform: 'win',
          fileName: 'Crewhall-Setup-0.5.0.exe',
          parts: [{ partNumber: 1, etag: '"x"' }],
        },
      }),
    ).rejects.toMatchObject({ code: 'desktop_file_missing' });
    await expect(
      owner.api.call('startDesktopUpload', {
        body: { platform: 'win', fileName: 'Crewhall-Setup-0.4.0.exe', sizeBytes: 10 },
      }),
    ).rejects.toMatchObject({ code: 'desktop_release_in_use' });
    await owner.api.call('publishDesktopRelease', {
      body: { platform: 'win', installer: 'Crewhall-Setup-0.2.0.exe' },
    });
  });

  it('resumes an unfinished upload of the same file and size', async () => {
    const big = Buffer.alloc(DESKTOP_UPLOAD_PART_BYTES + 20, 3);
    const body = { platform: 'win' as const, fileName: 'Crewhall-Setup-0.7.0.exe' };
    const first = await owner.api.call('startDesktopUpload', {
      body: { ...body, sizeBytes: big.length },
    });
    expect(first.uploadedParts).toBeUndefined();
    // Only the first part made it before the page was reloaded.
    const put = await fetch(first.parts[0]!.url, {
      method: 'PUT',
      body: big.subarray(0, DESKTOP_UPLOAD_PART_BYTES),
    });
    const etag = put.headers.get('etag')!;

    const again = await owner.api.call('startDesktopUpload', {
      body: { ...body, sizeBytes: big.length },
    });
    expect(again.uploadId).toBe(first.uploadId);
    expect(again.uploadedParts).toEqual([
      { partNumber: 1, etag, sizeBytes: DESKTOP_UPLOAD_PART_BYTES },
    ]);
    expect(again.parts.map((p) => p.partNumber)).toEqual([2]);
    const rest = await fetch(again.parts[0]!.url, {
      method: 'PUT',
      body: big.subarray(DESKTOP_UPLOAD_PART_BYTES),
    });
    const file = await owner.api.call('completeDesktopUpload', {
      params: { upload: again.uploadId },
      body: {
        ...body,
        parts: [
          { partNumber: 1, etag },
          { partNumber: 2, etag: rest.headers.get('etag')! },
        ],
      },
    });
    expect(file.sizeBytes).toBe(big.length);

    // A different size does not fit the parts already there: a fresh upload, the old one dropped.
    const other = { platform: 'win' as const, fileName: 'Crewhall-Setup-0.8.0.exe' };
    const a = await owner.api.call('startDesktopUpload', {
      body: { ...other, sizeBytes: DESKTOP_UPLOAD_PART_BYTES + 5 },
    });
    await fetch(a.parts[0]!.url, {
      method: 'PUT',
      body: big.subarray(0, DESKTOP_UPLOAD_PART_BYTES),
    });
    const b = await owner.api.call('startDesktopUpload', { body: { ...other, sizeBytes: 50 } });
    expect(b.uploadId).not.toBe(a.uploadId);
    expect(b.uploadedParts).toBeUndefined();
    expect(
      await app.deps.storage!.listMultipartUploads('desktop-updates/win/Crewhall-Setup-0.8.0.exe'),
    ).toEqual([expect.objectContaining({ uploadId: b.uploadId })]);
  });

  it('lists both platforms', async () => {
    const list = await owner.api.call('listDesktopReleases');
    expect(list.storage).toBe(true);
    expect(list.platforms.map((p) => [p.platform, p.servedFrom, p.current?.version])).toEqual([
      ['win', 's3', '0.2.0'],
      ['mac', 's3', '0.2.0'],
    ]);
  });
});
