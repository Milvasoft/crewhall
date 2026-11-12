import { createServer } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { HocuspocusProvider } from '@hocuspocus/provider';
import type { Server } from '@hocuspocus/server';
import * as Y from 'yjs';
import { boardCards, drawings, organizations } from '@crewhall/db';
import { createLogger } from '../src/logger';
import { startBoardsCollab } from '../src/services/boards/dev-collab';
import { forgetBoardsSwitch } from '../src/services/boards/module';
import {
  descriptionText,
  docFrom,
  ELEMENTS_MAP,
  mergeElements,
  sceneElements,
  setDescription,
  type Element,
} from '../src/services/boards/ydoc';
import { Client, createTestApp, join, setupWithOwner, type TestApp } from './helpers';

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

const until = async (cond: () => boolean | Promise<boolean>, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error('condition not met in time');
};

const el = (id: string, version: number, extra: Record<string, unknown> = {}): Element => ({
  id,
  type: 'rectangle',
  version,
  versionNonce: version,
  index: `a${id}`,
  x: 0,
  y: 0,
  width: 100,
  height: 60,
  ...extra,
});

describe('collaborative drawings and card descriptions (Yjs)', () => {
  let app: TestApp;
  let owner: Client;
  let mert: Awaited<ReturnType<typeof join>>;
  let selin: Awaited<ReturnType<typeof join>>;
  let spaceId: string;
  let server: Server;
  let url: string;
  const providers: HocuspocusProvider[] = [];

  beforeAll(async () => {
    app = await createTestApp();
    ({ owner } = await setupWithOwner(app));
    spaceId = (await owner.api.call('listSpaces')).items.find((s) => s.isDefault)!.id;
    mert = await join(app, owner, 'mert@milvasoft.com', 'member');
    selin = await join(app, owner, 'selin@milvasoft.com', 'member');
    // Invited people join default spaces as viewers.
    await owner.api.call('updateSpaceMember', {
      params: { spaceId, userId: mert.me.user.id },
      body: { role: 'editor' },
    });
    await owner.api.call('updateSpaceMember', {
      params: { spaceId, userId: selin.me.user.id },
      body: { role: 'viewer' },
    });
    const port = await freePort();
    server = await startBoardsCollab({
      db: app.deps.db,
      jobs: app.deps.jobs,
      secret: app.env.AUTH_SECRET,
      logger: createLogger(process.env.TEST_LOG_LEVEL ?? 'silent'),
      port,
      debounce: 50,
    });
    url = `ws://127.0.0.1:${port}`;
  });
  afterAll(async () => {
    for (const p of providers) p.destroy();
    await server.destroy();
    await app.close();
  });

  /**
   * What the web binding does: Yjs keeps one of two concurrent writes of a key by client
   * id, so a client whose local element is newer (Excalidraw version) writes it again.
   * Every client agrees on the highest version and the scene converges.
   */
  function reassertNewer(doc: Y.Doc) {
    const local = new Map<string, Element>();
    const map = doc.getMap<Element>(ELEMENTS_MAP);
    for (const [k, v] of map) local.set(k, v);
    map.observe((event, tx) => {
      if (tx.origin === 'local') return;
      const again: Element[] = [];
      for (const key of event.keysChanged) {
        const remote = map.get(key);
        const mine = local.get(key);
        if (
          remote &&
          (!mine ||
            remote.version > mine.version ||
            (remote.version === mine.version &&
              (remote.versionNonce ?? 0) <= (mine.versionNonce ?? 0)))
        ) {
          local.set(key, remote);
        } else if (mine) {
          again.push(mine);
        }
      }
      if (again.length) {
        queueMicrotask(() => doc.transact(() => again.forEach((e) => map.set(e.id, e)), 'local'));
      }
    });
    return (elements: Element[]) => {
      for (const e of elements) local.set(e.id, e);
      mergeElements(doc, elements, 'local');
    };
  }

  async function connect(c: Client, document: string) {
    const t = await c.api.call('createBoardsCollabToken', { body: { document } });
    const doc = new Y.Doc();
    let failed = false;
    const provider = new HocuspocusProvider({
      url,
      name: document,
      document: doc,
      token: t.token,
      onAuthenticationFailed: () => {
        failed = true;
      },
    });
    providers.push(provider);
    await until(() => provider.isSynced || failed);
    return { doc, provider, readOnly: t.readOnly, failed: () => failed };
  }

  it('two clients edit the same drawing at once; elements merge and are stored', async () => {
    const d = await owner.api.call('createDrawing', {
      params: { spaceId },
      body: { name: 'Ortak çizim' },
    });
    // Something already stored over HTTP shows up for both.
    await owner.api.call('saveDrawingScene', {
      params: { nodeId: d.id },
      body: { elements: [el('base', 1)] },
    });
    const a = await connect(owner, `drawing:${d.id}`);
    const b = await connect(mert.person, `drawing:${d.id}`);
    expect(sceneElements(a.doc).map((e) => e.id)).toEqual(['base']);
    expect(sceneElements(b.doc).map((e) => e.id)).toEqual(['base']);

    // Concurrent: each adds its own element and both move `base`; Mert's edit is newer.
    const editA = reassertNewer(a.doc);
    const editB = reassertNewer(b.doc);
    editA([el('api', 1), el('base', 2, { x: 50 })]);
    editB([el('db', 1), el('base', 3, { x: 80 })]);
    await until(
      () =>
        sceneElements(a.doc).length === 3 &&
        sceneElements(b.doc).length === 3 &&
        sceneElements(a.doc).find((e) => e.id === 'base')?.x === 80 &&
        sceneElements(b.doc).find((e) => e.id === 'base')?.x === 80,
    );
    expect(sceneElements(a.doc).map((e) => e.id)).toEqual(['api', 'base', 'db']);

    // Stored by the debounced hook: scene_rev moves, the element count follows.
    await until(async () => {
      const [row] = await app.deps.db.select().from(drawings).where(eq(drawings.nodeId, d.id));
      return (row?.elementCount ?? 0) === 3;
    });
    const scene = await owner.api.call('getDrawingScene', { params: { nodeId: d.id } });
    expect(scene.elements.map((e) => [e.id, e.x])).toEqual([
      ['api', 0],
      ['base', 80],
      ['db', 0],
    ]);

    // An HTTP write while the document is open is not lost on the next store.
    await owner.api.call('saveDrawingScene', {
      params: { nodeId: d.id },
      body: { elements: [el('mcp', 1)] },
    });
    editA([el('late', 1)]);
    await until(async () => {
      const s = await owner.api.call('getDrawingScene', { params: { nodeId: d.id } });
      return s.elements.some((e) => e.id === 'late');
    });
    const final = await owner.api.call('getDrawingScene', { params: { nodeId: d.id } });
    expect(final.elements.map((e) => e.id)).toEqual(['api', 'base', 'db', 'late', 'mcp']);
  });

  it('viewers connect read-only: their changes never reach others or the database', async () => {
    const d = await owner.api.call('createDrawing', {
      params: { spaceId },
      body: { name: 'Salt okunur' },
    });
    const a = await connect(owner, `drawing:${d.id}`);
    const v = await connect(selin.person, `drawing:${d.id}`);
    expect(v.readOnly).toBe(true);
    mergeElements(v.doc, [el('sneaky', 1)]);
    mergeElements(a.doc, [el('real', 1)]);
    await until(() => sceneElements(v.doc).some((e) => e.id === 'real'));
    await new Promise((r) => setTimeout(r, 300));
    expect(sceneElements(a.doc).map((e) => e.id)).toEqual(['real']);
    await until(async () => {
      const [row] = await app.deps.db.select().from(drawings).where(eq(drawings.nodeId, d.id));
      return (row?.elementCount ?? 0) === 1;
    });
    const stored = sceneElements(
      docFrom(
        (await app.deps.db.select().from(drawings).where(eq(drawings.nodeId, d.id)))[0]!.ydoc,
      ),
    );
    expect(stored.map((e) => e.id)).toEqual(['real']);
  });

  it('refuses a token for another document', async () => {
    const d1 = await owner.api.call('createDrawing', {
      params: { spaceId },
      body: { name: 'Bir' },
    });
    const d2 = await owner.api.call('createDrawing', {
      params: { spaceId },
      body: { name: 'İki' },
    });
    const t = await owner.api.call('createBoardsCollabToken', {
      body: { document: `drawing:${d1.id}` },
    });
    let failed = false;
    const p = new HocuspocusProvider({
      url,
      name: `drawing:${d2.id}`,
      document: new Y.Doc(),
      token: t.token,
      onAuthenticationFailed: () => {
        failed = true;
      },
    });
    providers.push(p);
    await until(() => failed);
    expect(p.isSynced).toBe(false);
  });

  it('card descriptions: concurrent edits merge and desc_text follows', async () => {
    const b = await owner.api.call('createBoard', {
      params: { spaceId },
      body: { name: 'Ortak kart', template: 'empty' },
    });
    const { columns } = await owner.api.call('getBoard', { params: { boardId: b.id } });
    const card = await owner.api.call('createBoardCard', {
      params: { boardId: b.id },
      body: { columnId: columns[0]!.id, title: 'Kart', description: 'İlk satır' },
    });
    const a = await connect(owner, `card:${card.id}`);
    const m = await connect(mert.person, `card:${card.id}`);
    expect(descriptionText(a.doc)).toBe('İlk satır');

    // Each appends a paragraph at the same time.
    const append = (doc: Y.Doc, text: string) => {
      const frag = doc.getXmlFragment('default');
      const p = new Y.XmlElement('paragraph');
      p.insert(0, [new Y.XmlText(text)]);
      frag.insert(frag.length, [p]);
    };
    append(a.doc, 'Buğra yazdı');
    append(m.doc, 'Mert yazdı');
    await until(
      () =>
        descriptionText(a.doc).split('\n').length === 3 &&
        descriptionText(m.doc).split('\n').length === 3,
    );
    expect(descriptionText(a.doc)).toBe(descriptionText(m.doc));
    await until(async () => {
      const [row] = await app.deps.db.select().from(boardCards).where(eq(boardCards.id, card.id));
      return (row?.descText ?? '').split('\n').length === 3;
    });
    const detail = await owner.api.call('getBoardCard', { params: { cardId: card.id } });
    expect(detail.description).toContain('Buğra yazdı');
    expect(detail.description).toContain('Mert yazdı');
    expect(detail.excerpt.startsWith('İlk satır')).toBe(true);
  });

  it('boards turned off: card and drawing documents no longer open', async () => {
    const d = await owner.api.call('createDrawing', {
      params: { spaceId },
      body: { name: 'Kapalı' },
    });
    // Token taken while the module is on; the endpoint itself is blocked centrally afterwards.
    const t = await owner.api.call('createBoardsCollabToken', {
      body: { document: `drawing:${d.id}` },
    });
    const [org] = await app.deps.db.select().from(organizations);
    const settings = org!.settings;
    await app.deps.db
      .update(organizations)
      .set({ settings: { ...settings, modules: { boards: false } } as typeof settings })
      .where(eq(organizations.id, org!.id));
    forgetBoardsSwitch();
    try {
      let failed = false;
      const p = new HocuspocusProvider({
        url,
        name: `drawing:${d.id}`,
        document: new Y.Doc(),
        token: t.token,
        onAuthenticationFailed: () => {
          failed = true;
        },
      });
      providers.push(p);
      await until(() => failed);
      expect(p.isSynced).toBe(false);
      await expect(
        owner.api.call('createBoardsCollabToken', { body: { document: `drawing:${d.id}` } }),
      ).rejects.toMatchObject({
        // 403 from the central module gate (platform); the collab check alone says not_found.
        code: expect.stringMatching(/^(module_disabled|not_found)$/),
      });
    } finally {
      await app.deps.db
        .update(organizations)
        .set({ settings })
        .where(eq(organizations.id, org!.id));
      forgetBoardsSwitch();
    }
  });

  it('setDescription builds the ProseMirror shape Tiptap reads', () => {
    const doc = new Y.Doc();
    setDescription(doc, 'Başlık\n- bir\n- iki\n\nSon');
    const types = doc
      .getXmlFragment('default')
      .toArray()
      .map((n) => (n as Y.XmlElement).nodeName);
    expect(types).toEqual(['paragraph', 'bulletList', 'paragraph', 'paragraph']);
    expect(doc.getMap(ELEMENTS_MAP).size).toBe(0);
  });
});
