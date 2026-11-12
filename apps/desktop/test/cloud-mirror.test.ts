import type { DriveChange, DriveChangesPage, DriveNode } from '@crewhall/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { RemoteMirror, type ChangeFeed } from '../src/cloud/mirror';
import { scanRemote } from '../src/sync/remote';
import { FakeDrive } from './fake-drive';

const SPACE = 'space-1';

function row(drive: FakeDrive, path: string, type: DriveChange['type']): DriveChange {
  const n = drive.find(path)!;
  return nodeRow(type, SPACE, {
    id: n.id,
    parentId: n.parentId,
    name: n.name,
    type: n.kind,
    sizeBytes: n.content.length,
    version: n.version,
    updatedAt: n.updatedAt,
  });
}

function nodeRow(type: DriveChange['type'], spaceId: string, node: object): DriveChange {
  return {
    type,
    spaceId,
    nodeId: (node as { id: string }).id,
    node: { deletedAt: null, myRole: 'owner', ...node } as unknown as DriveNode,
    space: null,
    reason: null,
    at: '2026-11-05T10:00:00.000Z',
  };
}

function gone(type: DriveChange['type'], nodeId: string | null, spaceId = SPACE): DriveChange {
  return {
    type,
    spaceId,
    nodeId,
    node: null,
    space: null,
    reason: type === 'deleted' ? 'trashed' : null,
    at: '2026-11-05T10:00:00.000Z',
  };
}

class FakeFeed implements ChangeFeed {
  pages: DriveChangesPage[] = [];
  failure: unknown = null;
  readonly cursors: Array<string | undefined> = [];
  private n = 0;

  push(...items: DriveChange[]): void {
    this.pages.push({ items, nextCursor: `c${++this.n}`, hasMore: false });
  }

  page(cursor?: string): Promise<DriveChangesPage> {
    this.cursors.push(cursor);
    if (this.failure) return Promise.reject(this.failure as Error);
    if (cursor === undefined)
      return Promise.resolve({ items: [], nextCursor: 'head', hasMore: false });
    return Promise.resolve(this.pages.shift() ?? { items: [], nextCursor: cursor, hasMore: false });
  }
}

describe('RemoteMirror', () => {
  let drive: FakeDrive;
  let feed: FakeFeed;
  let mirror: RemoteMirror;

  /** The paths a pass would see. */
  const paths = async (space = SPACE): Promise<string[]> => {
    const { entries } = await scanRemote(mirror, space, null, 'win32');
    return [...entries.keys()].sort();
  };

  const listCalls = () => drive.calls.filter((c) => c.startsWith('list')).length;

  beforeEach(() => {
    drive = new FakeDrive();
    feed = new FakeFeed();
    mirror = new RemoteMirror(drive, feed);
  });

  it('starts from a head taken before the listing, then needs no more listings', async () => {
    drive.put('d/a.txt', 'x');
    await mirror.start([SPACE]);
    expect(feed.cursors).toEqual([undefined]);
    expect(await paths()).toEqual(['d', 'd/a.txt']);
    const before = listCalls();
    await mirror.poll();
    expect(await paths()).toEqual(['d', 'd/a.txt']);
    expect(listCalls()).toBe(before);
    expect(feed.cursors).toEqual([undefined, 'head']);
  });

  it('keeps out trash and what is not a file or folder', async () => {
    drive.put('a.txt', 'x');
    drive.put('sil.txt', 'y');
    drive.remove('sil.txt');
    drive.nodes.set('p1', {
      id: 'p1',
      parentId: null,
      name: 'sayfa',
      kind: 'other',
      content: Buffer.alloc(0),
      version: null,
      updatedAt: '2026-11-05T10:00:00.000Z',
      trashed: false,
    });
    await mirror.start([SPACE]);
    expect(await paths()).toEqual(['a.txt']);
  });

  it('refuses to answer for a space it has not loaded', async () => {
    await mirror.start([]);
    await expect(paths('baska')).rejects.toThrow('space not loaded');
  });

  it('stays unanswering when the first listing fails', async () => {
    const failing = new RemoteMirror({ list: () => Promise.reject(new Error('net')) }, feed);
    await expect(failing.start([SPACE])).rejects.toThrow('net');
    await expect(failing.list(SPACE, null)).rejects.toThrow('space not loaded');
  });

  it('takes new, changed, renamed and moved nodes from the feed', async () => {
    drive.put('a.txt', 'eski');
    drive.put('d/b.txt', 'b');
    drive.mkdir('e');
    await mirror.start([SPACE]);

    drive.put('yeni.txt', 'y');
    drive.put('a.txt', 'daha uzun içerik');
    drive.relocate('d/b.txt', 'e/c.txt');
    feed.push(
      row(drive, 'yeni.txt', 'created'),
      row(drive, 'a.txt', 'updated'),
      row(drive, 'e/c.txt', 'moved'),
    );
    const result = await mirror.poll();
    expect(await paths()).toEqual(['a.txt', 'd', 'e', 'e/c.txt', 'yeni.txt']);
    const { entries } = await scanRemote(mirror, SPACE, null, 'win32');
    expect(entries.get('a.txt')).toMatchObject({
      version: 2,
      size: Buffer.byteLength('daha uzun içerik'),
    });
    expect(result.changed).toEqual(new Set([SPACE]));
    expect(result.spacesChanged).toBe(false);
  });

  it('removes a folder with what is under it', async () => {
    drive.put('d/alt/a.txt', 'x');
    drive.put('b.txt', 'y');
    await mirror.start([SPACE]);
    feed.push(gone('deleted', drive.find('d')!.id));
    await mirror.poll();
    expect(await paths()).toEqual(['b.txt']);
  });

  it('lets a child come before its parent in a page', async () => {
    await mirror.start([SPACE]);
    drive.put('d/a.txt', 'x');
    feed.push(row(drive, 'd/a.txt', 'created'), row(drive, 'd', 'created'));
    await mirror.poll();
    expect(await paths()).toEqual(['d', 'd/a.txt']);
  });

  it('applies a change twice without harm', async () => {
    drive.put('a.txt', 'x');
    await mirror.start([SPACE]);
    drive.relocate('a.txt', 'b.txt');
    const moved = row(drive, 'b.txt', 'updated');
    feed.push(moved, moved);
    const deleted = gone('deleted', drive.find('b.txt')!.id);
    feed.push(deleted, deleted);
    await mirror.poll();
    await mirror.poll();
    expect(await paths()).toEqual([]);
  });

  it('reads on through an empty page that has more', async () => {
    await mirror.start([SPACE]);
    drive.put('a.txt', 'x');
    feed.pages.push({ items: [], nextCursor: 'c1', hasMore: true });
    feed.pages.push({ items: [row(drive, 'a.txt', 'created')], nextCursor: 'c2', hasMore: false });
    await mirror.poll();
    expect(await paths()).toEqual(['a.txt']);
    expect(feed.cursors).toEqual([undefined, 'head', 'c1']);
  });

  it('lists a folder that came into view by a move', async () => {
    drive.mkdir('kalir');
    await mirror.start([SPACE]);
    const moved = nodeRow('moved', SPACE, {
      id: 'dis',
      parentId: null,
      name: 'Gelen',
      type: 'folder',
      sizeBytes: 0,
      version: null,
      updatedAt: '2026-11-05T10:00:00.000Z',
    });
    drive.nodes.set('dis', {
      id: 'dis',
      parentId: null,
      name: 'Gelen',
      kind: 'folder',
      content: Buffer.alloc(0),
      version: null,
      updatedAt: '2026-11-05T10:00:00.000Z',
      trashed: false,
    });
    drive.nodes.set('ic', {
      id: 'ic',
      parentId: 'dis',
      name: 'ic.txt',
      kind: 'file',
      content: Buffer.from('x'),
      version: 1,
      updatedAt: '2026-11-05T10:00:00.000Z',
      trashed: false,
    });
    feed.push(moved);
    await mirror.poll();
    expect(await paths()).toEqual(['Gelen', 'Gelen/ic.txt', 'kalir']);
  });

  it('does not list a known folder again for a move', async () => {
    drive.put('d/a.txt', 'x');
    drive.mkdir('e');
    await mirror.start([SPACE]);
    drive.relocate('d', 'e/d');
    feed.push(row(drive, 'e/d', 'moved'));
    const before = listCalls();
    await mirror.poll();
    expect(listCalls()).toBe(before);
    expect(await paths()).toEqual(['e', 'e/d', 'e/d/a.txt']);
  });

  it('moves a node between spaces and loses a subtree on access lost', async () => {
    const lister = {
      list: (space: string, parent: string | null) =>
        Promise.resolve(space === 'space-1' ? [] : drive.list(space, parent)).then((n) => n),
    };
    drive.put('d/a.txt', 'x');
    mirror = new RemoteMirror(lister, feed);
    await mirror.start(['space-1', 'space-2']);
    expect(await paths('space-2')).toEqual(['d', 'd/a.txt']);

    const d = drive.find('d')!;
    feed.push(
      nodeRow('moved', 'space-1', {
        id: d.id,
        parentId: null,
        name: 'd',
        type: 'file',
        sizeBytes: 1,
        version: 1,
        updatedAt: d.updatedAt,
      }),
    );
    const result = await mirror.poll();
    expect(await paths('space-2')).toEqual([]);
    expect(await paths('space-1')).toEqual(['d']);
    expect(result.changed).toEqual(new Set(['space-1', 'space-2']));

    feed.push(gone('accessLost', d.id, 'space-1'));
    await mirror.poll();
    expect(await paths('space-1')).toEqual([]);
  });

  it('says when the spaces changed, and forgets one that is gone', async () => {
    await mirror.start([SPACE]);
    feed.push({
      type: 'spaceUpdated',
      spaceId: SPACE,
      nodeId: null,
      node: null,
      space: null,
      reason: null,
      at: '2026-11-05T10:00:00.000Z',
    });
    expect((await mirror.poll()).spacesChanged).toBe(true);
    feed.push(gone('spaceRemoved', null));
    expect((await mirror.poll()).spacesChanged).toBe(true);
    await expect(paths()).rejects.toThrow('space not loaded');
  });

  it('loses a whole space on access lost', async () => {
    await mirror.start([SPACE]);
    feed.push(gone('accessLost', null));
    expect((await mirror.poll()).spacesChanged).toBe(true);
    await expect(paths()).rejects.toThrow('space not loaded');
  });

  it('lists the space again when only shares inside it remain', async () => {
    drive.put('a.txt', 'x');
    await mirror.start([SPACE]);
    drive.put('b.txt', 'y');
    feed.push({
      type: 'accessChanged',
      spaceId: SPACE,
      nodeId: null,
      node: null,
      space: {
        id: SPACE,
        name: 'S',
        slug: 's',
        kind: 'shared',
        color: 's1',
        archived: false,
        myRole: null,
      },
      reason: null,
      at: '2026-11-05T10:00:00.000Z',
    });
    await mirror.poll();
    expect(await paths()).toEqual(['a.txt', 'b.txt']);
  });

  it('keeps its cursor when a page fails, and the next poll picks up there', async () => {
    drive.put('a.txt', 'x');
    await mirror.start([SPACE]);
    feed.failure = new TypeError('fetch failed');
    await expect(mirror.poll()).rejects.toThrow('fetch failed');
    feed.failure = null;
    await mirror.poll();
    expect(feed.cursors).toEqual([undefined, 'head', 'head']);
    expect(await paths()).toEqual(['a.txt']);
  });

  it('scans again when the cursor has expired', async () => {
    drive.put('a.txt', 'x');
    await mirror.start([SPACE]);
    drive.put('b.txt', 'y');
    drive.remove('a.txt');
    const expired = Object.assign(new Error('drive_changes_expired'), { status: 410 });
    const page = feed.page.bind(feed);
    let once = true;
    feed.page = (cursor) => {
      if (cursor === 'head' && once) {
        once = false;
        return Promise.reject(expired);
      }
      return page(cursor);
    };
    const result = await mirror.poll();
    expect(await paths()).toEqual(['b.txt']);
    expect(result.changed).toEqual(new Set([SPACE]));
    await mirror.poll();
    expect(await paths()).toEqual(['b.txt']);
  });

  it('keeps the old tree when a scan after expiry fails', async () => {
    drive.put('a.txt', 'x');
    await mirror.start([SPACE]);
    const list = drive.list.bind(drive);
    drive.list = () => Promise.reject(new Error('net'));
    const page = feed.page.bind(feed);
    feed.page = (cursor) =>
      cursor ? Promise.reject(Object.assign(new Error('expired'), { status: 410 })) : page(cursor);
    await expect(mirror.poll()).rejects.toThrow('net');
    expect(await paths()).toEqual(['a.txt']);
    drive.list = list;
  });

  describe('what this computer changes', () => {
    it('shows at once, before the feed has it', async () => {
      await mirror.start([SPACE]);
      const tracked = mirror.tracking(drive);
      const folder = await tracked.createFolder(SPACE, null, 'd');
      drive.put('kaynak.txt', 'x');
      await mirror.poll();
      expect(await paths()).toEqual(['d']);
      expect((await scanRemote(mirror, SPACE, null, 'win32')).entries.get('d')?.nodeId).toBe(
        folder.id,
      );
    });

    it('covers a move, a rename and a trash', async () => {
      drive.put('a.txt', 'x');
      drive.mkdir('d');
      await mirror.start([SPACE]);
      const tracked = mirror.tracking(drive);
      const a = drive.find('a.txt')!;
      const d = drive.find('d')!;

      await tracked.move(a.id, { spaceId: SPACE, parentId: d.id }, 'b.txt');
      expect(await paths()).toEqual(['d', 'd/b.txt']);

      await tracked.move(a.id, null, 'c.txt');
      expect(await paths()).toEqual(['d', 'd/c.txt']);

      await tracked.trash(d.id);
      expect(await paths()).toEqual([]);
    });

    it('survives a listing that began before the write', async () => {
      drive.put('a.txt', 'x');
      await mirror.start([SPACE]);
      const tracked = mirror.tracking(drive);

      // The scan after an expired cursor reads the server, then this computer creates a folder.
      const list = drive.list.bind(drive);
      let release: () => void = () => undefined;
      const hold = new Promise<void>((r) => (release = r));
      drive.list = async (space, parent) => {
        const items = await list(space, parent);
        await hold;
        return items;
      };
      const page = feed.page.bind(feed);
      let once = true;
      feed.page = (cursor) => {
        if (cursor === 'head' && once) {
          once = false;
          return Promise.reject(Object.assign(new Error('expired'), { status: 410 }));
        }
        return page(cursor);
      };
      const polling = mirror.poll();
      await new Promise((r) => setTimeout(r, 10));
      await tracked.createFolder(SPACE, null, 'sirada');
      release();
      await polling;
      drive.list = list;
      expect(await paths()).toEqual(['a.txt', 'sirada']);
    });

    it('stays out of the tree when the server refused', async () => {
      drive.put('a.txt', 'x');
      await mirror.start([SPACE]);
      drive.failMoves.add('a.txt');
      const tracked = mirror.tracking(drive);
      await expect(tracked.move(drive.find('a.txt')!.id, null, 'b.txt')).rejects.toThrow();
      expect(await paths()).toEqual(['a.txt']);
    });
  });

  it('adds and drops spaces, keeping the ones it has', async () => {
    drive.put('a.txt', 'x');
    await mirror.start([SPACE]);
    const before = listCalls();
    await mirror.setSpaces([SPACE, 'space-2']);
    expect(await paths('space-2')).toEqual(['a.txt']);
    expect(listCalls()).toBe(before + 1);
    await mirror.setSpaces(['space-2']);
    await expect(paths()).rejects.toThrow('space not loaded');
  });
});
