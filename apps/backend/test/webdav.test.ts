import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, type FileStat, type WebDAVClient } from 'webdav';
import type { McpScope } from '@crewhall/shared';
import { parseXml } from '../src/services/drive/webdav/xml';
import { listen } from './chat-helpers';
import { Client, createTestApp, join, setupWithOwner, type TestApp } from './helpers';

/** WebDAV (roadmap 9) driven by a real client library over HTTP, as rclone or Finder would. */
describe('WebDAV', () => {
  let app: TestApp;
  let owner: Client;
  let server: Awaited<ReturnType<typeof listen>>;
  let base: string;
  let dav: WebDAVClient;
  let token: string;
  let sharedId: string;
  let altyapiId: string;

  async function newToken(scopes: McpScope[], spaceIds: string[] | null = null) {
    const created = await owner.api.call('createMcpToken', {
      body: { name: 'WebDAV', scopes, spaceIds, expiresInDays: 30 },
    });
    return created.value;
  }

  const clientFor = (password: string) =>
    createClient(base, { username: 'bugra@milvasoft.com', password });

  async function raw(method: string, path: string, init: RequestInit = {}, pass = token) {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Basic ${Buffer.from(`x:${pass}`).toString('base64')}`);
    return fetch(`http://127.0.0.1:${server.port}${path}`, { ...init, method, headers });
  }

  async function nodeByName(spaceId: string, name: string, parentId?: string) {
    const list = await owner.api.call('listNodes', {
      params: { spaceId },
      query: { parentId, limit: 100 },
    });
    return list.items.find((n) => n.name === name);
  }

  beforeAll(async () => {
    app = await createTestApp();
    ({ owner } = await setupWithOwner(app));
    const spaces = await owner.api.call('listSpaces');
    sharedId = spaces.items.find((s) => s.name === 'Milvasoft')!.id;
    altyapiId = spaces.items.find((s) => s.name === 'Altyapı')!.id;
    server = await listen(app);
    base = `http://127.0.0.1:${server.port}/dav`;
    token = await newToken(['hub:read', 'drive:write']);
    dav = clientFor(token);
  });

  afterAll(async () => {
    await server?.close();
    await app?.close();
  });

  it('answers OPTIONS with the DAV classes, even before sign-in', async () => {
    const res = await fetch(`${base}/`, { method: 'OPTIONS' });
    expect(res.status).toBe(200);
    expect(res.headers.get('dav')).toBe('1, 2');
    expect(res.headers.get('allow')).toContain('PROPFIND');
  });

  it('refuses requests without a valid token with a Basic challenge', async () => {
    const res = await fetch(`${base}/`, { method: 'PROPFIND', headers: { Depth: '0' } });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/^Basic/);
    await expect(clientFor('mhp_wrong').getDirectoryContents('/')).rejects.toMatchObject({
      status: 401,
    });
  });

  it('lists the spaces as root folders', async () => {
    const items = (await dav.getDirectoryContents('/')) as FileStat[];
    const names = items.map((i) => i.basename);
    expect(names).toEqual(expect.arrayContaining(['Milvasoft', 'Altyapı', 'Ahmet Buğra Kösen']));
    expect(items.every((i) => i.type === 'directory')).toBe(true);
  });

  it('creates folders and files, reads them back and versions a second PUT', async () => {
    await dav.createDirectory('/Milvasoft/Raporlar');
    const folder = await nodeByName(sharedId, 'Raporlar');
    expect(folder?.type).toBe('folder');

    expect(await dav.putFileContents('/Milvasoft/Raporlar/notlar ğüş.txt', 'merhaba')).toBe(true);
    const stat = (await dav.stat('/Milvasoft/Raporlar/notlar ğüş.txt')) as FileStat;
    expect(stat.size).toBe(7);
    expect(stat.mime).toBe('text/plain');
    expect(
      await dav.getFileContents('/Milvasoft/Raporlar/notlar ğüş.txt', { format: 'text' }),
    ).toBe('merhaba');

    await dav.putFileContents('/Milvasoft/Raporlar/notlar ğüş.txt', 'merhaba dünya');
    const file = await nodeByName(sharedId, 'notlar ğüş.txt', folder!.id);
    const versions = await owner.api.call('listVersions', { params: { nodeId: file!.id } });
    expect(versions.items.map((v) => v.version)).toEqual([2, 1]);
    expect(versions.items[0]!.source).toBe('api');
    expect(
      await dav.getFileContents('/Milvasoft/Raporlar/notlar ğüş.txt', { format: 'text' }),
    ).toBe('merhaba dünya');

    const listed = (await dav.getDirectoryContents('/Milvasoft/Raporlar')) as FileStat[];
    expect(listed.map((i) => i.basename)).toEqual(['notlar ğüş.txt']);
  });

  it('serves byte ranges', async () => {
    const res = await raw(
      'GET',
      `/dav/Milvasoft/Raporlar/${encodeURIComponent('notlar ğüş.txt')}`,
      {
        headers: { Range: 'bytes=0-6' },
      },
    );
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(
      `bytes 0-6/${Buffer.byteLength('merhaba dünya')}`,
    );
    expect(await res.text()).toBe('merhaba');
  });

  it('keeps one version when Windows writes an empty file first', async () => {
    await dav.putFileContents('/Milvasoft/bos.txt', '');
    await dav.putFileContents('/Milvasoft/bos.txt', 'içerik');
    const file = await nodeByName(sharedId, 'bos.txt');
    const versions = await owner.api.call('listVersions', { params: { nodeId: file!.id } });
    expect(versions.items).toHaveLength(1);
    expect(versions.items[0]!.sizeBytes).toBe(Buffer.byteLength('içerik'));
  });

  it('streams a chunked body larger than one part (multipart upload)', async () => {
    const size = 17 * 1024 * 1024;
    const chunk = Buffer.alloc(1024 * 1024, 7);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= size) return controller.close();
        controller.enqueue(new Uint8Array(chunk));
        sent += chunk.length;
      },
    });
    const init: RequestInit & { duplex: 'half' } = { body, duplex: 'half' };
    const res = await raw('PUT', '/dav/Milvasoft/buyuk.bin', init);
    expect(res.status).toBe(201);
    const stat = (await dav.stat('/Milvasoft/buyuk.bin')) as FileStat;
    expect(stat.size).toBe(size);
    const tail = await raw('GET', '/dav/Milvasoft/buyuk.bin', {
      headers: { Range: `bytes=${size - 4}-` },
    });
    expect(Buffer.from(await tail.arrayBuffer())).toEqual(Buffer.alloc(4, 7));
  }, 60_000);

  it('copies, renames, moves across spaces and deletes to the trash', async () => {
    await dav.copyFile('/Milvasoft/bos.txt', '/Milvasoft/Raporlar/kopya.txt');
    expect(await dav.getFileContents('/Milvasoft/Raporlar/kopya.txt', { format: 'text' })).toBe(
      'içerik',
    );
    await dav.moveFile('/Milvasoft/Raporlar/kopya.txt', '/Milvasoft/Raporlar/yeni ad.txt');
    expect(await dav.exists('/Milvasoft/Raporlar/kopya.txt')).toBe(false);
    await dav.moveFile('/Milvasoft/Raporlar/yeni ad.txt', '/Altyapı/taşındı.txt');
    expect(await nodeByName(altyapiId, 'taşındı.txt')).toBeDefined();

    await dav.createDirectory('/Altyapı/Klasör');
    await dav.putFileContents('/Altyapı/Klasör/a.txt', 'a');
    await dav.copyFile('/Altyapı/Klasör', '/Milvasoft/Klasör kopyası');
    expect(await dav.getFileContents('/Milvasoft/Klasör kopyası/a.txt', { format: 'text' })).toBe(
      'a',
    );

    await dav.deleteFile('/Altyapı/taşındı.txt');
    expect(await dav.exists('/Altyapı/taşındı.txt')).toBe(false);
    const trash = await owner.api.call('listTrash', {
      params: { spaceId: altyapiId },
      query: { limit: 50 },
    });
    expect(trash.items.map((t) => t.name)).toContain('taşındı.txt');
  });

  it('moving a file onto an existing one adds a version and trashes the source', async () => {
    await dav.putFileContents('/Milvasoft/belge.txt', 'v1');
    await dav.putFileContents('/Milvasoft/~belge.tmp', 'v2');
    await dav.moveFile('/Milvasoft/~belge.tmp', '/Milvasoft/belge.txt');
    const file = await nodeByName(sharedId, 'belge.txt');
    const versions = await owner.api.call('listVersions', { params: { nodeId: file!.id } });
    expect(versions.items).toHaveLength(2);
    expect(await dav.getFileContents('/Milvasoft/belge.txt', { format: 'text' })).toBe('v2');
    expect(await nodeByName(sharedId, '~belge.tmp')).toBeUndefined();

    const noOverwrite = await raw('MOVE', '/dav/Milvasoft/bos.txt', {
      headers: { Destination: '/dav/Milvasoft/belge.txt', Overwrite: 'F' },
    });
    expect(noOverwrite.status).toBe(412);
  });

  it('locks a file: writes without the token get 423, with it they pass', async () => {
    const lock = await dav.lock('/Milvasoft/belge.txt');
    expect(lock.token).toMatch(/^opaquelocktoken:/);
    const blocked = await raw('PUT', '/dav/Milvasoft/belge.txt', { body: 'x' });
    expect(blocked.status).toBe(423);
    await dav.putFileContents('/Milvasoft/belge.txt', 'kilitli yazım', {
      headers: { If: `(<${lock.token}>)` },
    });
    const props = await raw('PROPFIND', '/dav/Milvasoft/belge.txt', {
      headers: { Depth: '0' },
      body: '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:lockdiscovery/><Z:Win32FileAttributes xmlns:Z="urn:schemas-microsoft-com:"/></D:prop></D:propfind>',
    });
    expect(props.status).toBe(207);
    const xml = await props.text();
    expect(xml).toContain(lock.token);
    // Unknown properties come back in a 404 propstat with their namespace.
    const doc = parseXml(xml);
    expect(JSON.stringify(doc)).toContain('urn:schemas-microsoft-com:');
    expect(xml).toContain('HTTP/1.1 404 Not Found');

    await dav.unlock('/Milvasoft/belge.txt', lock.token);
    const free = await raw('PUT', '/dav/Milvasoft/belge.txt', { body: 'serbest' });
    expect(free.status).toBe(204);
  });

  it('a lock on a new name creates an empty file (Office)', async () => {
    const res = await raw('LOCK', '/dav/Milvasoft/yeni.docx', {
      headers: { Timeout: 'Second-600' },
      body: '<?xml version="1.0"?><D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype><D:owner><D:href>bugra</D:href></D:owner></D:lockinfo>',
    });
    expect(res.status).toBe(201);
    const lockToken = res.headers.get('lock-token')!;
    expect(lockToken).toMatch(/^<opaquelocktoken:/);
    expect(await res.text()).toContain('<D:href>bugra</D:href>');
    const stat = (await dav.stat('/Milvasoft/yeni.docx')) as FileStat;
    expect(stat.size).toBe(0);
    const second = await raw('LOCK', '/dav/Milvasoft/yeni.docx', {
      body: '<?xml version="1.0"?><D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockinfo>',
    });
    expect(second.status).toBe(423);
    const refresh = await raw('LOCK', '/dav/Milvasoft/yeni.docx', {
      headers: { If: `(${lockToken})`, Timeout: 'Second-1200' },
    });
    expect(refresh.status).toBe(200);
    expect(await refresh.text()).toMatch(/Second-1[12]\d\d/);
  });

  it('refuses infinite depth on folders and drops desktop metadata files', async () => {
    const deep = await raw('PROPFIND', '/dav/Milvasoft/', { headers: { Depth: 'infinity' } });
    expect(deep.status).toBe(403);
    expect(await deep.text()).toContain('propfind-finite-depth');

    const junk = await raw('PUT', '/dav/Milvasoft/._belge.txt', { body: 'mac' });
    expect(junk.status).toBe(201);
    expect(await dav.exists('/Milvasoft/._belge.txt')).toBe(false);

    const conflict = await raw('PUT', '/dav/Milvasoft/yok/dosya.txt', { body: 'x' });
    expect(conflict.status).toBe(409);
    const exists = await raw('MKCOL', '/dav/Milvasoft/Raporlar');
    expect(exists.status).toBe(405);
  });

  it('honours token scopes and spaces', async () => {
    const readOnly = clientFor(await newToken(['hub:read']));
    expect((await readOnly.getDirectoryContents('/Milvasoft')).length).toBeGreaterThan(0);
    await expect(readOnly.createDirectory('/Milvasoft/olmaz')).rejects.toMatchObject({
      status: 403,
    });

    const narrow = clientFor(await newToken(['hub:read', 'drive:write'], [altyapiId]));
    const roots = (await narrow.getDirectoryContents('/')) as FileStat[];
    expect(roots.map((r) => r.basename)).toEqual(['Altyapı']);
    await expect(narrow.stat('/Milvasoft/belge.txt')).rejects.toMatchObject({ status: 404 });
  });

  it('shows another member only what can() lets them see', async () => {
    const mert = await join(app, owner, 'mert@milvasoft.com', 'member', [sharedId]);
    const created = await mert.person.api.call('createMcpToken', {
      body: { name: 'dav', scopes: ['hub:read', 'drive:write'], spaceIds: null, expiresInDays: 7 },
    });
    const theirs = createClient(base, { username: 'mert', password: created.value });
    const roots = ((await theirs.getDirectoryContents('/')) as FileStat[]).map((r) => r.basename);
    expect(roots).toContain('Milvasoft');
    expect(roots).not.toContain('Altyapı');
    expect(roots).not.toContain('Ahmet Buğra Kösen');
    await expect(theirs.stat('/Altyapı')).rejects.toMatchObject({ status: 404 });
  });
});
