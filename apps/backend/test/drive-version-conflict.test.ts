import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { uploads } from '@crewhall/db';
import { ApiError } from '@crewhall/api-client';
import { listen } from './chat-helpers';
import { Client, createTestApp, join, setupWithOwner, uploadFile, type TestApp } from './helpers';

/** Optimistic saves: baseVersion on uploads and If-Match on WebDAV PUT. */
describe('version conflicts', () => {
  let app: TestApp;
  let owner: Client;
  let mert: Client;
  let sharedId: string;
  let nodeId: string;

  /** Starts a one-part upload of a new version and PUTs its bytes; completing is up to the test. */
  async function stage(c: Client, text: string, baseVersion?: number) {
    const content = Buffer.from(text);
    const upload = await c.api.call('createUpload', {
      body: {
        spaceId: sharedId,
        name: 'notlar.txt',
        sizeBytes: content.length,
        nodeId,
        baseVersion,
      },
    });
    const { parts } = await c.api.call('getUploadPartUrls', {
      params: { uploadId: upload.id },
      body: { partNumbers: [1] },
    });
    const res = await fetch(parts[0]!.url, { method: 'PUT', body: content });
    const etag = res.headers.get('etag') ?? '';
    return () =>
      c.api.call('completeUpload', {
        params: { uploadId: upload.id },
        body: { parts: [{ partNumber: 1, etag }] },
      });
  }

  async function expectConflict(p: Promise<unknown>, current: number) {
    const err = await p.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(409);
    expect((err as ApiError).code).toBe('version_conflict');
    expect((err as ApiError).details).toMatchObject({ currentVersion: current });
  }

  const versions = async () =>
    (await owner.api.call('listVersions', { params: { nodeId } })).items.map((v) => v.version);

  beforeAll(async () => {
    app = await createTestApp();
    ({ owner } = await setupWithOwner(app));
    const spaces = await owner.api.call('listSpaces');
    sharedId = spaces.items.find((s) => s.name === 'Milvasoft')!.id;
    const joined = await join(app, owner, 'mert@milvasoft.com', 'member', [sharedId]);
    mert = joined.person;
    await owner.api.call('updateSpaceMember', {
      params: { spaceId: sharedId, userId: joined.me.user.id },
      body: { role: 'editor' },
    });
    const first = await uploadFile(owner, {
      spaceId: sharedId,
      name: 'notlar.txt',
      content: Buffer.from('v1'),
      mime: 'text/plain',
    });
    nodeId = first.node.id;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('two people save from the same version: the second gets 409 at completion', async () => {
    const mine = await stage(owner, 'benim', 1);
    const theirs = await stage(mert, 'onun', 1);
    expect((await mine()).version.version).toBe(2);
    await expectConflict(theirs(), 2);
    expect(await versions()).toEqual([2, 1]);
    // The losing upload is closed and its bytes are not kept.
    const aborted = await app.deps.db.select().from(uploads).where(eq(uploads.status, 'aborted'));
    expect(aborted).toHaveLength(1);
  });

  it('refuses an outdated baseVersion when the upload starts', async () => {
    await expectConflict(stage(mert, 'eski', 1), 2);
  });

  it('writes anyway without baseVersion, and with the current one', async () => {
    expect((await (await stage(mert, 'yine de'))()).version.version).toBe(3);
    expect((await (await stage(owner, 'güncel', 3))()).version.version).toBe(4);
    expect(await versions()).toEqual([4, 3, 2, 1]);
  });

  it('WebDAV PUT honours If-Match with the file ETag', async () => {
    const server = await listen(app);
    try {
      const token = (
        await owner.api.call('createMcpToken', {
          body: {
            name: 'dav',
            scopes: ['hub:read', 'drive:write'],
            spaceIds: null,
            expiresInDays: 1,
          },
        })
      ).value;
      const url = `http://127.0.0.1:${server.port}/dav/Milvasoft/notlar.txt`;
      const auth = { Authorization: `Basic ${Buffer.from(`x:${token}`).toString('base64')}` };
      const head = await fetch(url, { method: 'HEAD', headers: auth });
      const etag = head.headers.get('etag')!;
      expect(etag).toMatch(/^".+"$/);

      const stale = await fetch(url, {
        method: 'PUT',
        headers: { ...auth, 'If-Match': '"0192f1c4-0000-7000-8000-000000000000"' },
        body: 'eski',
      });
      expect(stale.status).toBe(412);
      const ok = await fetch(url, {
        method: 'PUT',
        headers: { ...auth, 'If-Match': etag },
        body: 'dav',
      });
      expect(ok.status).toBe(204);
      const again = await fetch(url, {
        method: 'PUT',
        headers: { ...auth, 'If-Match': etag },
        body: 'x',
      });
      expect(again.status).toBe(412);
      expect(await versions()).toEqual([5, 4, 3, 2, 1]);
    } finally {
      await server.close();
    }
  });
});
