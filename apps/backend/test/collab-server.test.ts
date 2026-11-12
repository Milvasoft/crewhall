import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { boardCards } from '@crewhall/db';
import { createCollabServer, type CollabServer } from '../src/collab/server';
import { descriptionText } from '../src/services/boards/ydoc';
import { Client, createTestApp, join, setupWithOwner, type TestApp } from './helpers';

/**
 * One collab server for every module (doc 17 §3): wiki pages (`page:`) and the boards
 * module's card descriptions (`card:`) open side by side, each with its own token, rights
 * and storage.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(check: () => boolean | Promise<boolean>, what: string, ms = 15_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function appendParagraph(doc: Y.Doc, text: string) {
  const p = new Y.XmlElement('paragraph');
  p.insert(0, [new Y.XmlText(text)]);
  const fragment = doc.getXmlFragment('default');
  fragment.insert(fragment.length, [p]);
}

describe('collab server: wiki and boards documents together', () => {
  let app: TestApp;
  let owner: Client;
  let viewer: Client;
  let spaceId: string;
  let collab: CollabServer;
  let url: string;
  const providers: HocuspocusProvider[] = [];

  async function open(name: string, token: () => Promise<string>) {
    const doc = new Y.Doc();
    let failed = false;
    let readOnly: boolean | null = null;
    const provider = new HocuspocusProvider({
      url,
      name,
      document: doc,
      token,
      onAuthenticationFailed: () => {
        failed = true;
      },
      onAuthenticated: ({ scope }) => {
        readOnly = scope === 'readonly';
      },
    });
    providers.push(provider);
    await until(() => provider.isSynced || failed, `${name} sync`);
    return { doc, failed: () => failed, readOnly: () => readOnly };
  }

  const pageToken = (c: Client, nodeId: string) => async () =>
    (await c.api.call('createCollabToken', { params: { nodeId }, body: { source: 'web' } })).token;
  const boardsToken = (c: Client, document: string) => async () =>
    (await c.api.call('createBoardsCollabToken', { body: { document } })).token;

  beforeAll(async () => {
    app = await createTestApp();
    ({ owner } = await setupWithOwner(app));
    spaceId = (await owner.api.call('listSpaces')).items.find((s) => s.isDefault)!.id;
    // Invited people join default spaces as viewers.
    viewer = (await join(app, owner, 'selin@milvasoft.com', 'member')).person;
    collab = createCollabServer(
      { db: app.deps.db, env: app.env, logger: app.deps.logger, jobs: app.deps.jobs },
      { port: 0, debounce: 50, maxDebounce: 300, recheckSeconds: 1 },
    );
    const port = await collab.listen();
    url = `ws://127.0.0.1:${port}`;
    process.env.COLLAB_PUBLIC_URL = url;
  });
  afterAll(async () => {
    for (const p of providers) p.destroy();
    await collab?.close();
    await app?.close();
    delete process.env.COLLAB_PUBLIC_URL;
  });

  it('hands out its own URL to both modules', async () => {
    const page = await owner.api.call('createPage', { params: { spaceId }, body: { name: 'A' } });
    const pageTok = await owner.api.call('createCollabToken', {
      params: { nodeId: page.id },
      body: { source: 'web' },
    });
    const drawing = await owner.api.call('createDrawing', {
      params: { spaceId },
      body: { name: 'Ç' },
    });
    const boardsTok = await owner.api.call('createBoardsCollabToken', {
      body: { document: `drawing:${drawing.id}` },
    });
    expect(pageTok.url).toBe(url);
    expect(boardsTok.url).toBe(url);
  });

  it('hands browsers a path when the collab server is on the web origin (B12)', async () => {
    const hub = new URL(app.env.HUB_URL);
    const sameOrigin = `ws://${hub.host}/collab`;
    process.env.COLLAB_PUBLIC_URL = sameOrigin;
    try {
      const page = await owner.api.call('createPage', { params: { spaceId }, body: { name: 'B' } });
      const token = (source: 'web' | 'mobile') =>
        owner.api.call('createCollabToken', { params: { nodeId: page.id }, body: { source } });
      expect((await token('web')).url).toBe('/collab');
      // The mobile app has no page to resolve a path against; it keeps the full URL.
      expect((await token('mobile')).url).toBe(sameOrigin);
      const drawing = await owner.api.call('createDrawing', {
        params: { spaceId },
        body: { name: 'D' },
      });
      const boardsTok = await owner.api.call('createBoardsCollabToken', {
        body: { document: `drawing:${drawing.id}` },
      });
      expect(boardsTok.url).toBe('/collab');

      // A path in the setting itself: browsers get it as is, the mobile app on the hub's host.
      process.env.COLLAB_PUBLIC_URL = '/collab';
      expect((await token('web')).url).toBe('/collab');
      expect((await token('mobile')).url).toBe(sameOrigin);
    } finally {
      process.env.COLLAB_PUBLIC_URL = url;
    }
  });

  it('edits a page and a card description at the same time and stores each', async () => {
    const page = await owner.api.call('createPage', {
      params: { spaceId },
      body: { name: 'Sayfa', markdown: 'Giriş' },
    });
    const board = await owner.api.call('createBoard', {
      params: { spaceId },
      body: { name: 'Pano', template: 'empty' },
    });
    const { columns } = await owner.api.call('getBoard', { params: { boardId: board.id } });
    const card = await owner.api.call('createBoardCard', {
      params: { boardId: board.id },
      body: { columnId: columns[0]!.id, title: 'Kart', description: 'İlk satır' },
    });

    const p = await open(`page:${page.id}`, pageToken(owner, page.id));
    const c = await open(`card:${card.id}`, boardsToken(owner, `card:${card.id}`));
    expect(p.failed() || c.failed()).toBe(false);
    expect(p.readOnly()).toBe(false);
    expect(c.readOnly()).toBe(false);
    expect(descriptionText(c.doc)).toBe('İlk satır');

    appendParagraph(p.doc, 'Sayfaya eklendi');
    appendParagraph(c.doc, 'Karta eklendi');

    await until(async () => {
      const md = (
        await owner.api.call('getPageContent', {
          params: { nodeId: page.id },
          query: { format: 'markdown' },
        })
      ).markdown;
      return md.includes('Sayfaya eklendi');
    }, 'page stored');
    await until(async () => {
      const [row] = await app.deps.db.select().from(boardCards).where(eq(boardCards.id, card.id));
      return (row?.descText ?? '').includes('Karta eklendi');
    }, 'card stored');

    // Neither document picked up the other's edit.
    expect(descriptionText(c.doc)).not.toContain('Sayfaya');
    expect(p.doc.getXmlFragment('default').toString()).not.toContain('Karta');
  });

  it('ticks a to-do for open editors and has it stored before answering', async () => {
    process.env.COLLAB_INTERNAL_URL = url.replace('ws://', 'http://');
    try {
      const page = await owner.api.call('createPage', {
        params: { spaceId },
        body: { name: 'Liste', markdown: '- [ ] Süt\n- [ ] Ekmek\n' },
      });
      const open1 = await open(`page:${page.id}`, pageToken(owner, page.id));
      await owner.api.call('setPageTask', {
        params: { nodeId: page.id },
        body: { index: 1, text: 'Ekmek', checked: true },
      });
      await until(
        () => open1.doc.getXmlFragment('default').toString().includes('checked="true"'),
        'tick reaches the open editor',
      );
      // No waiting: the card reads the page right after.
      const { markdown } = await owner.api.call('getPageContent', {
        params: { nodeId: page.id },
        query: { format: 'markdown' },
      });
      expect(markdown).toContain('- [x] Ekmek');
      await expect(
        owner.api.call('setPageTask', {
          params: { nodeId: page.id },
          body: { index: 0, text: 'Yoğurt', checked: true },
        }),
      ).rejects.toMatchObject({ code: 'page_task_changed' });
    } finally {
      delete process.env.COLLAB_INTERNAL_URL;
    }
  });

  it('applies the boards rights: a space viewer opens a card read-only', async () => {
    const board = await owner.api.call('createBoard', {
      params: { spaceId },
      body: { name: 'Okuma', template: 'empty' },
    });
    const { columns } = await owner.api.call('getBoard', { params: { boardId: board.id } });
    const card = await owner.api.call('createBoardCard', {
      params: { boardId: board.id },
      body: { columnId: columns[0]!.id, title: 'Kart' },
    });
    const v = await open(`card:${card.id}`, boardsToken(viewer, `card:${card.id}`));
    expect(v.failed()).toBe(false);
    expect(v.readOnly()).toBe(true);
  });

  it('rejects a page token for a card and the reverse', async () => {
    const page = await owner.api.call('createPage', { params: { spaceId }, body: { name: 'B' } });
    const board = await owner.api.call('createBoard', {
      params: { spaceId },
      body: { name: 'Karışık', template: 'empty' },
    });
    const { columns } = await owner.api.call('getBoard', { params: { boardId: board.id } });
    const card = await owner.api.call('createBoardCard', {
      params: { boardId: board.id },
      body: { columnId: columns[0]!.id, title: 'Kart' },
    });
    const wrongForCard = await open(`card:${card.id}`, pageToken(owner, page.id));
    expect(wrongForCard.failed()).toBe(true);
    const wrongForPage = await open(`page:${page.id}`, boardsToken(owner, `card:${card.id}`));
    expect(wrongForPage.failed()).toBe(true);
  });
});
