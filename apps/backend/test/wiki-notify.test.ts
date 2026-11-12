import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { nodeUserState, notifications, organizations, pages } from '@crewhall/db';
import { pagePath, type Notification } from '@crewhall/shared';
import { invalidateModules } from '../src/services/identity/modules';
import { pushText } from '../src/services/notifications/push';
import { derivePage, FOLLOW_NOTICE_EVERY_MS } from '../src/services/wiki/derive';
import { stateFromJson } from '../src/services/wiki/doc';
import { markdownToDoc } from '../src/services/wiki/markdown';
import { noticeInputs } from '../src/services/wiki/notify';
import { Client, createTestApp, join, setupWithOwner, type TestApp } from './helpers';

/**
 * Wiki ↔ chat (doc 17 §10): @mentions in page bodies and comments reach the notification
 * centre (bell, push, digest) as `page.*` notifications.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('wiki notifications', () => {
  let app: TestApp;
  let owner: Client;
  let mert: Client;
  let mertId: string;
  let selin: Client;
  let selinId: string;
  let spaceId: string;

  const mention = (id: string, name: string) => `[@${name}](mention:user:${id})`;

  const inbox = async (c: Client) =>
    (await c.api.call('listNotifications', { query: {} })).items.filter((n) =>
      n.type.startsWith('page.'),
    );

  async function waitForInbox(c: Client, check: (items: Notification[]) => boolean) {
    const end = Date.now() + 10_000;
    let items: Notification[] = [];
    while (Date.now() < end) {
      items = await inbox(c);
      if (check(items)) return items;
      await sleep(50);
    }
    throw new Error(`notification not delivered: ${JSON.stringify(items.map((n) => n.type))}`);
  }

  async function setWiki(on: boolean) {
    const [org] = await app.deps.db.select().from(organizations);
    const settings = org!.settings;
    await app.deps.db
      .update(organizations)
      .set({ settings: { ...settings, modules: { ...settings.modules, wiki: on } } })
      .where(eq(organizations.id, org!.id));
    invalidateModules();
  }

  beforeAll(async () => {
    app = await createTestApp();
    ({ owner } = await setupWithOwner(app));
    spaceId = (await owner.api.call('listSpaces')).items.find((s) => s.isDefault)!.id;
    // Invited people join default spaces as viewers: they can read the pages there.
    const m = await join(app, owner, 'mert@milvasoft.com', 'member');
    mert = m.person;
    mertId = m.me.user.id;
    const s = await join(app, owner, 'selin@milvasoft.com', 'member');
    selin = s.person;
    selinId = s.me.user.id;
  });
  afterAll(async () => {
    await app?.close();
  });

  it('notifies people mentioned in the body once per page, only when they can read it', async () => {
    const page = await owner.api.call('createPage', {
      params: { spaceId },
      body: { name: 'Mimari notları', markdown: `Kilidi ${mention(mertId, 'Mert')} inceliyor.` },
    });
    const [n] = await waitForInbox(mert, (items) => items.some((x) => x.target.id === page.id));
    expect(n).toMatchObject({
      type: 'page.mention',
      category: 'mention',
      source: 'pages',
      actor: { name: 'Ahmet Buğra Kösen' },
      target: { type: 'node', id: page.id, spaceId },
      data: { name: 'Mimari notları' },
      url: pagePath(page),
    });

    // Deriving the same body again (snapshot job, sweep) does not notify a second time.
    await derivePage(app.deps, page.id, true);
    await sleep(200);
    expect((await inbox(mert)).filter((x) => x.target.id === page.id)).toHaveLength(1);

    // A private space Selin is not in: her mention is not delivered.
    const secret = await owner.api.call('createSpace', { body: { name: 'Finans', color: 's5' } });
    const hidden = await owner.api.call('createPage', {
      params: { spaceId: secret.id },
      body: { name: 'Bütçe', markdown: `${mention(selinId, 'Selin')} bakabilir mi?` },
    });
    await derivePage(app.deps, hidden.id, true);
    await sleep(200);
    expect((await inbox(selin)).some((x) => x.target.id === hidden.id)).toBe(false);
  });

  it('comment mentions and replies open the thread with the comments panel', async () => {
    const page = await owner.api.call('createPage', {
      params: { spaceId },
      body: { name: 'Kuyruk', markdown: 'RabbitMQ kalıyor.' },
    });
    const thread = await owner.api.call('createPageComment', {
      params: { nodeId: page.id },
      body: { body: '@Mert ne düşünüyorsun?', mentions: [mertId] },
    });
    const threadUrl = `${pagePath(page)}?comment=${thread.id}&panel=comments`;
    const [m] = await waitForInbox(mert, (items) =>
      items.some((x) => x.type === 'page.comment_mention' && x.target.id === page.id),
    );
    expect(m).toMatchObject({
      type: 'page.comment_mention',
      category: 'mention',
      target: { type: 'node', id: page.id },
      data: { name: 'Kuyruk', excerpt: '@Mert ne düşünüyorsun?' },
      url: threadUrl,
    });

    // Mert replies and mentions Selin: the reply links the thread (root), not the reply.
    await mert.api.call('createPageComment', {
      params: { nodeId: page.id },
      body: { body: '@Selin de baksın', threadId: thread.id, mentions: [selinId] },
    });
    const [reply] = await waitForInbox(owner, (items) =>
      items.some((x) => x.type === 'page.comment_reply' && x.target.id === page.id),
    );
    expect(reply).toMatchObject({
      category: 'direct_reply',
      url: threadUrl,
      actor: { name: 'mert' },
    });
    const [s] = await waitForInbox(selin, (items) =>
      items.some((x) => x.type === 'page.comment_mention' && x.target.id === page.id),
    );
    expect(s!.url).toBe(threadUrl);

    // Push text in the recipient's language.
    const [row] = await app.deps.db
      .select()
      .from(notifications)
      .where(eq(notifications.id, reply!.id));
    expect(pushText(row!, 'tr')).toEqual({
      title: 'mert, Kuyruk sayfasındaki yorumuna yanıt verdi',
      body: '@Selin de baksın',
    });
    expect(pushText(row!, 'en').title).toBe('mert replied to your comment on Kuyruk');
  });

  it('sends nothing while the wiki module is off', async () => {
    const page = await owner.api.call('createPage', {
      params: { spaceId },
      body: { name: 'Kapalıyken', markdown: 'Henüz kimse yok.' },
    });
    // The page endpoints are closed centrally; what remains is the worker deriving a body
    // that was stored meanwhile (collab server, MCP).
    await setWiki(false);
    try {
      await expect(owner.api.call('getPage', { params: { nodeId: page.id } })).rejects.toThrow();
      await app.deps.db
        .update(pages)
        .set({ ydoc: stateFromJson(markdownToDoc(`${mention(mertId, 'Mert')} bakacak.`)) })
        .where(eq(pages.nodeId, page.id));
      await derivePage(app.deps, page.id, true);
      await sleep(200);
      expect((await inbox(mert)).some((x) => x.target.id === page.id)).toBe(false);
    } finally {
      await setWiki(true);
    }
  });

  describe('following a page', () => {
    /** A saved edit by the given person, as the collab server stores it. */
    async function edit(pageId: string, text: string, by: string) {
      await app.deps.db
        .update(pages)
        .set({
          ydoc: stateFromJson(markdownToDoc(text)),
          editedAt: new Date(),
          editedBy: by,
        })
        .where(eq(pages.nodeId, pageId));
      await derivePage(app.deps, pageId, true);
    }

    const updates = async (c: Client, id: string) =>
      (await inbox(c)).filter((x) => x.type === 'page.updated' && x.target.id === id);

    /** Followers hear at most once an hour: pretends the last notice was long ago. */
    const hourLater = (id: string) =>
      app.deps.db
        .update(nodeUserState)
        .set({ followNotifiedAt: new Date(Date.now() - 2 * FOLLOW_NOTICE_EVERY_MS) })
        .where(eq(nodeUserState.nodeId, id));

    async function followedPage(name: string) {
      const page = await owner.api.call('createPage', {
        params: { spaceId },
        body: { name, markdown: 'İlk hali.' },
      });
      await derivePage(app.deps, page.id, true);
      return page;
    }

    it('tells followers about a change, not the person who made it', async () => {
      const ownerId = (await owner.api.call('me')).user.id;
      const page = await followedPage('Takip');
      expect((await mert.api.call('getPage', { params: { nodeId: page.id } })).following).toBe(
        false,
      );
      await mert.api.call('setPageFollow', {
        params: { nodeId: page.id },
        body: { following: true },
      });
      await owner.api.call('setPageFollow', {
        params: { nodeId: page.id },
        body: { following: true },
      });
      expect((await mert.api.call('getPage', { params: { nodeId: page.id } })).following).toBe(
        true,
      );

      await edit(page.id, 'İkinci hali.', ownerId);
      const [n] = await waitForInbox(mert, (items) =>
        items.some((x) => x.type === 'page.updated' && x.target.id === page.id),
      );
      expect(n).toMatchObject({
        type: 'page.updated',
        category: 'share',
        actor: { name: 'Ahmet Buğra Kösen' },
        data: { name: 'Takip' },
        url: pagePath(page),
      });
      expect(await updates(owner, page.id)).toHaveLength(0);
      expect(await updates(selin, page.id)).toHaveLength(0);
    });

    it('sends one notice for a run of edits, and the next after an hour', async () => {
      const ownerId = (await owner.api.call('me')).user.id;
      const page = await followedPage('Sık düzenlenen');
      await mert.api.call('setPageFollow', {
        params: { nodeId: page.id },
        body: { following: true },
      });
      await edit(page.id, 'Bir.', ownerId);
      await waitForInbox(mert, (items) =>
        items.some((x) => x.type === 'page.updated' && x.target.id === page.id),
      );
      const stamped = async () =>
        (
          await app.deps.db
            .select({ at: nodeUserState.followNotifiedAt })
            .from(nodeUserState)
            .where(eq(nodeUserState.nodeId, page.id))
        )[0]!.at!.getTime();
      const first = await stamped();
      await edit(page.id, 'İki.', ownerId);
      await edit(page.id, 'Üç.', ownerId);
      await sleep(200);
      expect(await stamped()).toBe(first);

      await hourLater(page.id);
      const old = await stamped();
      await edit(page.id, 'Dört.', ownerId);
      await sleep(200);
      expect(await stamped()).toBeGreaterThan(old);
    });

    it('does not notify for a derive that changed nothing', async () => {
      const ownerId = (await owner.api.call('me')).user.id;
      const page = await followedPage('Değişmeyen');
      await mert.api.call('setPageFollow', {
        params: { nodeId: page.id },
        body: { following: true },
      });
      await edit(page.id, 'İlk hali.', ownerId);
      await sleep(200);
      expect(await updates(mert, page.id)).toHaveLength(0);
    });

    it('stops when someone stops following or can no longer read the page', async () => {
      const ownerId = (await owner.api.call('me')).user.id;
      const page = await followedPage('Bırakılan');
      await mert.api.call('setPageFollow', {
        params: { nodeId: page.id },
        body: { following: true },
      });
      await mert.api.call('setPageFollow', {
        params: { nodeId: page.id },
        body: { following: false },
      });
      await edit(page.id, 'Yeni.', ownerId);
      await sleep(200);
      expect(await updates(mert, page.id)).toHaveLength(0);

      const secret = await owner.api.call('createSpace', { body: { name: 'Gizli', color: 's5' } });
      const hidden = await owner.api.call('createPage', {
        params: { spaceId: secret.id },
        body: { name: 'Gizli sayfa', markdown: 'İlk.' },
      });
      await derivePage(app.deps, hidden.id, true);
      await expect(
        mert.api.call('setPageFollow', {
          params: { nodeId: hidden.id },
          body: { following: true },
        }),
      ).rejects.toThrow();
      // A follow left over from when the person could read it.
      const [org] = await app.deps.db.select().from(organizations);
      await app.deps.db
        .insert(nodeUserState)
        .values({ userId: mertId, nodeId: hidden.id, orgId: org!.id, following: true });
      await edit(hidden.id, 'Yeni.', ownerId);
      await sleep(200);
      expect(await updates(mert, hidden.id)).toHaveLength(0);
    });

    it('with sub-pages: a change anywhere below notifies, once an hour per page', async () => {
      const ownerId = (await owner.api.call('me')).user.id;
      const parent = await followedPage('Üst');
      const child = await owner.api.call('createPage', {
        params: { spaceId },
        body: { name: 'Alt', markdown: 'İlk hali.', parentId: parent.id },
      });
      const grandchild = await owner.api.call('createPage', {
        params: { spaceId },
        body: { name: 'Torun', markdown: 'İlk hali.', parentId: child.id },
      });
      await derivePage(app.deps, child.id, true);
      await derivePage(app.deps, grandchild.id, true);

      // Following the page alone says nothing about its sub-pages.
      await mert.api.call('setPageFollow', {
        params: { nodeId: parent.id },
        body: { following: true },
      });
      await edit(child.id, 'Değişti.', ownerId);
      await sleep(200);
      expect(await updates(mert, child.id)).toHaveLength(0);

      await mert.api.call('setPageFollow', {
        params: { nodeId: parent.id },
        body: { following: true, descendants: true },
      });
      // Selin follows both the parent (with sub-pages) and the grandchild: one notice each time.
      await selin.api.call('setPageFollow', {
        params: { nodeId: parent.id },
        body: { following: true, descendants: true },
      });
      await selin.api.call('setPageFollow', {
        params: { nodeId: grandchild.id },
        body: { following: true },
      });
      const page = await mert.api.call('getPage', { params: { nodeId: parent.id } });
      expect(page).toMatchObject({ following: true, followingDescendants: true });
      expect((await mert.api.call('getPage', { params: { nodeId: child.id } })).following).toBe(
        false,
      );

      await edit(grandchild.id, 'Torun değişti.', ownerId);
      const [n] = await waitForInbox(mert, (items) =>
        items.some((x) => x.type === 'page.updated' && x.target.id === grandchild.id),
      );
      expect(n).toMatchObject({ data: { name: 'Torun' }, url: pagePath(grandchild) });
      await waitForInbox(selin, (items) =>
        items.some((x) => x.type === 'page.updated' && x.target.id === grandchild.id),
      );
      expect(await updates(selin, grandchild.id)).toHaveLength(1);
      expect(await updates(owner, grandchild.id)).toHaveLength(0);

      // Another sub-page is its own page; the same one again waits for the hour.
      await edit(child.id, 'Yine değişti.', ownerId);
      await waitForInbox(mert, (items) =>
        items.some((x) => x.type === 'page.updated' && x.target.id === child.id),
      );
      const stamp = async () =>
        (
          await app.deps.db
            .select({ at: nodeUserState.followNotifiedAt })
            .from(nodeUserState)
            .where(eq(nodeUserState.nodeId, grandchild.id))
        )
          .map((r) => r.at?.getTime() ?? 0)
          .sort();
      const before = await stamp();
      await edit(grandchild.id, 'Torun yine değişti.', ownerId);
      await sleep(200);
      expect(await stamp()).toEqual(before);
      await hourLater(grandchild.id);
      const old = await stamp();
      await edit(grandchild.id, 'Bir saat sonra.', ownerId);
      await sleep(200);
      expect((await stamp()).every((at, i) => at > old[i]!)).toBe(true);

      // The throttle row of a sub-page is not a follow of it.
      expect(
        (await mert.api.call('getPage', { params: { nodeId: grandchild.id } })).following,
      ).toBe(false);

      // An old client that only says "following" keeps the sub-pages; stopping clears them.
      await mert.api.call('setPageFollow', {
        params: { nodeId: parent.id },
        body: { following: true },
      });
      expect(
        (await mert.api.call('getPage', { params: { nodeId: parent.id } })).followingDescendants,
      ).toBe(true);
      await mert.api.call('setPageFollow', {
        params: { nodeId: parent.id },
        body: { following: false },
      });
      expect(await mert.api.call('getPage', { params: { nodeId: parent.id } })).toMatchObject({
        following: false,
        followingDescendants: false,
      });
      await mert.api.call('setPageFollow', {
        params: { nodeId: parent.id },
        body: { following: true },
      });
      expect(
        (await mert.api.call('getPage', { params: { nodeId: parent.id } })).followingDescendants,
      ).toBe(false);
    });

    it('keeps one unread row per page', () => {
      expect(
        noticeInputs(
          {
            type: 'page.updated',
            orgId: 'o',
            spaceId: 's',
            nodeId: 'n',
            pageName: 'Sayfa',
            actorId: 'a',
            userIds: ['u1'],
            url: '/p/sayfa-n',
          },
          'Buğra',
        )[0],
      ).toMatchObject({ category: 'share', groupKey: 'page.updated:n' });
    });
  });

  it('maps every notice type to a category and groups replies per thread', () => {
    const base = {
      orgId: 'o',
      spaceId: 's',
      nodeId: 'n',
      pageName: 'Sayfa',
      actorId: 'a',
      userIds: ['u1', 'u2'],
      url: '/p/sayfa-n',
    };
    const restored = noticeInputs({ ...base, type: 'page.restored' }, 'Buğra');
    expect(restored.map((r) => [r.userId, r.category, r.groupKey])).toEqual([
      ['u1', 'share', null],
      ['u2', 'share', null],
    ]);
    expect(restored[0]!.data).toEqual({ name: 'Sayfa', actorName: 'Buğra' });
    const reply = noticeInputs({ ...base, type: 'page.comment_reply', threadId: 't' }, null);
    expect(reply[0]).toMatchObject({ category: 'direct_reply', groupKey: 'page.comment_reply:t' });
  });
});
