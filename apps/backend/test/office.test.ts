import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { unzipSync } from 'fflate';
import { ApiError } from '@crewhall/api-client';
import type { OfficeSession } from '@crewhall/shared';
import { parseDiscovery, actionUrl } from '../src/services/office/discovery';
import { odfTemplate } from '../src/services/office/templates';
import { issueWopiToken, readWopiToken } from '../src/services/office/token';
import { Client, createTestApp, join, setupWithOwner, type TestApp } from './helpers';

/** A WOPI discovery like Collabora's, served by a stub so the test needs no document server. */
const DISCOVERY = `<?xml version="1.0" encoding="utf-8"?>
<wopi-discovery><net-zone name="external-http">
 <app name="writer"><action default="true" ext="docx" name="edit" urlsrc="https://office.test/browser/abc/cool.html?"/>
  <action ext="odt" name="edit" urlsrc="https://office.test/browser/abc/cool.html?"/></app>
 <app name="calc"><action ext="xlsx" name="edit" urlsrc="https://office.test/browser/abc/cool.html?"/></app>
 <app name="impress"><action ext="pptx" name="edit" urlsrc="https://office.test/browser/abc/cool.html?"/></app>
 <app name="Capabilities"><action ext="" name="getinfo" urlsrc="https://office.test/hosting/capabilities"/></app>
</net-zone></wopi-discovery>`;

describe('office units', () => {
  it('reads discovery and builds the editor URL (Collabora and Office Online styles)', () => {
    const d = parseDiscovery(DISCOVERY);
    expect(d.actions.filter((a) => a.name === 'edit').map((a) => a.ext)).toEqual([
      'docx',
      'odt',
      'xlsx',
      'pptx',
    ]);
    expect(actionUrl('https://office.test/cool.html?', 'http://api/wopi/files/1', 'tr')).toBe(
      'https://office.test/cool.html?WOPISrc=http%3A%2F%2Fapi%2Fwopi%2Ffiles%2F1&lang=tr',
    );
    expect(
      actionUrl(
        'https://oos.test/wv/wordviewerframe.aspx?<ui=UI_LLCC&><rs=DC_LLCC&><dchat=DISABLE_CHAT&>',
        'x',
        'en',
      ),
    ).toBe('https://oos.test/wv/wordviewerframe.aspx?ui=en-US&rs=en-US&WOPISrc=x&lang=en');
  });

  it('signs access tokens per file and person, and refuses tampered or expired ones', () => {
    const grant = {
      n: '0192f1c4-0000-7000-8000-000000000001',
      u: '0192f1c4-0000-7000-8000-000000000002',
      o: '0192f1c4-0000-7000-8000-000000000003',
      w: true,
    };
    const { token } = issueWopiToken('s'.repeat(32), grant);
    expect(readWopiToken('s'.repeat(32), token)).toEqual({ ...grant, p: 'wopi' });
    expect(readWopiToken('t'.repeat(32), token)).toBeNull();
    expect(
      readWopiToken('s'.repeat(32), issueWopiToken('s'.repeat(32), grant, -1).token),
    ).toBeNull();
  });

  it('builds valid OpenDocument packages (mimetype first, stored)', () => {
    const bytes = odfTemplate('spreadsheet');
    expect(Buffer.from(bytes.subarray(30, 38)).toString()).toBe('mimetype');
    const files = unzipSync(bytes);
    expect(new TextDecoder().decode(files.mimetype)).toBe(
      'application/vnd.oasis.opendocument.spreadsheet',
    );
    expect(Object.keys(files)).toEqual(['mimetype', 'META-INF/manifest.xml', 'content.xml']);
  });
});

function wopiOf(s: OfficeSession) {
  if (s.kind !== 'wopi') throw new Error(`expected a WOPI session, got ${s.kind}`);
  return s;
}

describe('office module (WOPI host)', () => {
  let app: TestApp;
  let owner: Client;
  let mert: Client;
  let mertId: string;
  let sharedId: string;
  let stub: Server;
  let docId: string;
  let token: string;

  const wopi = (path: string, init: RequestInit & { token?: string } = {}) =>
    app.app.request(
      `http://localhost:3000/wopi/files/${path}${path.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(init.token ?? token)}`,
      init,
    );

  async function expectCode(p: Promise<unknown>, status: number, code?: string) {
    const err = await p.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(status);
    if (code) expect((err as ApiError).code).toBe(code);
  }

  beforeAll(async () => {
    stub = createServer((req, res) => {
      if (req.url === '/hosting/discovery') {
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        res.end(DISCOVERY);
      } else {
        res.writeHead(404).end();
      }
    });
    await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
    app = await createTestApp();
    ({ owner } = await setupWithOwner(app));
    const spaces = await owner.api.call('listSpaces');
    sharedId = spaces.items.find((s) => s.name === 'Milvasoft')!.id;
    const joined = await join(app, owner, 'mert@milvasoft.com', 'member', [sharedId]);
    mert = joined.person;
    mertId = joined.me.user.id;
  });

  afterAll(async () => {
    await app?.close();
    await new Promise((r) => stub?.close(r));
  });

  it('is off until an admin sets a server; only admins see the settings', async () => {
    expect(await owner.api.call('getOfficeCapabilities')).toEqual({
      available: false,
      edit: [],
      view: [],
    });
    await expectCode(
      owner.api.call('createOfficeDocument', { body: { spaceId: sharedId, kind: 'document' } }),
      503,
      'office_unavailable',
    );
    await expectCode(mert.api.call('getOfficeSettings'), 403, 'forbidden');
    await expectCode(
      owner.api.call('updateOfficeSettings', { body: { enabled: true } }),
      422,
      'validation_failed',
    );
    const port = (stub.address() as AddressInfo).port;
    const saved = await owner.api.call('updateOfficeSettings', {
      body: { enabled: true, serverType: 'wopi', serverUrl: `http://127.0.0.1:${port}/` },
    });
    expect(saved).toMatchObject({ enabled: true, serverUrl: `http://127.0.0.1:${port}` });
    const test = await owner.api.call('testOfficeSettings');
    expect(test).toMatchObject({ ok: true, edit: ['docx', 'xlsx', 'pptx', 'odt'], view: [] });
    expect(await mert.api.call('getOfficeCapabilities')).toMatchObject({
      available: true,
      edit: ['docx', 'xlsx', 'pptx', 'odt'],
    });
  });

  it('creates an empty document and opens it with a WOPI session', async () => {
    const node = await owner.api.call('createOfficeDocument', {
      body: { spaceId: sharedId, kind: 'document' },
    });
    expect(node.name).toBe('Adsız belge.docx');
    docId = node.id;
    const again = await owner.api.call('createOfficeDocument', {
      body: { spaceId: sharedId, kind: 'document' },
    });
    expect(again.name).toBe('Adsız belge (2).docx');

    const session = wopiOf(
      await owner.api.call('openOfficeSession', {
        params: { nodeId: docId },
        body: { mode: 'edit' },
      }),
    );
    expect(session.mode).toBe('edit');
    expect(session.editorOrigin).toBe('https://office.test');
    expect(session.actionUrl).toContain(
      `WOPISrc=${encodeURIComponent(`http://localhost:3000/wopi/files/${docId}`)}`,
    );
    expect(session.accessTokenTtl).toBeGreaterThan(Date.now());
    token = session.accessToken;
    await expectCode(
      owner.api.call('openOfficeSession', { params: { nodeId: sharedId }, body: { mode: 'edit' } }),
      404,
    );
  });

  it('CheckFileInfo and GetFile answer the document server', async () => {
    const info = await wopi(docId);
    expect(info.status).toBe(200);
    const body = (await info.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      BaseFileName: 'Adsız belge.docx',
      UserFriendlyName: 'Ahmet Buğra Kösen',
      UserCanWrite: true,
      SupportsLocks: true,
      PostMessageOrigin: 'http://localhost:5173',
    });
    const file = await wopi(`${docId}/contents`);
    expect(file.status).toBe(200);
    const bytes = new Uint8Array(await file.arrayBuffer());
    expect(Object.keys(unzipSync(bytes))).toContain('word/document.xml');
    expect(bytes.length).toBe(body.Size);

    expect((await wopi(docId, { token: 'nope' })).status).toBe(401);
    const other = await owner.api.call('createOfficeDocument', {
      body: { spaceId: sharedId, kind: 'spreadsheet' },
    });
    expect(other.name).toMatch(/\.xlsx$/);
    expect((await wopi(other.id)).status).toBe(401);
  });

  it('locks, saves a new Drive version under the lock and refuses stale saves', async () => {
    const lock = await wopi(docId, {
      method: 'POST',
      headers: { 'X-WOPI-Override': 'LOCK', 'X-WOPI-Lock': 'lock-a' },
    });
    expect(lock.status).toBe(200);
    const taken = await wopi(docId, {
      method: 'POST',
      headers: { 'X-WOPI-Override': 'LOCK', 'X-WOPI-Lock': 'lock-b' },
    });
    expect(taken.status).toBe(409);
    expect(taken.headers.get('x-wopi-lock')).toBe('lock-a');

    const noLock = await wopi(`${docId}/contents`, {
      method: 'POST',
      headers: { 'X-WOPI-Override': 'PUT' },
      body: 'v2',
    });
    expect(noLock.status).toBe(409);

    const info = (await (await wopi(docId)).json()) as { LastModifiedTime: string };
    const saved = await wopi(`${docId}/contents`, {
      method: 'POST',
      headers: {
        'X-WOPI-Override': 'PUT',
        'X-WOPI-Lock': 'lock-a',
        'X-COOL-WOPI-Timestamp': info.LastModifiedTime,
      },
      body: 'yeni içerik',
    });
    expect(saved.status).toBe(200);
    expect(((await saved.json()) as { LastModifiedTime: string }).LastModifiedTime).not.toBe(
      info.LastModifiedTime,
    );
    const versions = await owner.api.call('listVersions', { params: { nodeId: docId } });
    expect(versions.items.map((v) => [v.version, v.source])).toEqual([
      [2, 'web'],
      [1, 'web'],
    ]);
    expect(await (await wopi(`${docId}/contents`)).text()).toBe('yeni içerik');

    // The editor still thinks the old version is current: Collabora's "document changed".
    const stale = await wopi(`${docId}/contents`, {
      method: 'POST',
      headers: {
        'X-WOPI-Override': 'PUT',
        'X-WOPI-Lock': 'lock-a',
        'X-COOL-WOPI-Timestamp': info.LastModifiedTime,
      },
      body: 'eski',
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ COOLStatusCode: 1010 });

    const get = await wopi(docId, { method: 'POST', headers: { 'X-WOPI-Override': 'GET_LOCK' } });
    expect(get.headers.get('x-wopi-lock')).toBe('lock-a');
    const unlock = await wopi(docId, {
      method: 'POST',
      headers: { 'X-WOPI-Override': 'UNLOCK', 'X-WOPI-Lock': 'lock-a' },
    });
    expect(unlock.status).toBe(200);
    const rename = await wopi(docId, {
      method: 'POST',
      headers: { 'X-WOPI-Override': 'RENAME_FILE' },
    });
    expect(rename.status).toBe(501);
  });

  it('viewers get a read-only session and cannot save; losing access ends it', async () => {
    const session = wopiOf(
      await mert.api.call('openOfficeSession', {
        params: { nodeId: docId },
        body: { mode: 'edit' },
      }),
    );
    expect(session.mode).toBe('view');
    const viewer = session.accessToken;
    const info = (await (await wopi(docId, { token: viewer })).json()) as Record<string, unknown>;
    expect(info).toMatchObject({ UserCanWrite: false, ReadOnly: true });
    const put = await wopi(`${docId}/contents`, {
      method: 'POST',
      headers: { 'X-WOPI-Override': 'PUT' },
      body: 'x',
      token: viewer,
    });
    expect(put.status).toBe(401);
    await expectCode(
      mert.api.call('createOfficeDocument', { body: { spaceId: sharedId, kind: 'document' } }),
      403,
    );

    await owner.api.call('removeSpaceMember', { params: { spaceId: sharedId, userId: mertId } });
    expect((await wopi(docId, { token: viewer })).status).toBe(404);
  });

  it('switching the module or the setting off stops the WOPI endpoints', async () => {
    await owner.api.call('updateOfficeSettings', { body: { enabled: false } });
    expect((await wopi(docId)).status).toBe(401);
    expect((await owner.api.call('getOfficeCapabilities')).available).toBe(false);
    await owner.api.call('updateOfficeSettings', { body: { enabled: true } });
    expect((await wopi(docId)).status).toBe(200);
  });
});
