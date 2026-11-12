import { describe, expect, it } from 'vitest';
import { planLocalMoves, reconcile } from './reconcile';
import {
  localFingerprint,
  remoteFingerprint,
  type BaseEntry,
  type LocalEntry,
  type RemoteEntry,
} from './types';

const lf = (size: number, mtimeMs = 1000): LocalEntry => ({ kind: 'file', size, mtimeMs });
const ld = (): LocalEntry => ({ kind: 'folder', size: 0, mtimeMs: 0 });
const rf = (nodeId: string, size: number, version = 1): RemoteEntry => ({
  kind: 'file',
  nodeId,
  size,
  version,
  updatedAt: '2026-10-22T10:00:00.000Z',
});
const rd = (nodeId: string): RemoteEntry => ({
  kind: 'folder',
  nodeId,
  size: 0,
  version: null,
  updatedAt: '2026-10-22T10:00:00.000Z',
});
const synced = (l: LocalEntry, r: RemoteEntry): BaseEntry => ({
  kind: l.kind,
  nodeId: r.nodeId,
  local: localFingerprint(l),
  remote: remoteFingerprint(r),
});

/** Base, local and remote from [path, local, remote] rows; `inBase` rows were synced before. */
function state(
  rows: Array<
    [path: string, local?: LocalEntry, remote?: RemoteEntry, inBase?: [LocalEntry, RemoteEntry]]
  >,
) {
  const base = new Map<string, BaseEntry>();
  const local = new Map<string, LocalEntry>();
  const remote = new Map<string, RemoteEntry>();
  for (const [path, l, r, b] of rows) {
    if (l) local.set(path, l);
    if (r) remote.set(path, r);
    if (b) base.set(path, synced(b[0], b[1]));
  }
  return { base, local, remote };
}

describe('reconcile: one side changed', () => {
  it('does nothing when both sides match the base', () => {
    const s = state([
      ['a.txt', lf(3), rf('n1', 3), [lf(3), rf('n1', 3)]],
      ['docs', ld(), rd('n2'), [ld(), rd('n2')]],
    ]);
    expect(reconcile(s)).toEqual([]);
  });

  it('uploads a new local file and creates a new local folder remotely', () => {
    const s = state([
      ['docs', ld()],
      ['docs/a.txt', lf(3)],
    ]);
    expect(reconcile(s)).toEqual([
      { type: 'mkdirRemote', path: 'docs' },
      { type: 'upload', path: 'docs/a.txt' },
    ]);
  });

  it('uploads a new version when the local file changed', () => {
    const s = state([['a.txt', lf(5, 2000), rf('n1', 3), [lf(3), rf('n1', 3)]]]);
    expect(reconcile(s)).toEqual([{ type: 'upload', path: 'a.txt', nodeId: 'n1' }]);
  });

  it('downloads new and changed remote files', () => {
    const s = state([
      ['new.txt', undefined, rf('n9', 4)],
      ['a.txt', lf(3), rf('n1', 7, 2), [lf(3), rf('n1', 3)]],
      ['pics', undefined, rd('n5')],
    ]);
    expect(reconcile(s)).toEqual([
      { type: 'mkdirLocal', path: 'pics', nodeId: 'n5' },
      { type: 'download', path: 'a.txt', nodeId: 'n1' },
      { type: 'download', path: 'new.txt', nodeId: 'n9' },
    ]);
  });

  it('trashes remotely what was deleted locally, and the other way round', () => {
    const s = state([
      ['gone-here.txt', undefined, rf('n1', 3), [lf(3), rf('n1', 3)]],
      ['gone-there.txt', lf(3), undefined, [lf(3), rf('n2', 3)]],
    ]);
    expect(reconcile(s)).toEqual([
      { type: 'deleteRemote', path: 'gone-here.txt', nodeId: 'n1', kind: 'file' },
      { type: 'deleteLocal', path: 'gone-there.txt', kind: 'file' },
    ]);
  });

  it('only records the new id of a folder re-created remotely', () => {
    const s = state([['docs', ld(), rd('n7'), [ld(), rd('n2')]]]);
    expect(reconcile(s)).toEqual([{ type: 'adopt', path: 'docs' }]);
  });
});

describe('reconcile: both sides changed', () => {
  it('keeps both copies when the file changed on both sides', () => {
    const s = state([['a.txt', lf(5, 2000), rf('n1', 9, 2), [lf(3), rf('n1', 3)]]]);
    expect(reconcile(s)).toEqual([
      { type: 'conflict', path: 'a.txt', nodeId: 'n1', remoteKind: 'file' },
    ]);
  });

  it('compares contents when both sides hold a file of the same size', () => {
    const s = state([
      ['same.txt', lf(4), rf('n1', 4)],
      ['diff.txt', lf(4), rf('n2', 8)],
    ]);
    expect(reconcile(s)).toEqual([
      { type: 'conflict', path: 'diff.txt', nodeId: 'n2', remoteKind: 'file' },
      { type: 'compare', path: 'same.txt', nodeId: 'n1' },
    ]);
  });

  it('lets an edit win over a delete on the other side', () => {
    const s = state([
      ['edited-here.txt', lf(5, 2000), undefined, [lf(3), rf('n1', 3)]],
      ['edited-there.txt', undefined, rf('n2', 9, 2), [lf(3), rf('n2', 3)]],
    ]);
    expect(reconcile(s)).toEqual([
      { type: 'upload', path: 'edited-here.txt' },
      { type: 'download', path: 'edited-there.txt', nodeId: 'n2' },
    ]);
  });

  it('forgets what is gone on both sides and adopts a folder made on both', () => {
    const s = state([
      ['gone.txt', undefined, undefined, [lf(3), rf('n1', 3)]],
      ['docs', ld(), rd('n2')],
    ]);
    expect(reconcile(s)).toEqual([
      { type: 'adopt', path: 'docs' },
      { type: 'forget', path: 'gone.txt' },
    ]);
  });

  it('treats a file that became a folder as a conflict and leaves its contents for later', () => {
    const s = state([
      ['x', ld(), rf('n1', 3), [lf(3), rf('n1', 3)]],
      ['x/inner.txt', lf(1)],
    ]);
    expect(reconcile(s)).toEqual([
      { type: 'conflict', path: 'x', nodeId: 'n1', remoteKind: 'file' },
    ]);
  });
});

describe('reconcile: folders', () => {
  it('trashes a locally deleted folder with one call', () => {
    const s = state([
      ['docs', undefined, rd('n1'), [ld(), rd('n1')]],
      ['docs/a.txt', undefined, rf('n2', 3), [lf(3), rf('n2', 3)]],
      ['docs/sub', undefined, rd('n3'), [ld(), rd('n3')]],
      ['docs/sub/b.txt', undefined, rf('n4', 3), [lf(3), rf('n4', 3)]],
    ]);
    expect(reconcile(s)).toEqual([
      { type: 'deleteRemote', path: 'docs', nodeId: 'n1', kind: 'folder' },
    ]);
  });

  it('keeps a locally deleted folder when a file in it changed remotely', () => {
    const s = state([
      ['docs', undefined, rd('n1'), [ld(), rd('n1')]],
      ['docs/a.txt', undefined, rf('n2', 3), [lf(3), rf('n2', 3)]],
      ['docs/b.txt', undefined, rf('n4', 8, 2), [lf(3), rf('n4', 3)]],
    ]);
    expect(reconcile(s)).toEqual([
      { type: 'mkdirLocal', path: 'docs', nodeId: 'n1' },
      { type: 'download', path: 'docs/b.txt', nodeId: 'n4' },
      { type: 'deleteRemote', path: 'docs/a.txt', nodeId: 'n2', kind: 'file' },
    ]);
  });

  it('re-creates a remotely deleted folder when a new local file is in it', () => {
    const s = state([
      ['docs', ld(), undefined, [ld(), rd('n1')]],
      ['docs/a.txt', lf(3), undefined, [lf(3), rf('n2', 3)]],
      ['docs/new.txt', lf(1)],
    ]);
    expect(reconcile(s)).toEqual([
      { type: 'mkdirRemote', path: 'docs' },
      { type: 'upload', path: 'docs/new.txt' },
      { type: 'deleteLocal', path: 'docs/a.txt', kind: 'file' },
    ]);
  });

  it('deletes nested folders bottom-up when they are separate', () => {
    const s = state([
      ['a', ld(), rd('n1'), [ld(), rd('n1')]],
      ['a/b', undefined, rd('n2'), [ld(), rd('n2')]],
      ['c', undefined, rd('n3'), [ld(), rd('n3')]],
    ]);
    expect(reconcile(s).map((a) => a.path)).toEqual(['a/b', 'c']);
  });

  it('touches nothing under a folder that could not be read', () => {
    const s = state([
      ['locked', ld(), rd('n1'), [ld(), rd('n1')]],
      ['locked/a.txt', undefined, rf('n2', 3), [lf(3), rf('n2', 3)]],
      ['open.txt', undefined, rf('n3', 3), [lf(3), rf('n3', 3)]],
    ]);
    expect(reconcile({ ...s, frozen: ['locked'] })).toEqual([
      { type: 'deleteRemote', path: 'open.txt', nodeId: 'n3', kind: 'file' },
    ]);
  });
});

describe('planLocalMoves', () => {
  const entry = (l: LocalEntry, r: RemoteEntry, localId?: string): BaseEntry => ({
    ...synced(l, r),
    ...(localId ? { localId } : {}),
  });

  it('finds a node at a new path and leaves what is under a moved folder alone', () => {
    const f = lf(5);
    const r = rf('n2', 5);
    const moves = planLocalMoves({
      base: new Map([
        ['eski', entry(ld(), rd('n1'))],
        ['eski/a.txt', entry(f, r)],
      ]),
      local: new Map([
        ['eski', ld()],
        ['eski/a.txt', f],
      ]),
      remote: new Map([
        ['yeni', rd('n1')],
        ['yeni/a.txt', r],
      ]),
    });
    expect(moves).toEqual([{ from: 'eski', source: 'eski', to: 'yeni', kind: 'folder' }]);
  });

  it('moves nothing where the path has not changed or the node is new', () => {
    const f = lf(5);
    const r = rf('n1', 5);
    expect(
      planLocalMoves({
        base: new Map([['a.txt', entry(f, r)]]),
        local: new Map([['a.txt', f]]),
        remote: new Map([
          ['a.txt', r],
          ['b.txt', rf('n2', 1)],
        ]),
      }),
    ).toEqual([]);
  });

  it('leaves an item deleted here to the comparison', () => {
    const r = rf('n1', 5);
    expect(
      planLocalMoves({
        base: new Map([['a.txt', entry(lf(5), r)]]),
        local: new Map(),
        remote: new Map([['b.txt', r]]),
      }),
    ).toEqual([]);
  });

  it('finds an item renamed here by its identity on disk', () => {
    const f: LocalEntry = { ...lf(5), id: 'disk-1' };
    const r = rf('n1', 5);
    expect(
      planLocalMoves({
        base: new Map([['a.txt', entry(f, r, 'disk-1')]]),
        local: new Map([['benim.txt', f]]),
        remote: new Map([['sunucu.txt', r]]),
      }),
    ).toEqual([{ from: 'a.txt', source: 'benim.txt', to: 'sunucu.txt', kind: 'file' }]);
  });

  it('runs a chain from its free end', () => {
    const [f1, f2] = [lf(1), lf(2)];
    const [r1, r2] = [rf('n1', 1), rf('n2', 2)];
    const moves = planLocalMoves({
      base: new Map([
        ['a.txt', entry(f1, r1)],
        ['b.txt', entry(f2, r2)],
      ]),
      local: new Map([
        ['a.txt', f1],
        ['b.txt', f2],
      ]),
      remote: new Map([
        ['b.txt', r1],
        ['c.txt', r2],
      ]),
    });
    expect(moves.map((m) => `${m.from}>${m.to}`)).toEqual(['b.txt>c.txt', 'a.txt>b.txt']);
  });

  it('gives up on a swap: neither target comes free', () => {
    const [f1, f2] = [lf(1), lf(2)];
    const [r1, r2] = [rf('n1', 1), rf('n2', 2)];
    expect(
      planLocalMoves({
        base: new Map([
          ['a.txt', entry(f1, r1)],
          ['b.txt', entry(f2, r2)],
        ]),
        local: new Map([
          ['a.txt', f1],
          ['b.txt', f2],
        ]),
        remote: new Map([
          ['a.txt', r2],
          ['b.txt', r1],
        ]),
      }),
    ).toEqual([]);
  });

  it('touches nothing frozen', () => {
    const f = lf(5);
    const r = rf('n1', 5);
    expect(
      planLocalMoves({
        base: new Map([['d/a.txt', entry(f, r)]]),
        local: new Map([['d/a.txt', f]]),
        remote: new Map([['b.txt', r]]),
        frozen: ['d'],
      }),
    ).toEqual([]);
  });
});

describe('a folder delete with a frozen item under it', () => {
  it('waits: the folder may still hold that item', () => {
    const [f1, f2] = [lf(1), lf(2)];
    const [r1, r2] = [rf('n1', 1), rf('n2', 2)];
    const folder = rd('n0');
    const actions = reconcile({
      base: new Map([
        ['d', synced(ld(), folder)],
        ['d/kalan.txt', synced(f1, r1)],
        ['d/gider.txt', synced(f2, r2)],
      ]),
      local: new Map([
        ['d', ld()],
        ['d/kalan.txt', f1],
        ['d/gider.txt', f2],
      ]),
      remote: new Map(),
      frozen: ['d/kalan.txt'],
    });
    expect(actions).toEqual([{ type: 'deleteLocal', path: 'd/gider.txt', kind: 'file' }]);
  });
});
