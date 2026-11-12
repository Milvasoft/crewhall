import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLogs, nodes, spaces } from '@crewhall/db';
import { purgeTrash } from '../src/jobs/handlers';
import { Client, createTestApp, join, setupWithOwner, uploadFile, type TestApp } from './helpers';

let app: TestApp;
let owner: Client;
let elif: Client;

beforeAll(async () => {
  app = await createTestApp();
  ({ owner } = await setupWithOwner(app));
  elif = (await join(app, owner, 'elif@milvasoft.com', 'member')).person;
});

afterAll(async () => {
  await app.close();
});

describe('space description and visibility (design 3.2)', () => {
  it('stores them on create and update', async () => {
    const s = await owner.api.call('createSpace', {
      body: { name: 'Mobil', color: 's3', description: 'Expo uygulaması', visibility: 'org' },
    });
    expect(s).toMatchObject({ description: 'Expo uygulaması', visibility: 'org', deletedAt: null });
    const u = await owner.api.call('updateSpace', {
      params: { spaceId: s.id },
      body: { description: null, visibility: 'invite_only' },
    });
    expect(u).toMatchObject({ description: null, visibility: 'invite_only' });
    const plain = await owner.api.call('createSpace', { body: { name: 'Düz', color: 's2' } });
    expect(plain.visibility).toBe('invite_only');
  });
});

describe('deleting a space (design 03: 30 days, restorable)', () => {
  it('only the owner deletes; the space disappears and comes back', async () => {
    const s = await owner.api.call('createSpace', {
      body: { name: 'Geçici', color: 's4', members: [] },
    });
    await owner.api.call('addSpaceMember', {
      params: { spaceId: s.id },
      body: { userId: (await elif.api.call('me')).user.id, role: 'admin' },
    });
    const folder = await owner.api.call('createFolder', {
      params: { spaceId: s.id },
      body: { parentId: null, name: 'Belgeler' },
    });
    await expect(elif.api.call('deleteSpace', { params: { spaceId: s.id } })).rejects.toMatchObject(
      { status: 403 },
    );

    const deleted = await owner.api.call('deleteSpace', { params: { spaceId: s.id } });
    expect(deleted.deletedAt).not.toBeNull();
    const days =
      (new Date(deleted.purgeAt!).getTime() - new Date(deleted.deletedAt!).getTime()) / 86_400_000;
    expect(days).toBe(30);

    // Gone for everyone: lists, the space, its content.
    expect((await elif.api.call('listSpaces', { query: {} })).items.map((x) => x.id)).not.toContain(
      s.id,
    );
    await expect(elif.api.call('getSpace', { params: { spaceId: s.id } })).rejects.toMatchObject({
      status: 404,
    });
    await expect(elif.api.call('getNode', { params: { nodeId: folder.id } })).rejects.toMatchObject(
      { status: 404 },
    );
    // The owner sees it among deleted spaces; others don't.
    const mineDeleted = await owner.api.call('listSpaces', { query: { deleted: 'true' } });
    expect(mineDeleted.items.map((x) => x.id)).toEqual([s.id]);
    expect((await elif.api.call('listSpaces', { query: { deleted: 'true' } })).items).toEqual([]);
    await expect(
      elif.api.call('restoreSpace', { params: { spaceId: s.id } }),
    ).rejects.toMatchObject({ status: 404 });

    const back = await owner.api.call('restoreSpace', { params: { spaceId: s.id } });
    expect(back.deletedAt).toBeNull();
    expect((await elif.api.call('getNode', { params: { nodeId: folder.id } })).name).toBe(
      'Belgeler',
    );
    const actions = (await app.deps.db.select().from(auditLogs)).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['space.delete', 'space.restore']));
  });

  it('personal spaces cannot be deleted', async () => {
    const me = await owner.api.call('me');
    await expect(
      owner.api.call('deleteSpace', { params: { spaceId: me.personalSpaceId! } }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('the purge job removes a space after 30 days, content and blobs included', async () => {
    const s = await owner.api.call('createSpace', { body: { name: 'Eski proje', color: 's5' } });
    const file = await uploadFile(owner, {
      spaceId: s.id,
      name: 'not.txt',
      content: Buffer.from('silinecek'),
      mime: 'text/plain',
    });
    await owner.api.call('deleteSpace', { params: { spaceId: s.id } });
    await purgeTrash(app.deps);
    expect(await app.deps.db.select().from(spaces).where(eq(spaces.id, s.id))).toHaveLength(1);

    await app.deps.db.execute(
      sql`update spaces set deleted_at = now() - interval '31 days' where id = ${s.id}::uuid`,
    );
    await purgeTrash(app.deps);
    expect(await app.deps.db.select().from(spaces).where(eq(spaces.id, s.id))).toHaveLength(0);
    expect(await app.deps.db.select().from(nodes).where(eq(nodes.id, file.node.id))).toHaveLength(
      0,
    );
  });
});
