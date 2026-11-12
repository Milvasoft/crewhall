import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { shares } from '@crewhall/db';
import { decryptShareToken, encryptShareToken } from '../src/services/drive/share-token';
import { Client, createTestApp, join, setupWithOwner, type TestApp } from './helpers';

let app: TestApp;
let owner: Client;
let spaceId: string;
let folderId: string;

const tokenOf = (url: string) => decodeURIComponent(new URL(url).pathname.split('/').pop()!);

beforeAll(async () => {
  app = await createTestApp();
  ({ owner } = await setupWithOwner(app));
  spaceId = (await owner.api.call('listSpaces', { query: {} })).items.find(
    (s) => s.name === 'Milvasoft',
  )!.id;
  folderId = (
    await owner.api.call('createFolder', {
      params: { spaceId },
      body: { parentId: null, name: 'Paylaşılan' },
    })
  ).id;
});

afterAll(async () => {
  await app.close();
});

describe('share links can be shown again (H16)', () => {
  it('keeps the token encrypted and shows the same address in the list', async () => {
    const created = await owner.api.call('createShare', {
      params: { nodeId: folderId },
      body: { kind: 'link' },
    });
    expect(created.url).toBeTruthy();
    const [row] = await app.deps.db.select().from(shares).where(eq(shares.id, created.id));
    // Stored encrypted, never in clear; the hash still finds the link.
    expect(row!.tokenEnc).toBeTruthy();
    expect(row!.tokenEnc).not.toContain(tokenOf(created.url!));
    const list = await owner.api.call('listShares', { params: { nodeId: folderId } });
    const link = list.items.find((s) => s.id === created.id)!;
    expect(link.url).toBe(created.url);
    expect(link.urlLost).toBeUndefined();
    // The listed address opens the link.
    const pub = await new Client(app).api.call('getPublicShare', {
      params: { token: tokenOf(link.url!) },
      query: {},
    });
    expect(pub.status).toBe('ok');
  });

  it('shows the address only to the maker and people who may share links', async () => {
    const viewer = await join(app, owner, 'izleyen@milvasoft.com', 'member', [spaceId]);
    const list = await viewer.person.api.call('listShares', { params: { nodeId: folderId } });
    const link = list.items.find((s) => s.kind === 'link')!;
    expect(link.url).toBeUndefined();
    expect(link.urlLost).toBeUndefined();
  });

  it('marks links made before stored tokens, and regenerating brings a copyable one', async () => {
    const created = await owner.api.call('createShare', {
      params: { nodeId: folderId },
      body: { kind: 'link' },
    });
    // As a pre-H16 link: only the hash exists.
    await app.deps.db.update(shares).set({ tokenEnc: null }).where(eq(shares.id, created.id));
    const before = (
      await owner.api.call('listShares', { params: { nodeId: folderId } })
    ).items.find((s) => s.id === created.id)!;
    expect(before.url).toBeUndefined();
    expect(before.urlLost).toBe(true);
    const fresh = await owner.api.call('regenerateShareLink', { params: { shareId: created.id } });
    const after = (await owner.api.call('listShares', { params: { nodeId: folderId } })).items.find(
      (s) => s.id === created.id,
    )!;
    expect(after.url).toBe(fresh.url);
    expect(after.urlLost).toBeUndefined();
    // The old address stops working, as before.
    await expect(
      new Client(app).api.call('getPublicShare', {
        params: { token: tokenOf(created.url!) },
        query: {},
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('cannot read tokens sealed with another AUTH_SECRET', () => {
    const sealed = encryptShareToken('a'.repeat(32), 'secret-token');
    expect(decryptShareToken('a'.repeat(32), sealed)).toBe('secret-token');
    expect(decryptShareToken('b'.repeat(32), sealed)).toBeNull();
    // Flip a byte in the middle of the decoded value: swapping the last base64url characters
    // can leave the bytes unchanged (the final character carries unused bits).
    const bytes = Buffer.from(sealed, 'base64url');
    const mid = Math.floor(bytes.length / 2);
    bytes[mid] = bytes[mid]! ^ 0xff;
    expect(decryptShareToken('a'.repeat(32), bytes.toString('base64url'))).toBeNull();
  });
});
