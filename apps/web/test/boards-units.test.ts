import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { type BoardCard } from '@crewhall/shared';
import { parseQuickCard } from '@/lib/boards/composer';
import { dueState, matches } from '@/lib/boards/filters';
import { handleBoardsEvent } from '@/lib/boards/realtime';
import { isNewer, SceneSync, type SceneElement } from '@/lib/boards/sceneSync';

const el = (id: string, version: number, extra: Partial<SceneElement> = {}): SceneElement => ({
  id,
  type: 'rectangle',
  version,
  versionNonce: version,
  index: `a${id}`,
  x: 0,
  ...extra,
});

/** Two clients wired like through the collab server: updates flow both ways. */
function pair() {
  const a = new Y.Doc();
  const b = new Y.Doc();
  a.on(
    'update',
    (u: Uint8Array, origin: unknown) => origin !== 'remote' && Y.applyUpdate(b, u, 'remote'),
  );
  b.on(
    'update',
    (u: Uint8Array, origin: unknown) => origin !== 'remote' && Y.applyUpdate(a, u, 'remote'),
  );
  const client = (doc: Y.Doc) => {
    let scene: SceneElement[] = [];
    const sync = new SceneSync(
      doc,
      () => scene,
      (elements) => {
        scene = elements;
      },
    );
    return {
      sync,
      scene: () => scene,
      edit(changed: SceneElement[]) {
        const map = new Map(scene.map((e) => [e.id, e]));
        for (const c of changed) map.set(c.id, c);
        scene = [...map.values()];
        sync.pushLocal(scene);
      },
    };
  };
  return { a: client(a), b: client(b), docs: [a, b] as const };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('drawing scene sync (Yjs)', () => {
  it('higher version wins, ties go to the lower nonce', () => {
    expect(isNewer(el('x', 2), el('x', 1))).toBe(true);
    expect(isNewer(el('x', 1), el('x', 2))).toBe(false);
    expect(isNewer(el('x', 1, { versionNonce: 3 }), el('x', 1, { versionNonce: 9 }))).toBe(true);
    expect(isNewer(el('x', 1), undefined)).toBe(true);
  });

  it('two clients drawing at once converge on every element', async () => {
    const { a, b } = pair();
    a.edit([el('api', 1)]);
    b.edit([el('db', 1)]);
    await tick();
    expect(
      a
        .scene()
        .map((e) => e.id)
        .sort(),
    ).toEqual(['api', 'db']);
    expect(
      b
        .scene()
        .map((e) => e.id)
        .sort(),
    ).toEqual(['api', 'db']);
  });

  it('concurrent edits of one element keep the newer version on both sides', async () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    let sceneA: SceneElement[] = [];
    let sceneB: SceneElement[] = [];
    const syncA = new SceneSync(
      a,
      () => sceneA,
      (e) => (sceneA = e),
    );
    const syncB = new SceneSync(
      b,
      () => sceneB,
      (e) => (sceneB = e),
    );
    sceneA = [el('box', 1)];
    syncA.pushLocal(sceneA);
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a), 'remote');
    // Offline at the same time: A moves to version 2, B to version 5.
    sceneA = [el('box', 2, { x: 50 })];
    syncA.pushLocal(sceneA);
    sceneB = [el('box', 5, { x: 80 })];
    syncB.pushLocal(sceneB);
    // Reconnect: exchange both ways (whichever Yjs keeps, the newer one is re-asserted).
    const ua = Y.encodeStateAsUpdate(a);
    const ub = Y.encodeStateAsUpdate(b);
    Y.applyUpdate(a, ub, 'remote');
    Y.applyUpdate(b, ua, 'remote');
    await tick();
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b), 'remote');
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a), 'remote');
    await tick();
    const final = (d: Y.Doc) => (d.getMap('elements').get('box') as SceneElement).x;
    expect(final(a)).toBe(80);
    expect(final(b)).toBe(80);
    expect(sceneA.find((e) => e.id === 'box')?.x).toBe(80);
  });

  it('does not write elements that did not change', () => {
    const doc = new Y.Doc();
    const sync = new SceneSync(
      doc,
      () => [],
      () => undefined,
    );
    let updates = 0;
    doc.on('update', () => updates++);
    expect(sync.pushLocal([el('a', 1)])).toBe(1);
    expect(sync.pushLocal([el('a', 1)])).toBe(0);
    expect(updates).toBe(1);
  });
});

const card = (over: Partial<BoardCard>): BoardCard => ({
  id: 'c',
  boardId: 'b',
  columnId: 'col',
  number: 142,
  position: 'a',
  title: 'SSO ile giriş (OIDC)',
  excerpt: 'Authorization Code + PKCE',
  labels: [],
  assignees: [],
  dueAt: null,
  points: null,
  priority: null,
  checklist: { done: 0, total: 0 },
  commentCount: 0,
  attachmentCount: 0,
  conversationId: null,
  doneAt: null,
  archivedAt: null,
  createdBy: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...over,
});

describe('board filters', () => {
  const me = { id: 'u1', name: 'Ahmet Buğra Kösen', email: 'bugra@x.com', imageUrl: null };
  const ctx = { meId: 'u1', key: 'MLV', now: Date.parse('2026-10-20T10:00:00Z') };

  it('person filter: "ben", "yok" and ids', () => {
    expect(matches(card({ assignees: [me] }), { person: ['me'] }, ctx)).toBe(true);
    expect(matches(card({}), { person: ['me'] }, ctx)).toBe(false);
    expect(matches(card({}), { person: ['none'] }, ctx)).toBe(true);
    expect(matches(card({ assignees: [me] }), { person: ['u1'] }, ctx)).toBe(true);
  });

  it('due filter and search by key, title and description (Turkish case)', () => {
    const late = card({ dueAt: '2026-10-19T10:00:00Z' });
    expect(matches(late, { date: 'overdue' }, ctx)).toBe(true);
    expect(matches(late, { date: 'none' }, ctx)).toBe(false);
    expect(matches(card({}), { q: 'mlv-142' }, ctx)).toBe(true);
    expect(matches(card({}), { q: 'GİRİŞ pkce' }, ctx)).toBe(true);
    expect(matches(card({}), { q: 'kasa' }, ctx)).toBe(false);
  });

  it('due state: warning when close, danger when past', () => {
    const now = Date.parse('2026-10-20T10:00:00Z');
    expect(dueState('2026-10-21T10:00:00Z', now)?.tone).toBe('warn');
    expect(dueState('2026-10-30T10:00:00Z', now)?.tone).toBe('none');
    expect(dueState('2026-10-18T10:00:00Z', now)).toEqual({ tone: 'danger', days: 2 });
  });
});

describe('quick card entry', () => {
  it('takes #label and @person out of the title', () => {
    const labels = [
      { id: 'l1', name: 'Backend', color: 's1' as const },
      { id: 'l2', name: 'Güvenlik', color: 'danger' as const },
    ];
    const people = [{ id: 'u3', name: 'Can Demir', email: 'can@milvasoft.com', imageUrl: null }];
    expect(parseQuickCard('Mobilde PDF boş #backend @can #güv', labels, people)).toEqual({
      title: 'Mobilde PDF boş',
      labels: ['l1', 'l2'],
      assigneeIds: ['u3'],
    });
    expect(parseQuickCard('#yok etiket', labels, people).title).toBe('#yok etiket');
  });
});

describe('board events from the WebSocket', () => {
  const seeded = (rev: number) => {
    const qc = new QueryClient();
    qc.setQueryData(['boards', 'board', 'b1'], { board: { rev } } as never);
    qc.setQueryData(['boards', 'card', 'c1'], { id: 'c1' });
    return qc;
  };
  const stale = (qc: QueryClient, key: readonly unknown[]) =>
    qc.getQueryState(key)?.isInvalidated ?? false;

  it('refetches a board whose cached revision is behind, and the open card', () => {
    const qc = seeded(4);
    handleBoardsEvent(qc, { type: 'board.changed', boardId: 'b1', rev: 5 });
    expect(stale(qc, ['boards', 'board', 'b1'])).toBe(true);
    expect(stale(qc, ['boards', 'card', 'c1'])).toBe(true);
  });

  it('leaves a board alone when it already has that revision (own write)', () => {
    const qc = seeded(5);
    handleBoardsEvent(qc, { type: 'board.changed', boardId: 'b1', rev: 5 });
    expect(stale(qc, ['boards', 'board', 'b1'])).toBe(false);
    expect(stale(qc, ['boards', 'card', 'c1'])).toBe(false);
  });
});
