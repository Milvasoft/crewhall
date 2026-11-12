import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { nodes, pages } from '@crewhall/db';
import { SNIPPET_MARK_START, pagePath } from '@crewhall/shared';
import { createCollabServer, type CollabServer } from '../src/collab/server';
import { removeAbandonedPages } from '../src/services/wiki/derive';
import { Client, createTestApp, join, setupWithOwner, type TestApp } from './helpers';

/**
 * Wiki (design 05, doc 17 §6): pages over HTTP and the real collab server (Hocuspocus) with
 * real providers over WebSocket, Postgres from Testcontainers.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(
  check: () => T | Promise<T>,
  what: string,
  timeoutMs = 15_000,
): Promise<T> {
  const started = Date.now();
  let last: unknown;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await check();
      if (value) return value;
    } catch (err) {
      last = err;
    }
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${String(last)}` : ''}`);
}

function addParagraph(doc: Y.Doc, text: string) {
  const p = new Y.XmlElement('paragraph');
  const t = new Y.XmlText();
  t.insert(0, text);
  p.insert(0, [t]);
  doc.getXmlFragment('default').push([p]);
}

const fragmentText = (doc: Y.Doc) => doc.getXmlFragment('default').toString();

describe('Wiki', () => {
  let app: TestApp;
  let owner: Client;
  let spaceId: string;
  let collab: CollabServer;
  let collabUrl: string;
  const providers: HocuspocusProvider[] = [];

  async function connect(c: Client, nodeId: string) {
    const doc = new Y.Doc();
    let failed: string | null = null;
    let readOnly: boolean | null = null;
    const provider = new HocuspocusProvider({
      url: collabUrl,
      name: `page:${nodeId}`,
      document: doc,
      token: async () =>
        (await c.api.call('createCollabToken', { params: { nodeId }, body: { source: 'web' } }))
          .token,
      onAuthenticationFailed: ({ reason }) => {
        failed = reason;
      },
      onAuthenticated: ({ scope }) => {
        readOnly = scope === 'readonly';
      },
    });
    providers.push(provider);
    await waitFor(() => provider.isSynced || failed, 'provider sync');
    return { doc, provider, failed: failed as string | null, readOnly: () => readOnly };
  }

  const content = async (c: Client, nodeId: string) =>
    (await c.api.call('getPageContent', { params: { nodeId }, query: { format: 'markdown' } }))
      .markdown;

  beforeAll(async () => {
    app = await createTestApp();
    ({ owner } = await setupWithOwner(app));
    spaceId = (await owner.api.call('listSpaces')).items.find((s) => s.isDefault)!.id;
    collab = createCollabServer(
      { db: app.deps.db, env: app.env, logger: app.deps.logger, jobs: app.deps.jobs },
      { port: 0, debounce: 50, maxDebounce: 300, recheckSeconds: 1 },
    );
    const port = await collab.listen();
    collabUrl = `ws://127.0.0.1:${port}`;
    process.env.COLLAB_INTERNAL_URL = `http://127.0.0.1:${port}`;
    process.env.COLLAB_PUBLIC_URL = collabUrl;
  });
  afterAll(async () => {
    for (const p of providers) p.destroy();
    await collab?.close();
    await app?.close();
    delete process.env.COLLAB_INTERNAL_URL;
    delete process.env.COLLAB_PUBLIC_URL;
  });

  it('creates pages, nests them in the tree and renames them', async () => {
    const parent = await owner.api.call('createPage', {
      params: { spaceId },
      body: { name: 'Başlıksız' },
    });
    expect(parent).toMatchObject({
      name: 'Başlıksız',
      empty: true,
      canEdit: true,
      myRole: 'owner',
      locked: false,
    });
    const again = await owner.api.call('createPage', {
      params: { spaceId },
      body: { name: 'Başlıksız' },
    });
    expect(again.name).toBe('Başlıksız (2)');
    const child = await owner.api.call('createPage', {
      params: { spaceId },
      body: { parentId: parent.id, name: 'Kilit stratejisi', markdown: '## Kilit\n\nRedis kilidi' },
    });
    expect(child.path).toEqual([{ id: parent.id, name: 'Başlıksız' }]);

    const renamed = await owner.api.call('updatePage', {
      params: { nodeId: parent.id },
      body: { name: 'Mimari', icon: '🏗️', fullWidth: true },
    });
    expect(renamed).toMatchObject({ name: 'Mimari', icon: '🏗️', fullWidth: true });

    const tree = await owner.api.call('listPageTree', { params: { spaceId } });
    expect(tree.canCreate).toBe(true);
    const byId = new Map(tree.items.map((i) => [i.id, i]));
    expect(byId.get(child.id)).toMatchObject({ parentId: parent.id });
    expect(byId.get(parent.id)).toMatchObject({ hasChildren: true, parentId: null, icon: '🏗️' });

    // A page under a folder hangs at the top of the pages tree.
    const folder = await owner.api.call('createFolder', {
      params: { spaceId },
      body: { name: 'Belgeler' },
    });
    const inFolder = await owner.api.call('createPage', {
      params: { spaceId },
      body: { parentId: folder.id, name: 'Klasördeki sayfa' },
    });
    const tree2 = await owner.api.call('listPageTree', { params: { spaceId } });
    expect(tree2.items.find((i) => i.id === inFolder.id)?.parentId).toBeNull();

    expect(await content(owner, child.id)).toBe('## Kilit\n\nRedis kilidi');
    expect(pagePath(renamed)).toBe(`/p/mimari-${parent.id}`);
  });

  it('fills templates and lists built-in, personal and space templates', async () => {
    const list = await owner.api.call('listPageTemplates', { query: {} });
    expect(list.items.map((t) => t.id)).toContain('builtin:meeting');
    const page = await owner.api.call('createPage', {
      params: { spaceId },
      body: { name: 'Haftalık toplantı', templateId: 'builtin:meeting' },
    });
    const md = await content(owner, page.id);
    expect(md).toContain('## Gündem');
    expect(md).toContain('Ahmet Buğra Kösen');
    expect(md).not.toContain('«');

    const saved = await owner.api.call('createPageTemplate', {
      body: { nodeId: page.id, name: 'Bizim toplantı', scope: 'space' },
    });
    expect(saved).toMatchObject({ scope: 'space', spaceId });
    const fromSaved = await owner.api.call('createPage', {
      params: { spaceId },
      body: { name: 'Toplantı 2', templateId: saved.id },
    });
    expect(await content(owner, fromSaved.id)).toContain('## Gündem');
    await owner.api.call('deletePageTemplate', { params: { templateId: saved.id } });
    const after = await owner.api.call('listPageTemplates', { query: { spaceId } });
    expect(after.items.some((t) => t.id === saved.id)).toBe(false);
  });

  it('adds Markdown at the end of a page (web clipper) and respects the lock', async () => {
    const page = await owner.api.call('createPage', {
      params: { spaceId },
      body: { name: 'Kırpılanlar', markdown: 'ilk paragraf' },
    });
    await owner.api.call('appendPage', {
      params: { nodeId: page.id },
      body: { markdown: '## Kırpım\n\neklenen **metin**' },
    });
    const body = await waitFor(async () => {
      const md = await content(owner, page.id);
      return md.includes('eklenen') ? md : null;
    }, 'appended text');
    expect(body!.indexOf('ilk paragraf')).toBeLessThan(body!.indexOf('eklenen'));

    await owner.api.call('updatePage', { params: { nodeId: page.id }, body: { locked: true } });
    await expect(
      owner.api.call('appendPage', { params: { nodeId: page.id }, body: { markdown: 'yasak' } }),
    ).rejects.toMatchObject({ code: 'page_locked' });
  });

  it('two editors write the same page at once without losing anything; it survives a reload', async () => {
    const page = await owner.api.call('createPage', {
      params: { spaceId },
      body: { name: 'Ortak' },
    });
    const a = await connect(owner, page.id);
    const b = await connect(owner, page.id);
    addParagraph(a.doc, 'Elif yazıyor');
    addParagraph(b.doc, 'Zeynep yazıyor');
    await waitFor(
      () =>
        fragmentText(a.doc).includes('Zeynep yazıyor') &&
        fragmentText(b.doc).includes('Elif yazıyor'),
      'both edits on both clients',
    );
    expect(fragmentText(a.doc)).toBe(fragmentText(b.doc));

    // Persisted (debounced store) and derived (markdown, search) without any client action.
    await waitFor(async () => {
      const md = await content(owner, page.id);
      return md.includes('Elif yazıyor') && md.includes('Zeynep yazıyor');
    }, 'stored state');
    a.provider.destroy();
    b.provider.destroy();
    await sleep(300);

    const c = await connect(owner, page.id);
    expect(fragmentText(c.doc)).toContain('Elif yazıyor');
    expect(fragmentText(c.doc)).toContain('Zeynep yazıyor');
    const got = await owner.api.call('getPage', { params: { nodeId: page.id } });
    expect(got).toMatchObject({ empty: false, lastSource: 'web' });
    expect(got.editedBy?.name).toBe('Ahmet Buğra Kösen');
    c.provider.destroy();
  });

  it('five concurrent editors converge with every edit kept', async () => {
    const page = await owner.api.call('createPage', {
      params: { spaceId },
      body: { name: 'Beşli' },
    });
    const clients = await Promise.all(Array.from({ length: 5 }, () => connect(owner, page.id)));
    // Every client types several paragraphs at the same time.
    await Promise.all(
      clients.map(async (cl, i) => {
        for (let n = 0; n < 5; n++) {
          addParagraph(cl.doc, `istemci-${i}-satir-${n}`);
          await sleep(5);
        }
      }),
    );
    const expected = clients.flatMap((_, i) =>
      Array.from({ length: 5 }, (__, n) => `istemci-${i}-satir-${n}`),
    );
    await waitFor(
      () => clients.every((cl) => expected.every((e) => fragmentText(cl.doc).includes(e))),
      'convergence',
    );
    const first = fragmentText(clients[0]!.doc);
    for (const cl of clients) expect(fragmentText(cl.doc)).toBe(first);
    await waitFor(async () => {
      const md = await content(owner, page.id);
      return expected.every((e) => md.includes(e));
    }, 'all edits stored');
    for (const cl of clients) cl.provider.destroy();
  });

  it('viewers connect read-only, bad tokens are refused, lost rights apply to open connections', async () => {
    const page = await owner.api.call('createPage', {
      params: { spaceId },
      body: { name: 'Salt okunur', markdown: 'Asıl metin' },
    });
    const { person: burak, me } = await join(app, owner, 'burak@milvasoft.com', 'member', [
      spaceId,
    ]);
    await owner.api.call('updateSpaceMember', {
      params: { spaceId, userId: me.user.id },
      body: { role: 'viewer' },
    });
    const viewerToken = await burak.api.call('createCollabToken', {
      params: { nodeId: page.id },
      body: { source: 'mobile' },
    });
    expect(viewerToken.readOnly).toBe(true);
    const viewerPage = await burak.api.call('getPage', { params: { nodeId: page.id } });
    expect(viewerPage).toMatchObject({ canEdit: false, canComment: true, myRole: 'viewer' });

    const viewer = await connect(burak, page.id);
    expect(viewer.readOnly()).toBe(true);
    addParagraph(viewer.doc, 'izleyen yazmaya çalıştı');
    await sleep(500);
    expect(await content(owner, page.id)).not.toContain('izleyen');

    // Forged token: refused.
    const forged = new HocuspocusProvider({
      url: collabUrl,
      name: `page:${page.id}`,
      document: new Y.Doc(),
      token: `${viewerToken.token.split('.')[0]}.AAAA`,
    });
    providers.push(forged);
    let refused = false;
    forged.on('authenticationFailed', () => {
      refused = true;
    });
    await waitFor(() => refused, 'forged token refusal');

    // Editor connection; lock the page → it turns read-only within the recheck interval.
    const editor = await connect(owner, page.id);
    expect(editor.readOnly()).toBe(false);
    await owner.api.call('updatePage', { params: { nodeId: page.id }, body: { locked: true } });
    const locked = await owner.api.call('createCollabToken', {
      params: { nodeId: page.id },
      body: {},
    });
    expect(locked.readOnly).toBe(true);
    await sleep(1500);
    addParagraph(editor.doc, 'kilitliyken yazıldı');
    await sleep(600);
    expect(await content(owner, page.id)).not.toContain('kilitliyken');
    await expect(
      owner.api.call('updatePage', { params: { nodeId: page.id }, body: { name: 'Değişmez' } }),
    ).rejects.toMatchObject({ status: 423, code: 'page_locked' });
    await owner.api.call('updatePage', { params: { nodeId: page.id }, body: { locked: false } });

    // Removed from the space: the viewer's connection is closed.
    let closed = false;
    viewer.provider.on('close', () => {
      closed = true;
    });
    await owner.api.call('removeSpaceMember', { params: { spaceId, userId: me.user.id } });
    await waitFor(() => closed, 'viewer disconnected after losing access', 5000);
    editor.provider.destroy();
    viewer.provider.destroy();
  });

  it('keeps versions, names one and restores an old one live into open editors', async () => {
    const page = await owner.api.call('createPage', {
      params: { spaceId },
      body: { name: 'Sürümlü', markdown: 'İlk hâli' },
    });
    const v0 = await owner.api.call('listPageVersions', { params: { nodeId: page.id } });
    expect(v0.items).toHaveLength(1);
    expect(v0.items[0]).toMatchObject({ version: 1, source: 'web', current: true });

    const editor = await connect(owner, page.id);
    addParagraph(editor.doc, 'İkinci paragraf');
    await waitFor(
      async () => (await content(owner, page.id)).includes('İkinci paragraf'),
      'stored',
    );
    const named = await owner.api.call('savePageVersion', {
      params: { nodeId: page.id },
      body: { label: '1.4 yayın öncesi' },
    });
    expect(named).toMatchObject({ version: 2, label: '1.4 yayın öncesi' });
    expect(named.editors.map((e) => e.name)).toContain('Ahmet Buğra Kösen');

    addParagraph(editor.doc, 'Sonradan eklenen');
    await waitFor(
      async () => (await content(owner, page.id)).includes('Sonradan eklenen'),
      'stored 2',
    );

    const detail = await owner.api.call('getPageVersion', {
      params: { nodeId: page.id, versionId: v0.items[0]!.id },
    });
    expect(detail.markdown).toBe('İlk hâli');
    expect(detail.previous).toBeNull();

    let restoredNotice = false;
    editor.provider.on('stateless', ({ payload }: { payload: string }) => {
      if (JSON.parse(payload).type === 'restored') restoredNotice = true;
    });
    const restored = await owner.api.call('restorePageVersion', {
      params: { nodeId: page.id, versionId: v0.items[0]!.id },
    });
    expect(restored.restoredFrom).toBe(1);
    // The open editor receives the old content as a normal update.
    await waitFor(
      () =>
        !fragmentText(editor.doc).includes('Sonradan eklenen') &&
        fragmentText(editor.doc).includes('İlk hâli'),
      'restored content in the open editor',
    );
    expect(restoredNotice).toBe(true);
    expect(await content(owner, page.id)).toBe('İlk hâli');

    const list = await owner.api.call('listPageVersions', { params: { nodeId: page.id } });
    // 1 created, 2 named, 3 state before restore, 4 the restore.
    expect(list.items.map((v) => v.version)).toEqual([4, 3, 2, 1]);
    expect(list.items[0]).toMatchObject({ restoredFrom: 1, current: true });
    const before = await owner.api.call('getPageVersion', {
      params: { nodeId: page.id, versionId: list.items[1]!.id },
    });
    expect(before.markdown).toContain('Sonradan eklenen');

    // Editing keeps working after the restore.
    addParagraph(editor.doc, 'Geri dönüşten sonra');
    await waitFor(
      async () => (await content(owner, page.id)).includes('Geri dönüşten sonra'),
      'post-restore edit',
    );
    editor.provider.destroy();
  });

  it('restores through the stored state when collab is not reachable', async () => {
    const page = await owner.api.call('createPage', {
      params: { spaceId },
      body: { name: 'Çevrimdışı geri', markdown: 'Bir' },
    });
    const v1 = (await owner.api.call('listPageVersions', { params: { nodeId: page.id } }))
      .items[0]!;
    const editor = await connect(owner, page.id);
    addParagraph(editor.doc, 'İki');
    await waitFor(async () => (await content(owner, page.id)).includes('İki'), 'stored');
    editor.provider.destroy();
    await sleep(200);
    const saved = process.env.COLLAB_INTERNAL_URL;
    process.env.COLLAB_INTERNAL_URL = 'http://127.0.0.1:9';
    try {
      await owner.api.call('restorePageVersion', { params: { nodeId: page.id, versionId: v1.id } });
    } finally {
      process.env.COLLAB_INTERNAL_URL = saved;
    }
    expect(await content(owner, page.id)).toBe('Bir');
    const again = await connect(owner, page.id);
    expect(fragmentText(again.doc)).not.toContain('İki');
    again.provider.destroy();
  });

  it('comment threads: anchors, replies, resolve and reopen; viewers may comment', async () => {
    const page = await owner.api.call('createPage', {
      params: { spaceId },
      body: { name: 'Yorumlu', markdown: 'Kuyruk RabbitMQ’da kalıyor.' },
    });
    const anchor = Buffer.from(
      Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(new Y.Doc().getText('x'), 0)),
    ).toString('base64');
    const thread = await owner.api.call('createPageComment', {
      params: { nodeId: page.id },
      body: {
        body: 'LISTEN/NOTIFY yetmez mi?',
        anchorStart: anchor,
        anchorEnd: anchor,
        quote: 'RabbitMQ’da',
      },
    });
    expect(thread).toMatchObject({ anchorStart: anchor, quote: 'RabbitMQ’da', resolvedAt: null });
    const reply = await owner.api.call('createPageComment', {
      params: { nodeId: page.id },
      body: { body: 'Denedik, geri basınç yok.', threadId: thread.id },
    });
    expect(reply.comments.map((c) => c.body)).toEqual([
      'LISTEN/NOTIFY yetmez mi?',
      'Denedik, geri basınç yok.',
    ]);
    await expect(
      owner.api.call('createPageComment', {
        params: { nodeId: page.id },
        body: { body: 'x', threadId: thread.id, anchorStart: anchor, anchorEnd: anchor },
      }),
    ).rejects.toMatchObject({ status: 422 });

    const resolved = await owner.api.call('resolvePageThread', {
      params: { threadId: thread.id },
      body: { resolved: true },
    });
    expect(resolved.resolvedBy?.name).toBe('Ahmet Buğra Kösen');
    expect(
      (
        await owner.api.call('listPageComments', {
          params: { nodeId: page.id },
          query: { status: 'open' },
        })
      ).items,
    ).toHaveLength(0);
    expect(
      (
        await owner.api.call('listPageComments', {
          params: { nodeId: page.id },
          query: { status: 'resolved' },
        })
      ).items,
    ).toHaveLength(1);
    expect(
      (await owner.api.call('getPage', { params: { nodeId: page.id } })).openCommentCount,
    ).toBe(0);

    // Page-wide comment from a viewer.
    const { person: selin, me } = await join(app, owner, 'selin@milvasoft.com', 'member', [
      spaceId,
    ]);
    await owner.api.call('updateSpaceMember', {
      params: { spaceId, userId: me.user.id },
      body: { role: 'viewer' },
    });
    const general = await selin.api.call('createPageComment', {
      params: { nodeId: page.id },
      body: { body: 'Portal’a yayınlamadan önce diyagramı güncelleyelim.' },
    });
    expect(general.anchorStart).toBeNull();
    // Only the author edits; the owner (space admin) may delete.
    await expect(
      owner.api.call('updatePageComment', {
        params: { commentId: general.comments[0]!.id },
        body: { body: 'x' },
      }),
    ).rejects.toMatchObject({ status: 403 });
    const edited = await selin.api.call('updatePageComment', {
      params: { commentId: general.comments[0]!.id },
      body: { body: 'Diyagramı güncelleyelim.' },
    });
    expect(edited.comments[0]!.editedAt).not.toBeNull();
    await owner.api.call('deletePageComment', { params: { commentId: general.comments[0]!.id } });
    const all = await owner.api.call('listPageComments', {
      params: { nodeId: page.id },
      query: {},
    });
    expect(all.items.map((t) => t.id)).toEqual([thread.id]);
  });

  it('records links, embeds and mentions as backlinks', async () => {
    const target = await owner.api.call('createPage', {
      params: { spaceId },
      body: { name: 'Sürüm notları 1.4' },
    });
    const source = await owner.api.call('createPage', {
      params: { spaceId },
      body: {
        name: 'Bağlayan',
        markdown: `Değişiklikler için [Sürüm notları](${pagePath(target)}) sayfasına bak.\n\n::embed{node="${target.id}" type="page"}`,
      },
    });
    const links = await owner.api.call('listPageBacklinks', { params: { nodeId: target.id } });
    expect(links.items).toHaveLength(1);
    expect(links.items[0]).toMatchObject({ node: { id: source.id, name: 'Bağlayan' } });
    expect(links.items[0]!.kinds.sort()).toEqual(['embed', 'link']);

    // The link goes away with the text.
    const editor = await connect(owner, source.id);
    editor.doc.transact(() => {
      const frag = editor.doc.getXmlFragment('default');
      frag.delete(0, frag.length);
    });
    addParagraph(editor.doc, 'Bağlantı yok artık');
    await waitFor(
      async () =>
        (await owner.api.call('listPageBacklinks', { params: { nodeId: target.id } })).items
          .length === 0,
      'backlink removed',
    );
    editor.provider.destroy();
  });

  it('searches titles, bodies and comments with Turkish stemming', async () => {
    const page = await owner.api.call('createPage', {
      params: { spaceId },
      body: {
        name: 'Altyapı notları',
        markdown:
          'Yedekleme sunucu üzerinde her gece çalışır.\n\n```csharp\nRetryPolicy.Exponential(maxAttempts: 5)\n```',
      },
    });
    const hits = await owner.api.call('searchPages', { query: { q: 'sunucuların' } });
    const hit = hits.items.find((h) => h.node.id === page.id);
    expect(hit).toBeDefined();
    expect(hit!.matchedIn).toBe('body');
    expect(hit!.snippet).toContain(SNIPPET_MARK_START);
    expect(hit!.space.id).toBe(spaceId);

    // The Turkish stemmer splits inflections into two stems; every form must still match.
    const other = await owner.api.call('createPage', {
      params: { spaceId },
      body: { name: 'Worker havuzu', markdown: 'Worker sunucuları kuyruğu tüketir.' },
    });
    for (const q of ['sunucu', 'sunucular', 'sunucuları', 'sunucuların', 'sunucunun']) {
      const ids = (await owner.api.call('searchPages', { query: { q } })).items.map(
        (h) => h.node.id,
      );
      expect(ids, q).toEqual(expect.arrayContaining([page.id, other.id]));
    }

    const title = await owner.api.call('searchPages', { query: { q: 'altyapı' } });
    expect(title.items[0]?.node.id).toBe(page.id);
    // Code blocks and prefixes while typing.
    expect(
      (await owner.api.call('searchPages', { query: { q: 'retrypol' } })).items.some(
        (h) => h.node.id === page.id,
      ),
    ).toBe(true);

    await owner.api.call('createPageComment', {
      params: { nodeId: page.id },
      body: { body: 'Kopyalama başarısız olursa alarm gelsin.' },
    });
    const inComments = await owner.api.call('searchPages', { query: { q: 'kopyalamalar' } });
    expect(inComments.items.find((h) => h.node.id === page.id)?.matchedIn).toBe('comment');
    const noComments = await owner.api.call('searchPages', {
      query: { q: 'kopyalamalar', comments: 'false' },
    });
    expect(noComments.items.some((h) => h.node.id === page.id)).toBe(false);

    // Trashed pages and people without access do not see it.
    await owner.api.call('trashNodes', { body: { nodeIds: [page.id] } });
    expect(
      (await owner.api.call('searchPages', { query: { q: 'sunucu' } })).items.some(
        (h) => h.node.id === page.id,
      ),
    ).toBe(false);
  });

  it('exports a page with its children and imports markdown files as a tree', async () => {
    const root = await owner.api.call('createPage', {
      params: { spaceId },
      body: { name: 'Dışa aktarılan', markdown: ':::note[Not]\nCanlı belge.\n:::' },
    });
    await owner.api.call('createPage', {
      params: { spaceId },
      body: { parentId: root.id, name: 'Alt sayfa', markdown: '- [x] bitti\n- [ ] sırada' },
    });
    const one = await owner.api.call('exportPage', { params: { nodeId: root.id }, query: {} });
    expect(one.files).toEqual([
      {
        path: 'Dışa aktarılan.md',
        markdown: '# Dışa aktarılan\n\n:::note[Not]\nCanlı belge.\n:::\n',
      },
    ]);
    const all = await owner.api.call('exportPage', {
      params: { nodeId: root.id },
      query: { children: 'true' },
    });
    expect(all.files.map((f) => f.path)).toEqual([
      'Dışa aktarılan.md',
      'Dışa aktarılan/Alt sayfa.md',
    ]);
    expect(all.files[1]!.markdown).toContain('- [x] bitti');

    const result = await owner.api.call('importPages', {
      params: { spaceId },
      body: {
        files: [
          { path: 'Ops/Yedekleme.md', content: '# Yedekleme planı\n\nHer gece.' },
          { path: 'Ops.md', content: 'Operasyon sayfaları.' },
          { path: 'boş.md', content: '   ' },
          { path: 'resim.png', content: 'x' },
        ],
      },
    });
    expect(result.warnings).toEqual([{ path: 'boş.md', code: 'empty' }]);
    const names = result.pages.map((p) => p.name).sort();
    expect(names).toEqual(['Ops', 'Yedekleme planı']);
    const ops = result.pages.find((p) => p.name === 'Ops')!;
    expect(await content(owner, ops.id)).toBe('Operasyon sayfaları.');
    const tree = await owner.api.call('listPageTree', { params: { spaceId } });
    expect(tree.items.find((i) => i.name === 'Yedekleme planı')?.parentId).toBe(ops.id);

    // Links between the files become page links, and so backlinks.
    const linked = await owner.api.call('importPages', {
      params: { spaceId },
      body: {
        files: [
          {
            path: 'Bağlı/Ana.md',
            content:
              '[alt](Ana/Alt%20Sayfa.md#kurulum) [kök](/Bağlı/Ana/Alt%20Sayfa.md) [yok](Silinen.md) [site](https://example.com/Ana.md)\n\n```\n[kod](Ana/Alt%20Sayfa.md)\n```',
          },
          { path: 'Bağlı/Ana/Alt Sayfa.md', content: '# Alt Başlık\n\n[üst](../Ana.md)' },
        ],
      },
    });
    const main = linked.pages.find((p) => p.name === 'Ana')!;
    const sub = linked.pages.find((p) => p.name === 'Alt Başlık')!;
    const mainText = await content(owner, main.id);
    expect(mainText).toContain(`[alt](${pagePath(sub)})`);
    expect(mainText).toContain(`[kök](${pagePath(sub)})`);
    expect(mainText).toContain('[yok](Silinen.md)');
    expect(mainText).toContain('[site](https://example.com/Ana.md)');
    expect(mainText).toContain('[kod](Ana/Alt%20Sayfa.md)');
    expect(await content(owner, sub.id)).toBe(`[üst](${pagePath(main)})`);
    const back = await owner.api.call('listPageBacklinks', { params: { nodeId: sub.id } });
    expect(back.items.map((l) => l.node.id)).toEqual([main.id]);
    await expect(
      owner.api.call('importPages', {
        params: { spaceId },
        body: { files: [{ path: 'a.txt', content: 'x' }] },
      }),
    ).rejects.toMatchObject({ code: 'import_invalid' });
  });

  it('removes untitled pages nobody wrote in after 10 minutes, keeps the rest', async () => {
    const empty = await owner.api.call('createPage', {
      params: { spaceId },
      body: { name: 'Boş kalan' },
    });
    const written = await owner.api.call('createPage', {
      params: { spaceId },
      body: { name: 'Dolu', markdown: 'Metin var' },
    });
    const old = new Date(Date.now() - 11 * 60_000);
    await app.deps.db
      .update(nodes)
      .set({ createdAt: old, updatedAt: old })
      .where(sql`${nodes.id} in (${empty.id}, ${written.id})`);
    await app.deps.db.execute(
      sql`update nodes set updated_at = created_at where id in (${empty.id}, ${written.id})`,
    );
    const removed = await removeAbandonedPages(app.deps.db, app.deps.logger);
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(await app.deps.db.select().from(nodes).where(eq(nodes.id, empty.id))).toHaveLength(0);
    expect(await app.deps.db.select().from(pages).where(eq(pages.nodeId, written.id))).toHaveLength(
      1,
    );
  });

  it('does not show pages to people outside the space', async () => {
    const page = await owner.api.call('createPage', {
      params: { spaceId },
      body: { name: 'Gizli' },
    });
    const other = await owner.api.call('createSpace', { body: { name: 'Yönetim', color: 's3' } });
    const hidden = await owner.api.call('createPage', {
      params: { spaceId: other.id },
      body: { name: 'Bütçe' },
    });
    const { person } = await join(app, owner, 'mert@milvasoft.com', 'member', [spaceId]);
    await expect(
      person.api.call('getPage', { params: { nodeId: hidden.id } }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      person.api.call('createCollabToken', { params: { nodeId: hidden.id }, body: {} }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      person.api.call('listPageTree', { params: { spaceId: other.id } }),
    ).rejects.toMatchObject({ status: 404 });
    expect((await person.api.call('getPage', { params: { nodeId: page.id } })).canEdit).toBe(false);
  });
});
