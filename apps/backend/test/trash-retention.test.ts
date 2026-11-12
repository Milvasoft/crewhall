import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import {
  blobs,
  boardCards,
  newId,
  nodes,
  nodeVersions,
  organizations,
  spaces,
  surfaceCards,
} from '@crewhall/db';
import { purgeTrash } from '../src/jobs/handlers';
import { createLogger } from '../src/logger';
import { sweepBoards } from '../src/services/boards/sweep';
import { Client, createTestApp, setupWithOwner, uploadFile, type TestApp } from './helpers';

const DAY = 86_400_000;

/**
 * Trash retention (roadmap 1): the org sets the days in Yönetim › Genel; the nightly jobs
 * purge each module's trash past its own org's setting, S3 objects included.
 */
describe('trash retention', () => {
  let app: TestApp;
  let owner: Client;
  let orgId: string;
  let spaceId: string;

  beforeAll(async () => {
    app = await createTestApp();
    ({ owner, orgId } = await setupWithOwner(app));
    spaceId = (await owner.api.call('listSpaces')).items.find((s) => s.name === 'Milvasoft')!.id;
  });
  afterAll(() => app.close());

  const trashedAgo = (
    table: typeof nodes | typeof boardCards | typeof surfaceCards,
    id: string,
    days: number,
  ) =>
    app.deps.db
      .update(table)
      .set({ deletedAt: new Date(Date.now() - days * DAY) })
      .where(eq(table.id, id));
  const exists = async (
    table: typeof nodes | typeof boardCards | typeof surfaceCards,
    id: string,
  ) =>
    (await app.deps.db.select({ id: table.id }).from(table).where(eq(table.id, id))).length === 1;

  it('validates the setting and shows it to clients', async () => {
    await expect(
      owner.api.call('updateOrg', { body: { settings: { trashRetentionDays: 0 } } }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    expect((await owner.api.call('me')).trashRetentionDays).toBe(30);
    await owner.api.call('updateOrg', { body: { settings: { trashRetentionDays: 7 } } });
    expect((await owner.api.call('me')).trashRetentionDays).toBe(7);
  });

  it('purges Drive items past the org retention, S3 object included, and keeps the rest', async () => {
    const old = await owner.api.call('createFolder', {
      params: { spaceId },
      body: { parentId: null, name: 'Eski klasör' },
    });
    const file = await uploadFile(owner, {
      spaceId,
      parentId: old.id,
      name: 'rapor.txt',
      content: Buffer.from('silinecek içerik'),
      mime: 'text/plain',
    });
    const recent = await owner.api.call('createFolder', {
      params: { spaceId },
      body: { parentId: null, name: 'Yeni klasör' },
    });
    await owner.api.call('trashNodes', { body: { nodeIds: [old.id, recent.id] } });
    await trashedAgo(nodes, old.id, 8);
    await app.deps.db
      .update(nodes)
      .set({ deletedAt: new Date(Date.now() - 8 * DAY) })
      .where(eq(nodes.parentId, old.id));
    await trashedAgo(nodes, recent.id, 5);

    // The trash list tells when each item goes, by the org's 7 days.
    const trash = await owner.api.call('listTrash', { params: { spaceId }, query: {} as never });
    const purgeAt = trash.items.find((i) => i.id === recent.id)!.purgeAt;
    expect(
      Date.parse(purgeAt) - Date.parse(trash.items.find((i) => i.id === recent.id)!.deletedAt!),
    ).toBe(7 * DAY);

    const [version] = await app.deps.db
      .select({ blobId: nodeVersions.blobId })
      .from(nodeVersions)
      .where(eq(nodeVersions.nodeId, file.node.id));
    const [blob] = await app.deps.db.select().from(blobs).where(eq(blobs.id, version!.blobId!));
    expect(await app.deps.storage!.head(blob!.storageKey)).not.toBeNull();

    await purgeTrash(app.deps);
    expect(await exists(nodes, old.id)).toBe(false);
    expect(await exists(nodes, file.node.id)).toBe(false);
    expect(await exists(nodes, recent.id)).toBe(true);

    // The object goes once the blob has been unreferenced for a day.
    await app.deps.db
      .update(blobs)
      .set({ orphanedAt: new Date(Date.now() - 2 * DAY) })
      .where(eq(blobs.id, blob!.id));
    await purgeTrash(app.deps);
    expect(await app.deps.db.select().from(blobs).where(eq(blobs.id, blob!.id))).toHaveLength(0);
    expect(await app.deps.storage!.head(blob!.storageKey)).toBeNull();
  });

  it('purges board cards and quick-access cards by the same setting', async () => {
    const b = await owner.api.call('createBoard', {
      params: { spaceId },
      body: { name: 'Pano' },
    });
    const detail = await owner.api.call('getBoard', { params: { boardId: b.id } });
    const [oldCard, newCard] = await Promise.all(
      ['Eski kart', 'Yeni kart'].map((title) =>
        owner.api.call('createBoardCard', {
          params: { boardId: b.id },
          body: { columnId: detail.columns[0]!.id, title } as never,
        }),
      ),
    );
    for (const c of [oldCard!, newCard!]) {
      await owner.api.call('deleteBoardCard', { params: { cardId: c.id } });
    }
    await trashedAgo(boardCards, oldCard!.id, 8);
    await trashedAgo(boardCards, newCard!.id, 6);
    await sweepBoards({ ...app.deps, logger: createLogger('silent') });
    expect(await exists(boardCards, oldCard!.id)).toBe(false);
    expect(await exists(boardCards, newCard!.id)).toBe(true);

    // The person's own quick-access surface is created on first listing.
    const surface = (await owner.api.call('listSurfaces')).items[0];
    const quick = await app.deps.db
      .insert(surfaceCards)
      .values(
        [8, 6].map((days) => ({
          orgId,
          surfaceId: surface!.id,
          type: 'note',
          x: 0,
          y: 0,
          w: 1,
          h: 1,
          config: {},
          deletedAt: new Date(Date.now() - days * DAY),
        })),
      )
      .returning({ id: surfaceCards.id });
    await purgeTrash(app.deps);
    expect(await exists(surfaceCards, quick[0]!.id)).toBe(false);
    expect(await exists(surfaceCards, quick[1]!.id)).toBe(true);
  });

  it("applies each org's own setting", async () => {
    // A second org on the default 30 days: its 10-day-old item stays, the 31-day-old one goes.
    const otherOrg = newId();
    await app.deps.db.insert(organizations).values({
      id: otherOrg,
      slug: 'baska-kurum',
      name: 'Başka Kurum',
      branding: {} as never,
      settings: {
        requireTwoFactor: false,
        defaultLocale: 'tr',
        membersCanCreateSpaces: true,
        publicLinksEnabled: true,
      },
    });
    const [space] = await app.deps.db
      .insert(spaces)
      .values({ orgId: otherOrg, kind: 'shared', name: 'Ortak', slug: 'ortak', color: 's1' })
      .returning();
    const ids = [newId(), newId()];
    await app.deps.db.insert(nodes).values(
      ids.map((id, i) => ({
        id,
        orgId: otherOrg,
        spaceId: space!.id,
        type: 'folder' as const,
        name: `Klasör ${i}`,
        position: `a${i}`,
        path: id.replaceAll('-', '_'),
        deletedAt: new Date(Date.now() - [10, 31][i]! * DAY),
      })),
    );
    await purgeTrash(app.deps);
    const left = await app.deps.db
      .select({ id: nodes.id })
      .from(nodes)
      .where(inArray(nodes.id, ids));
    expect(left.map((r) => r.id)).toEqual([ids[0]]);
  });
});
