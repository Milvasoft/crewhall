import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { jwtVerify, SignJWT } from 'jose';
import { unzipSync } from 'fflate';
import { ApiError } from '@crewhall/api-client';
import type { OfficeSession } from '@crewhall/shared';
import { Client, createTestApp, join, setupWithOwner, type TestApp } from './helpers';

/** Document Server API path (Euro-Office, ONLYOFFICE Docs) against a stub server. */
const SECRET = 'euro-office-test-secret-0123456789abcdef';
const key = new TextEncoder().encode(SECRET);

function ooOf(s: OfficeSession) {
  if (s.kind !== 'onlyoffice') throw new Error(`expected an onlyoffice session, got ${s.kind}`);
  return s;
}

interface Config {
  token: string;
  document: { key: string; url: string; fileType: string; permissions: { edit: boolean } };
  documentType: string;
  editorConfig: { mode: string; lang: string; callbackUrl?: string; user: { id: string } };
}

describe('office module (Document Server API)', () => {
  let app: TestApp;
  let owner: Client;
  let ownerId: string;
  let mert: Client;
  let sharedId: string;
  let stub: Server;
  let base: string;
  let docId: string;
  let saved = 'ilk kayıt';

  const local = (url: string, init?: RequestInit) => app.app.request(url, init);

  /** The server's callback: body signed in the Authorization header (default JWT_HEADER). */
  async function callback(url: string, body: Record<string, unknown>, secret = key) {
    const jwt = await new SignJWT({ payload: body })
      .setProtectedHeader({ alg: 'HS256' })
      .sign(secret);
    const res = await local(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as { error: number } };
  }

  async function open(c: Client, nodeId: string) {
    const s = ooOf(
      await c.api.call('openOfficeSession', { params: { nodeId }, body: { mode: 'edit' } }),
    );
    const { payload } = await jwtVerify(s.config.token as string, key);
    return { s, config: payload as unknown as Config };
  }

  const versions = async () =>
    (await owner.api.call('listVersions', { params: { nodeId: docId } })).items.map(
      (v) => v.version,
    );

  beforeAll(async () => {
    stub = createServer((req, res) => {
      if (req.url === '/healthcheck') return void res.end('true');
      if (req.url === '/cache/saved.docx') return void res.end(saved);
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
    app = await createTestApp();
    const setup = await setupWithOwner(app);
    owner = setup.owner;
    ownerId = setup.ownerId;
    const spaces = await owner.api.call('listSpaces');
    sharedId = spaces.items.find((s) => s.name === 'Milvasoft')!.id;
    mert = (await join(app, owner, 'mert@milvasoft.com', 'member', [sharedId])).person;
  });

  afterAll(async () => {
    await app?.close();
    await new Promise((r) => stub?.close(r));
  });

  it('needs the shared JWT secret and never shows it back', async () => {
    const err = await owner.api
      .call('updateOfficeSettings', { body: { enabled: true, serverUrl: base } })
      .catch((e: unknown) => e);
    expect((err as ApiError).code).toBe('validation_failed');
    const s = await owner.api.call('updateOfficeSettings', {
      body: { enabled: true, serverType: 'onlyoffice', serverUrl: base, jwtSecret: SECRET },
    });
    expect(s).toMatchObject({ serverType: 'onlyoffice', jwtSecret: { set: true, hint: 'cdef' } });
    expect(JSON.stringify(s)).not.toContain(SECRET);
    expect(await owner.api.call('testOfficeSettings')).toMatchObject({
      ok: true,
      edit: ['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp'],
    });
    expect((await mert.api.call('getOfficeCapabilities')).available).toBe(true);
  });

  it('opens a signed editor config; the server downloads the file with its own token', async () => {
    docId = (
      await owner.api.call('createOfficeDocument', {
        body: { spaceId: sharedId, kind: 'presentation' },
      })
    ).id;
    const { s, config } = await open(owner, docId);
    expect(s.apiUrl).toBe(`${base}/web-apps/apps/api/documents/api.js`);
    expect(s.editorOrigin).toBe(base);
    expect(config).toMatchObject({
      documentType: 'slide',
      document: { fileType: 'pptx', permissions: { edit: true } },
      editorConfig: { mode: 'edit', user: { id: ownerId } },
    });
    expect(config.editorConfig.callbackUrl).toContain('/api/office/callback/');

    const file = await local(config.document.url);
    expect(file.status).toBe(200);
    expect(Object.keys(unzipSync(new Uint8Array(await file.arrayBuffer())))).toContain(
      'ppt/presentation.xml',
    );
    // The download token is not a save token, and the reverse.
    const saveAsFile = config.editorConfig
      .callbackUrl!.replace('/callback/', '/files/')
      .replace('?', '/content?');
    expect((await local(saveAsFile)).status).toBe(401);

    // Everyone editing the same version shares one key.
    expect((await open(owner, docId)).config.document.key).toBe(config.document.key);
  });

  it('saves force-saves and the final save as Drive versions, keeping the key in between', async () => {
    const { config } = await open(owner, docId);
    const url = config.editorConfig.callbackUrl!;
    const k = config.document.key;
    expect((await callback(url, { key: k, status: 1, users: [ownerId] })).body).toEqual({
      error: 0,
    });

    const forced = await callback(url, {
      key: k,
      status: 6,
      url: `${base}/cache/saved.docx`,
      users: [ownerId],
    });
    expect(forced.body).toEqual({ error: 0 });
    expect(await versions()).toEqual([2, 1]);
    expect((await open(owner, docId)).config.document.key).toBe(k);

    saved = 'son kayıt';
    expect(
      (
        await callback(url, {
          key: k,
          status: 2,
          url: `${base}/cache/saved.docx`,
          users: [ownerId],
        })
      ).body,
    ).toEqual({ error: 0 });
    expect(await versions()).toEqual([3, 2, 1]);
    const v = await owner.api.call('listVersions', { params: { nodeId: docId } });
    expect(v.items[0]).toMatchObject({ source: 'web', createdBy: { id: ownerId } });
    // A finished session: the next opening gets a new key.
    expect((await open(owner, docId)).config.document.key).not.toBe(k);
  });

  it('refuses callbacks without the server signature or from elsewhere', async () => {
    const { config } = await open(owner, docId);
    const url = config.editorConfig.callbackUrl!;
    const k = config.document.key;
    const forged = await callback(
      url,
      { key: k, status: 2, url: `${base}/cache/saved.docx` },
      new TextEncoder().encode('another-secret-0123456789abcdef0123456789'),
    );
    expect(forged).toEqual({ status: 401, body: { error: 1 } });
    const elsewhere = await callback(url, {
      key: k,
      status: 6,
      url: 'http://169.254.169.254/latest/meta-data',
      users: [ownerId],
    });
    expect(elsewhere.body).toEqual({ error: 1 });
    expect(await versions()).toEqual([3, 2, 1]);
  });

  it('viewers open read-only without a callback', async () => {
    const { s, config } = await open(mert, docId);
    expect(s.mode).toBe('view');
    expect(config.editorConfig.mode).toBe('view');
    expect(config.editorConfig.callbackUrl).toBeUndefined();
    expect(config.document.permissions.edit).toBe(false);
  });
});
