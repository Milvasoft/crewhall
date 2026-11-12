import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { ApiError } from '@crewhall/api-client';
import { driveChanges, nodes, shares } from '@crewhall/db';
import type { DriveChange } from '@crewhall/shared';
import { purgeTrash } from '../src/jobs/handlers';
import { Client, createTestApp, join, setupWithOwner, uploadFile, type TestApp } from './helpers';

/** Drive change feed (listDriveChanges): what one person's sync client hears. */
describe('Drive change feed', () => {
  let app: TestApp;
  let owner: Client;
  let sharedId: string;
  let otherId: string;

  /** A sync client: holds its cursor and reads until `done` says it has what it waits for. */
  class Feed {
    cursor = '';
    constructor(
      private readonly c: Client,
      private readonly types?: string,
    ) {}
    async start() {
      const head = await this.c.api.call('listDriveChanges', { query: { types: this.types } });
      expect(head).toMatchObject({ items: [], hasMore: false });
      this.cursor = head.nextCursor;
      return this;
    }
    /** All pages from the cursor. */
    async read(limit?: number) {
      const out: DriveChange[] = [];
      for (;;) {
        const page = await this.c.api.call('listDriveChanges', {
          query: { cursor: this.cursor, limit, types: this.types },
        });
        out.push(...page.items);
        this.cursor = page.nextCursor;
        if (!page.hasMore) return out;
      }
    }
    /** Reads again for a while: another test transaction may hold the feed back a moment. */
    async until(done: (items: DriveChange[]) => boolean) {
      const all: DriveChange[] = [];
      for (let i = 0; i < 40; i++) {
        all.push(...(await this.read()));
        if (done(all)) return all;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`feed never got there: ${JSON.stringify(all.map(short))}`);
    }
  }

  const short = (c: DriveChange) => `${c.type}:${c.node?.name ?? c.nodeId ?? c.spaceId}`;
  const ofNode = (items: DriveChange[], id: string) => items.filter((c) => c.nodeId === id);
  const hasNode = (id: string, type: DriveChange['type']) => (items: DriveChange[]) =>
    items.some((c) => c.nodeId === id && c.type === type);

  const folder = async (name: string, parentId: string | null = null, spaceId = sharedId) =>
    owner.api.call('createFolder', { params: { spaceId }, body: { parentId, name } });
  const file = async (name: string, parentId: string | null = null) =>
    (
      await uploadFile(owner, {
        spaceId: sharedId,
        parentId,
        name,
        content: Buffer.from(`içerik ${name}`),
        mime: 'text/plain',
      })
    ).node;

  beforeAll(async () => {
    app = await createTestApp();
    ({ owner } = await setupWithOwner(app));
    const spaces = await owner.api.call('listSpaces');
    sharedId = spaces.items.find((s) => s.name === 'Milvasoft')!.id;
    otherId = spaces.items.find((s) => s.name === 'Altyapı')!.id;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('reports creates and content changes; only content moves the version', async () => {
    const feed = await new Feed(owner).start();
    const f = await folder('Raporlar');
    const a = await file('a.txt', f.id);
    const items = await feed.until(
      (x) => hasNode(a.id, 'created')(x) && hasNode(f.id, 'created')(x),
    );
    expect(ofNode(items, a.id).at(-1)).toMatchObject({
      type: 'created',
      spaceId: sharedId,
      space: null,
      reason: null,
      node: { id: a.id, parentId: f.id, name: 'a.txt', version: 1, sizeBytes: a.sizeBytes },
    });

    await owner.api.call('updateNode', { params: { nodeId: a.id }, body: { name: 'b.txt' } });
    const renamed = await feed.until(hasNode(a.id, 'updated'));
    expect(renamed.at(-1)).toMatchObject({ node: { name: 'b.txt', version: 1 } });

    await uploadFile(owner, {
      spaceId: sharedId,
      nodeId: a.id,
      name: 'b.txt',
      content: Buffer.from('ikinci sürüm içeriği'),
      mime: 'text/plain',
    });
    const versioned = await feed.until((x) =>
      x.some((c) => c.nodeId === a.id && c.node?.version === 2),
    );
    expect(ofNode(versioned, a.id).at(-1)?.type).toBe('updated');
  });

  it('collapses several changes of a node in a page into its current state', async () => {
    const feed = await new Feed(owner).start();
    const n = await folder('Geçici ad');
    await owner.api.call('updateNode', { params: { nodeId: n.id }, body: { name: 'Son ad' } });
    const items = await feed.until((x) => x.some((c) => c.node?.name === 'Son ad'));
    expect(ofNode(items, n.id).filter((c) => c.node?.name === 'Geçici ad')).toEqual([]);
    expect(ofNode(items, n.id)[0]).toMatchObject({ node: { name: 'Son ad' } });
  });

  it('a move inside a space is one row for the moved folder; across spaces, one per node', async () => {
    const dest = await folder('Hedef');
    const moving = await folder('Taşınan');
    const child = await folder('Alt', moving.id);
    const feed = await new Feed(owner).start();

    await owner.api.call('moveNodes', {
      body: { nodeIds: [moving.id], target: { spaceId: sharedId, parentId: dest.id } },
    });
    const items = await feed.until(hasNode(moving.id, 'moved'));
    expect(ofNode(items, moving.id).at(-1)).toMatchObject({ node: { parentId: dest.id } });
    expect(ofNode(items, child.id)).toEqual([]);

    await owner.api.call('moveNodes', {
      body: { nodeIds: [moving.id], target: { spaceId: otherId, parentId: null } },
    });
    const across = await feed.until((x) => hasNode(child.id, 'moved')(x));
    expect(ofNode(across, moving.id).at(-1)).toMatchObject({
      spaceId: otherId,
      node: { spaceId: otherId, parentId: null },
    });
    expect(ofNode(across, child.id).at(-1)).toMatchObject({
      spaceId: otherId,
      node: { parentId: moving.id },
    });
  });

  it('trash, restore and purge come for every node of the subtree', async () => {
    const root = await folder('Silinecek');
    const child = await file('içinde.txt', root.id);
    const feed = await new Feed(owner).start();

    await owner.api.call('trashNodes', { body: { nodeIds: [root.id] } });
    const trashed = await feed.until(
      (x) => hasNode(child.id, 'deleted')(x) && hasNode(root.id, 'deleted')(x),
    );
    expect(ofNode(trashed, child.id).at(-1)).toMatchObject({ reason: 'trashed', node: null });

    await owner.api.call('restoreNodes', { body: { nodeIds: [root.id] } });
    const restored = await feed.until(
      (x) => hasNode(child.id, 'created')(x) && hasNode(root.id, 'created')(x),
    );
    expect(ofNode(restored, child.id).at(-1)).toMatchObject({
      node: { id: child.id, parentId: root.id, version: 1 },
    });

    await owner.api.call('trashNodes', { body: { nodeIds: [root.id] } });
    await feed.until(hasNode(child.id, 'deleted'));
    await owner.api.call('purgeNodes', { body: { nodeIds: [root.id] } });
    const purged = await feed.until((x) =>
      x.some((c) => c.nodeId === child.id && c.reason === 'purged'),
    );
    expect(ofNode(purged, child.id).at(-1)).toMatchObject({ type: 'deleted', node: null });
  });

  it('walks in small pages and filters by node type', async () => {
    const feed = await new Feed(owner, 'folder,file').start();
    const a = await folder('Sayfalı 1');
    const b = await folder('Sayfalı 2');
    const c = await folder('Sayfalı 3');
    const wiki = await owner.api.call('createPage', {
      params: { spaceId: sharedId },
      body: { parentId: null, name: 'Süzülecek sayfa' },
    });
    await new Promise((r) => setTimeout(r, 200));
    const items = await feed.read(1);
    const ids = items.map((i) => i.nodeId);
    for (const n of [a, b, c]) expect(ids).toContain(n.id);
    expect(ids).not.toContain(wiki.id);
  });

  it('a change waits for earlier transactions and is never skipped', async () => {
    const first = await folder('Önce başlayan');
    const feed = await new Feed(owner).start();
    let commit = () => {};
    const held = new Promise<void>((r) => (commit = r));
    let written = () => {};
    const isWritten = new Promise<void>((r) => (written = r));
    const tx = app.deps.db.transaction(async (t) => {
      await t.update(nodes).set({ name: 'Geç kaydedilen' }).where(eq(nodes.id, first.id));
      written();
      await held;
    });
    await isWritten;

    // Commits first, but started later: walking it now would step past the open transaction.
    const later = await folder('Sonra başlayan');
    await new Promise((r) => setTimeout(r, 150));
    const before = await feed.read();
    expect(ofNode(before, later.id)).toEqual([]);

    commit();
    await tx;
    const items = await feed.until((x) => hasNode(later.id, 'created')(x));
    expect(ofNode(items, first.id).at(-1)).toMatchObject({ node: { name: 'Geç kaydedilen' } });
  });

  it('space membership: gained, role changed, lost, and silence afterwards', async () => {
    const joined = await join(app, owner, 'uye@milvasoft.com', 'member');
    const person = joined.person;
    const userId = joined.me.user.id;
    const feed = await new Feed(person).start();

    await owner.api.call('addSpaceMember', {
      params: { spaceId: otherId },
      body: { userId, role: 'viewer' },
    });
    const gained = await feed.until((x) =>
      x.some((c) => c.type === 'accessGained' && c.spaceId === otherId),
    );
    expect(gained.at(-1)).toMatchObject({
      nodeId: null,
      space: { id: otherId, name: 'Altyapı', kind: 'shared', myRole: 'viewer', archived: false },
    });

    await owner.api.call('updateSpaceMember', {
      params: { spaceId: otherId, userId },
      body: { role: 'editor' },
    });
    const changed = await feed.until((x) => x.some((c) => c.type === 'accessChanged'));
    expect(changed.at(-1)).toMatchObject({ spaceId: otherId, space: { myRole: 'editor' } });

    const seen = await folder('Üyeyken', null, otherId);
    await feed.until(hasNode(seen.id, 'created'));

    await owner.api.call('removeSpaceMember', { params: { spaceId: otherId, userId } });
    const lost = await feed.until((x) => x.some((c) => c.type === 'accessLost'));
    expect(lost.at(-1)).toMatchObject({ spaceId: otherId, nodeId: null, node: null, space: null });

    const unseen = await folder('Üye değilken', null, otherId);
    const marker = await folder('Görünmez işaret', null, otherId);
    await new Promise((r) => setTimeout(r, 200));
    const after = await feed.read();
    expect(ofNode(after, unseen.id)).toEqual([]);
    expect(ofNode(after, marker.id)).toEqual([]);
  });

  it('a shared folder: what is inside, moves in and out, and the end of the share', async () => {
    const joined = await join(app, owner, 'konuk@milvasoft.com', 'member');
    const userId = joined.me.user.id;
    const box = await folder('Paylaşılan', null, otherId);
    const outside = await folder('Dışarıdaki', null, otherId);
    const inside = await folder('İçerideki', box.id, otherId);
    const feed = await new Feed(joined.person).start();

    const share = await owner.api.call('createShare', {
      params: { nodeId: box.id },
      body: { kind: 'user', userId, role: 'viewer' },
    });
    const gained = await feed.until(hasNode(box.id, 'accessGained'));
    // The parent is out of view, so the row itself has to say where and what it is.
    expect(ofNode(gained, box.id).at(-1)).toMatchObject({
      spaceId: otherId,
      node: { id: box.id, name: 'Paylaşılan', myRole: 'viewer' },
    });

    // Nothing outside the share is heard.
    await owner.api.call('updateNode', { params: { nodeId: outside.id }, body: { name: 'Dış 2' } });
    await owner.api.call('updateNode', { params: { nodeId: inside.id }, body: { name: 'İç 2' } });
    const seen = await feed.until(hasNode(inside.id, 'updated'));
    expect(ofNode(seen, outside.id)).toEqual([]);

    // Into the shared folder: sent, although the person could not see it before.
    await owner.api.call('moveNodes', {
      body: { nodeIds: [outside.id], target: { spaceId: otherId, parentId: box.id } },
    });
    const movedIn = await feed.until(hasNode(outside.id, 'moved'));
    expect(ofNode(movedIn, outside.id).at(-1)).toMatchObject({ node: { parentId: box.id } });

    // Out of it again: gone for them, with no details of where it went.
    await owner.api.call('moveNodes', {
      body: { nodeIds: [outside.id], target: { spaceId: otherId, parentId: null } },
    });
    const movedOut = await feed.until(hasNode(outside.id, 'deleted'));
    expect(ofNode(movedOut, outside.id).at(-1)).toMatchObject({
      reason: 'access_lost',
      node: null,
      spaceId: otherId,
    });

    // A move elsewhere outside their view, of something they never saw: not a word.
    const never = await folder('Hiç görmediği', null, otherId);
    await owner.api.call('moveNodes', {
      body: { nodeIds: [never.id], target: { spaceId: otherId, parentId: outside.id } },
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(ofNode(await feed.read(), never.id)).toEqual([]);

    // The shared folder trashed: they hear it, and it comes back with a restore.
    await owner.api.call('trashNodes', { body: { nodeIds: [box.id] } });
    const trashed = await feed.until(hasNode(box.id, 'deleted'));
    expect(ofNode(trashed, box.id).at(-1)).toMatchObject({ reason: 'trashed' });
    await owner.api.call('restoreNodes', { body: { nodeIds: [box.id] } });
    await feed.until(hasNode(box.id, 'created'));

    await owner.api.call('updateShare', {
      params: { shareId: share.id },
      body: { role: 'editor' },
    });
    const role = await feed.until(hasNode(box.id, 'accessChanged'));
    expect(ofNode(role, box.id).at(-1)).toMatchObject({ node: { myRole: 'editor' } });

    await owner.api.call('deleteShare', { params: { shareId: share.id } });
    const lost = await feed.until(hasNode(box.id, 'accessLost'));
    expect(ofNode(lost, box.id).at(-1)).toMatchObject({ spaceId: otherId, node: null });
  });

  it('a share that runs out or goes with a purge is a loss too', async () => {
    const joined = await join(app, owner, 'sureli@milvasoft.com', 'member');
    const userId = joined.me.user.id;
    const timed = await folder('Süreli', null, otherId);
    const purged = await folder('Yok edilecek', null, otherId);
    // In a default space the person belongs to: the share ending takes nothing away.
    const stillSeen = await folder('Üyelikle de görünen');
    for (const n of [timed, purged, stillSeen]) {
      await owner.api.call('createShare', {
        params: { nodeId: n.id },
        body: { kind: 'user', userId, role: 'viewer' },
      });
    }
    // Directly and before the head: from here on the time passes with no write, as in real life.
    await app.deps.db
      .update(shares)
      .set({ expiresAt: new Date(Date.now() + 400) })
      .where(inArray(shares.nodeId, [timed.id, stillSeen.id]));
    const feed = await new Feed(joined.person).start();
    await new Promise((r) => setTimeout(r, 600));
    const expired = await feed.until(hasNode(timed.id, 'accessLost'));
    expect(ofNode(expired, stillSeen.id).at(-1)).toMatchObject({
      type: 'accessChanged',
      node: { id: stillSeen.id, myRole: 'viewer' },
    });
    expect(ofNode(expired, timed.id).at(-1)).toMatchObject({ spaceId: otherId, node: null });

    await owner.api.call('trashNodes', { body: { nodeIds: [purged.id] } });
    await feed.until(hasNode(purged.id, 'deleted'));
    await owner.api.call('purgeNodes', { body: { nodeIds: [purged.id] } });
    const gone = await feed.until(hasNode(purged.id, 'accessLost'));
    expect(ofNode(gone, purged.id).at(-1)).toMatchObject({ spaceId: otherId });
  });

  it('space changes: renamed, archived, deleted, restored', async () => {
    const s = await owner.api.call('createSpace', {
      body: { name: 'Geçici alan', color: 's3' },
    });
    const feed = await new Feed(owner).start();
    await owner.api.call('updateSpace', { params: { spaceId: s.id }, body: { name: 'Yeni ad' } });
    const renamed = await feed.until((x) =>
      x.some((c) => c.type === 'spaceUpdated' && c.spaceId === s.id),
    );
    expect(renamed.at(-1)).toMatchObject({ space: { name: 'Yeni ad', archived: false } });

    await owner.api.call('deleteSpace', { params: { spaceId: s.id } });
    const removed = await feed.until((x) =>
      x.some((c) => c.type === 'spaceRemoved' && c.spaceId === s.id),
    );
    expect(removed.at(-1)).toMatchObject({ nodeId: null, space: null });

    await owner.api.call('restoreSpace', { params: { spaceId: s.id } });
    const back = await feed.until((x) =>
      x.some((c) => c.type === 'accessGained' && c.spaceId === s.id),
    );
    expect(back.at(-1)).toMatchObject({ space: { name: 'Yeni ad', myRole: 'owner' } });
  });

  it('a personal token hears only its own spaces', async () => {
    const created = await owner.api.call('createMcpToken', {
      body: { name: 'sync', scopes: ['hub:read'], spaceIds: [otherId], expiresInDays: 1 },
    });
    const client = new Client(app);
    client.bearer = created.value;
    const feed = await new Feed(client).start();
    const hidden = await folder('Token dışı');
    const seen = await folder('Token içi', null, otherId);
    const items = await feed.until(hasNode(seen.id, 'created'));
    expect(ofNode(items, hidden.id)).toEqual([]);
  });

  it('expired and foreign cursors: 410 to rescan, 400 for garbage', async () => {
    const cursorOf = (x: number, t: number) =>
      Buffer.from(JSON.stringify({ v: 1, x, s: 0, t })).toString('base64url');
    const read = (cursor: string) =>
      owner.api.call('listDriveChanges', { query: { cursor } }).then(
        () => null,
        (e: unknown) => e as ApiError,
      );

    const old = await read(cursorOf(1, Date.now() - 31 * 24 * 60 * 60 * 1000));
    expect(old).toMatchObject({ status: 410, code: 'drive_changes_expired' });
    // Further along than this server has ever been: a cursor from before a restore.
    const future = await read(cursorOf(Number.MAX_SAFE_INTEGER, Date.now()));
    expect(future).toMatchObject({ status: 410, code: 'drive_changes_expired' });
    expect(await read('çöp')).toMatchObject({ status: 400 });
  });

  it('the nightly job drops the log past its retention', async () => {
    const n = await folder('Eski kayıt');
    await app.deps.db
      .update(driveChanges)
      .set({ at: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) })
      .where(eq(driveChanges.nodeId, n.id));
    await purgeTrash(app.deps);
    const left = await app.deps.db.select().from(driveChanges).where(eq(driveChanges.nodeId, n.id));
    expect(left).toEqual([]);
  });
});
