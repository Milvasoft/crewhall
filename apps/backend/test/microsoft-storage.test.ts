import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setMicrosoftFetch } from '../src/services/microsoft/graph';
import { setSmbClientFactory } from '../src/services/microsoft/storage/smb';
import { Client, createTestApp, join, setupWithOwner, type TestApp } from './helpers';

const API = 'http://localhost:3000';
const TENANT = 'contoso.onmicrosoft.com';
const CLIENT_ID = '11111111-2222-4333-8444-555555555555';

type Entry = { folder: true } | { content: Buffer; mime: string };

/** In-memory Microsoft Graph: drives by id, items by path. */
function fakeGraph() {
  const drives = new Map<string, Map<string, Entry>>([
    [
      'drive-sp',
      new Map<string, Entry>([
        ['Raporlar', { folder: true }],
        ['Raporlar/2026', { folder: true }],
        [
          'Raporlar/2026/ekim.xlsx',
          { content: Buffer.from('ekim'), mime: 'application/vnd.ms-excel' },
        ],
        ['Raporlar/ozet.pdf', { content: Buffer.from('%PDF ozet'), mime: 'application/pdf' }],
      ]),
    ],
    [
      'drive-od',
      new Map<string, Entry>([
        ['Belgeler', { folder: true }],
        ['Belgeler/cv.docx', { content: Buffer.from('cv'), mime: 'application/msword' }],
        ['not.txt', { content: Buffer.from('not'), mime: 'text/plain' }],
      ]),
    ],
  ]);
  const payload = Buffer.from(
    JSON.stringify({ roles: ['Sites.ReadWrite.All', 'Files.ReadWrite.All'] }),
  ).toString('base64url');
  const children = (drive: Map<string, Entry>, parent: string) =>
    [...drive.entries()]
      .filter(([p]) =>
        p.includes('/') ? p.slice(0, p.lastIndexOf('/')) === parent : parent === '',
      )
      .map(([p, e]) => item(p, e));
  const item = (p: string, e: Entry) => ({
    id: p,
    name: p.split('/').pop(),
    lastModifiedDateTime: '2026-10-20T10:00:00Z',
    ...('folder' in e ? { folder: {} } : { size: e.content.length, file: { mimeType: e.mime } }),
  });
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    if (url.host === 'login.microsoftonline.com') {
      return Response.json({ access_token: `h.${payload}.s`, expires_in: 3600 });
    }
    const path = decodeURIComponent(url.pathname.replace(/^\/v1\.0/, ''));
    if (path === '/sites/contoso.sharepoint.com:/sites/Finans')
      return Response.json({ id: 'site-1' });
    if (path === '/sites/site-1/drives')
      return Response.json({ value: [{ id: 'drive-sp', name: 'Belgeler' }] });
    if (path === '/users/ayse@contoso.test/drive' || path === '/users/bugra@milvasoft.com/drive') {
      return Response.json({ id: 'drive-od' });
    }
    const m = /^\/drives\/([^/]+)\/root(?::\/(.*?):)?(\/children|\/content)?$/.exec(path);
    const drive = m ? drives.get(m[1]!) : undefined;
    if (!m || !drive)
      return Response.json({ error: { code: 'itemNotFound', message: path } }, { status: 404 });
    const target = m[2] ?? '';
    const tail = m[3];
    if (tail === '/children' && method === 'GET') {
      if (target && !drive.has(target))
        return Response.json({ error: { code: 'itemNotFound' } }, { status: 404 });
      return Response.json({ value: children(drive, target) });
    }
    if (tail === '/children' && method === 'POST') {
      const body = JSON.parse(String(init!.body)) as { name: string };
      const p = target ? `${target}/${body.name}` : body.name;
      drive.set(p, { folder: true });
      return Response.json(item(p, { folder: true }), { status: 201 });
    }
    if (tail === '/content' && method === 'PUT') {
      let p = target;
      while (drive.has(p)) p = p.replace(/(\.\w+)?$/, ' 1$1');
      const entry = {
        content: Buffer.from(init!.body as Uint8Array),
        mime: 'application/octet-stream',
      };
      drive.set(p, entry);
      return Response.json(item(p, entry), { status: 201 });
    }
    const entry = drive.get(target);
    if (!entry && target)
      return Response.json({ error: { code: 'itemNotFound' } }, { status: 404 });
    if (tail === '/content')
      return new Response(new Uint8Array((entry as { content: Buffer }).content));
    return Response.json(entry ? item(target, entry) : { id: 'root', folder: {} });
  };
  return { drives, fetch };
}

/** In-memory SMB share. */
function fakeSmb() {
  const files = new Map<string, Buffer | 'dir'>([
    ['Ortak', 'dir'],
    ['Ortak\\liste.csv', Buffer.from('a;b')],
  ]);
  const client = {
    readdir: async (path: string) => {
      if (path && files.get(path) !== 'dir')
        throw Object.assign(new Error('nf'), { code: 'STATUS_OBJECT_NAME_NOT_FOUND' });
      return [...files.entries()]
        .filter(([p]) => (p.includes('\\') ? p.slice(0, p.lastIndexOf('\\')) : '') === path)
        .map(([p, v]) => ({
          name: p.split('\\').pop()!,
          mtime: new Date(),
          birthtime: new Date(),
          isDirectory: () => v === 'dir',
        }));
    },
    readFile: async (path: string) => {
      const v = files.get(path);
      if (!v || v === 'dir')
        throw Object.assign(new Error('nf'), { code: 'STATUS_OBJECT_NAME_NOT_FOUND' });
      return v;
    },
    writeFile: async (path: string, data: Buffer) => void files.set(path, data),
    mkdir: async (path: string) => void files.set(path, 'dir'),
    exists: async (path: string) => files.has(path),
    getSize: async () => 0,
    disconnect: () => undefined,
  };
  return { files, client };
}

describe('External storage: SharePoint, OneDrive and SMB', () => {
  let app: TestApp;
  let owner: Client;
  let spaceId: string;
  let mountId: string;
  const graph = fakeGraph();
  const smb = fakeSmb();

  beforeAll(async () => {
    setMicrosoftFetch(graph.fetch as typeof fetch);
    setSmbClientFactory(() => smb.client as never);
    app = await createTestApp();
    ({ owner } = await setupWithOwner(app));
    spaceId = (await owner.api.call('listSpaces')).items.find((s) => s.name === 'Altyapı')!.id;
  }, 300_000);
  afterAll(async () => {
    setMicrosoftFetch(null);
    setSmbClientFactory(null);
    await app?.close();
  });

  it('stores the app registration and reads the granted permissions', async () => {
    await expect(owner.api.call('testMicrosoftApp')).rejects.toMatchObject({
      code: 'microsoft_app_missing',
    });
    const appView = await owner.api.call('updateMicrosoftApp', {
      body: { tenantId: TENANT, clientId: CLIENT_ID, clientSecret: 'app-secret-value-1234' },
    });
    expect(appView).toMatchObject({ secretSet: true, secretHint: '1234', clientId: CLIENT_ID });
    const test = await owner.api.call('testMicrosoftApp');
    expect(test).toEqual({
      ok: true,
      roles: ['Sites.ReadWrite.All', 'Files.ReadWrite.All'],
      error: null,
    });
    await owner.api.call('updateMicrosoftIntegration', {
      params: { integration: 'externalStorage' },
      body: { enabled: true },
    });
  });

  it('mounts a SharePoint library into a space and browses it live', async () => {
    const mount = await owner.api.call('createDriveMount', {
      body: {
        spaceId,
        name: 'Finans raporları',
        kind: 'sharepoint',
        readOnly: false,
        config: {
          siteUrl: 'https://contoso.sharepoint.com/sites/Finans',
          library: 'Belgeler',
          rootPath: 'Raporlar',
        },
      },
    });
    mountId = mount.id;
    expect(mount).toMatchObject({
      lastOk: true,
      location: 'https://contoso.sharepoint.com/sites/Finans › Belgeler',
    });
    expect((await owner.api.call('listSpaceMounts', { params: { spaceId } })).items).toHaveLength(
      1,
    );

    const root = await owner.api.call('listMountItems', {
      params: { mountId },
      query: {} as never,
    });
    expect(root.canWrite).toBe(true);
    expect(root.items.map((i) => [i.name, i.type])).toEqual([
      ['2026', 'folder'],
      ['ozet.pdf', 'file'],
    ]);
    const sub = await owner.api.call('listMountItems', {
      params: { mountId },
      query: { path: '2026' },
    });
    expect(sub.items[0]).toMatchObject({ name: 'ekim.xlsx', path: '2026/ekim.xlsx', sizeBytes: 4 });

    const file = await owner.fetch(`${API}/api/v1/mounts/${mountId}/download?path=ozet.pdf`);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-disposition')).toContain('attachment');
    expect(await file.text()).toBe('%PDF ozet');
    const escape = await owner.fetch(`${API}/api/v1/mounts/${mountId}/download?path=../gizli.txt`);
    expect(escape.status).toBe(404);
  });

  it('uploads and creates folders for editors, never on a read-only mount', async () => {
    const put = await owner.fetch(
      `${API}/api/v1/mounts/${mountId}/upload?path=2026&name=kasim.xlsx`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/vnd.ms-excel' },
        body: 'kasim',
      },
    );
    expect(put.status).toBe(201);
    expect(graph.drives.get('drive-sp')!.has('Raporlar/2026/kasim.xlsx')).toBe(true);
    const folder = await owner.api.call('createMountFolder', {
      params: { mountId },
      body: { path: '', name: 'Arşiv' },
    });
    expect(folder).toMatchObject({ name: 'Arşiv', type: 'folder' });

    await owner.api.call('updateDriveMount', { params: { mountId }, body: { readOnly: true } });
    await expect(
      owner.api.call('createMountFolder', { params: { mountId }, body: { path: '', name: 'X' } }),
    ).rejects.toMatchObject({ code: 'mount_read_only' });
    expect(
      (await owner.api.call('listMountItems', { params: { mountId }, query: {} as never }))
        .canWrite,
    ).toBe(false);
  });

  it('hides the mount from people outside the space', async () => {
    const { person } = await join(app, owner, 'kerem@milvasoft.com', 'member');
    await expect(
      person.api.call('listMountItems', { params: { mountId }, query: {} as never }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(person.api.call('listDriveMounts')).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('copies a mount folder into Drive in the background', async () => {
    const job = await owner.api.call('startMountImport', {
      body: { source: { kind: 'mount', mountId, path: '' }, target: { spaceId, parentId: null } },
    });
    const done = (await owner.api.call('listImportJobs')).items.find((j) => j.id === job.id)!;
    expect(done).toMatchObject({ status: 'done', files: 3, skipped: 0 });
    const top = await owner.api.call('listNodes', { params: { spaceId }, query: {} as never });
    const names = top.items.map((n) => n.name);
    expect(names).toEqual(expect.arrayContaining(['2026', 'ozet.pdf', 'Arşiv']));
    const year = top.items.find((n) => n.name === '2026')!;
    const inside = await owner.api.call('listNodes', {
      params: { spaceId },
      query: { parentId: year.id } as never,
    });
    expect(inside.items.map((n) => n.name).sort()).toEqual(['ekim.xlsx', 'kasim.xlsx']);
  });

  it("moves people's OneDrives into their personal spaces", async () => {
    await expect(
      owner.api.call('startOneDriveMove', { body: { users: ['yok@contoso.test'] } as never }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    const [job] = (
      await owner.api.call('startOneDriveMove', {
        body: { users: ['bugra@milvasoft.com'] } as never,
      })
    ).items;
    const done = (await owner.api.call('listImportJobs')).items.find((j) => j.id === job!.id)!;
    expect(done).toMatchObject({
      status: 'done',
      files: 2,
      source: 'OneDrive › bugra@milvasoft.com',
    });
    const personal = (await owner.api.call('listSpaces')).items.find((s) => s.kind === 'personal')!;
    const top = await owner.api.call('listNodes', {
      params: { spaceId: personal.id },
      query: {} as never,
    });
    const folder = top.items.find((n) => n.name === 'OneDrive')!;
    const inside = await owner.api.call('listNodes', {
      params: { spaceId: personal.id },
      query: { parentId: folder.id } as never,
    });
    expect(inside.items.map((n) => n.name).sort()).toEqual(['Belgeler', 'not.txt']);
  });

  it('mounts an SMB share and never overwrites a file', async () => {
    const mount = await owner.api.call('createDriveMount', {
      body: {
        spaceId,
        name: 'Ortak sürücü',
        kind: 'smb',
        readOnly: false,
        config: {
          share: '\\\\fs01\\paylasim',
          domain: 'CONTOSO',
          username: 'svc-crewhall',
          rootPath: 'Ortak',
        },
        password: 'smb-pass',
      },
    });
    expect(mount).toMatchObject({ lastOk: true, location: '\\\\fs01\\paylasim' });
    const listing = await owner.api.call('listMountItems', {
      params: { mountId: mount.id },
      query: {} as never,
    });
    expect(listing.items.map((i) => i.name)).toEqual(['liste.csv']);
    const put = await owner.fetch(`${API}/api/v1/mounts/${mount.id}/upload?name=liste.csv`, {
      method: 'PUT',
      body: 'c;d',
    });
    expect(((await put.json()) as { name: string }).name).toBe('liste (2).csv');
    expect(smb.files.get('Ortak\\liste.csv')!.toString()).toBe('a;b');
  });

  it('closes every mount when external storage is switched off', async () => {
    await owner.api.call('updateMicrosoftIntegration', {
      params: { integration: 'externalStorage' },
      body: { enabled: false },
    });
    expect((await owner.api.call('listSpaceMounts', { params: { spaceId } })).items).toEqual([]);
    await expect(
      owner.api.call('listMountItems', { params: { mountId }, query: {} as never }),
    ).rejects.toMatchObject({ code: 'integration_disabled' });
  });
});
