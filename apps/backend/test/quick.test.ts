import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { links } from '@crewhall/db';
import { checkDueLinks } from '../src/services/quick/link-check';
import { keyBetween } from '../src/util/position';
import { Client, createTestApp, join, setupWithOwner, type TestApp } from './helpers';

/** A tiny site for title/favicon fetching and health checks. */
function startSite(): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    const path = req.url ?? '/';
    if (path === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        '<html><head><title>Seq &amp; Logs</title><link rel="icon" href="/icon.png"></head><body>hi</body></html>',
      );
    } else if (path === '/icon.png') {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    } else if (path === '/ok') {
      res.writeHead(200).end('ok');
    } else if (path === '/login') {
      res.writeHead(401).end();
    } else if (path === '/redirect') {
      res.writeHead(302, { location: '/ok' }).end();
    } else if (path === '/slow') {
      setTimeout(() => res.writeHead(200).end('late'), 1700);
    } else if (path === '/head-not-allowed') {
      if (req.method === 'HEAD') res.writeHead(405).end();
      else res.writeHead(200).end('get works');
    } else {
      res.writeHead(502).end('bad gateway');
    }
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, base: `http://127.0.0.1:${port}` });
    }),
  );
}

describe('quick access', () => {
  let app: TestApp;
  let owner: Client;
  let site: { server: Server; base: string };
  let mine: string;
  let spaceSurface: string;

  beforeAll(async () => {
    site = await startSite();
    app = await createTestApp();
    ({ owner } = await setupWithOwner(app));
    const surfaces = await owner.api.call('listSurfaces');
    mine = surfaces.items[0]!.id;
    spaceSurface = surfaces.items.find(
      (s) => s.owner.type === 'space' && s.owner.spaceName === 'Milvasoft',
    )!.id;
  });
  afterAll(async () => {
    await app.close();
    site.server.close();
  });

  it('lists Benim first, then the shared spaces', async () => {
    const { items } = await owner.api.call('listSurfaces');
    expect(items[0]).toMatchObject({ owner: { type: 'user' }, canEdit: true, cardCount: 0 });
    // Space surfaces in Turkish alphabetical order.
    expect(items.slice(1).map((s) => (s.owner.type === 'space' ? s.owner.spaceName : ''))).toEqual([
      'Altyapı',
      'Milvasoft',
    ]);
    expect(items[1]?.canEdit).toBe(true);
  });

  it('previews a pasted URL and creates a link card from it (2.4)', async () => {
    const preview = await owner.api.call('previewLink', { body: { url: `${site.base}/` } });
    expect(preview).toMatchObject({
      title: 'Seq & Logs',
      faviconUrl: `${site.base}/icon.png`,
      existingCardIds: [],
    });
    const card = await owner.api.call('createCard', {
      params: { surfaceId: mine },
      body: { type: 'link', link: { url: `${site.base}/` } },
    });
    expect(card.type).toBe('link');
    expect(card.layout).toEqual({ x: 0, y: 0, w: 2, h: 1 });
    if (card.type !== 'link') throw new Error('type');
    expect(card.config.item.title).toBe('Seq & Logs');
    expect(card.links[card.config.item.linkId]).toMatchObject({
      host: site.base.slice(7),
      health: { status: 'unknown' },
    });
    const again = await owner.api.call('previewLink', { body: { url: `${site.base}/` } });
    expect(again.existingCardIds).toEqual([card.id]);
  });

  it('builds a link group; the same URL is one Link however many cards show it', async () => {
    const group = await owner.api.call('createCard', {
      params: { surfaceId: mine },
      body: {
        type: 'link_group',
        config: { title: 'Tools', sections: [{ title: 'Test' }, { title: 'Prod' }] },
      },
    });
    if (group.type !== 'link_group') throw new Error('type');
    const prod = group.config.sections[1]!.id;
    const withLink = await owner.api.call('addGroupLink', {
      params: { cardId: group.id },
      body: { sectionId: prod, link: { url: `${site.base}/`, title: 'Seq prod' } },
    });
    if (withLink.type !== 'link_group') throw new Error('type');
    const item = withLink.config.sections[1]!.items[0]!;
    expect(item.title).toBe('Seq prod');
    expect(await app.deps.db.select().from(links)).toHaveLength(1);

    const removed = await owner.api.call('removeGroupLink', {
      params: { cardId: group.id, itemId: item.id },
    });
    if (removed.type !== 'link_group') throw new Error('type');
    expect(removed.config.sections[1]!.items).toHaveLength(0);
  });

  it('changes a link card address in place and gives it its own icon', async () => {
    const card = await owner.api.call('createCard', {
      params: { surfaceId: mine },
      body: { type: 'link', link: { url: `${site.base}/ok`, title: 'Eski adres' } },
    });
    if (card.type !== 'link') throw new Error('type');
    // The new address: created once with the site's title and favicon, found the second time.
    const link = await owner.api.call('resolveLink', {
      body: { url: `${site.base}/`, cardId: card.id },
    });
    expect(link).toMatchObject({ url: `${site.base}/`, siteTitle: 'Seq & Logs' });
    expect(link.faviconUrl).toBe(`${site.base}/icon.png`);
    const again = await owner.api.call('resolveLink', { body: { url: `${site.base}/` } });
    expect(again.id).toBe(link.id);

    const updated = await owner.api.call('updateCard', {
      params: { cardId: card.id },
      body: {
        config: {
          item: {
            ...card.config.item,
            linkId: link.id,
            iconUrl: 'https://cdn.example.com/logo.png',
          },
        },
      },
    });
    if (updated.type !== 'link') throw new Error('type');
    expect(updated.id).toBe(card.id);
    expect(updated.config.item).toMatchObject({
      linkId: link.id,
      title: 'Eski adres',
      iconUrl: 'https://cdn.example.com/logo.png',
    });
    // A file of this server may be plain http (development); other plain http is refused.
    const own = await owner.api.call('updateCard', {
      params: { cardId: card.id },
      body: {
        config: { item: { ...updated.config.item, iconUrl: 'http://localhost:5173/api/x.png' } },
      },
    });
    if (own.type !== 'link') throw new Error('type');
    expect(own.config.item.iconUrl).toBe('http://localhost:5173/api/x.png');
    await expect(
      owner.api.call('updateCard', {
        params: { cardId: card.id },
        body: {
          config: { item: { ...updated.config.item, iconUrl: 'http://evil.example.com/x.png' } },
        },
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    // Group items take an icon when they are added.
    const group = await owner.api.call('createCard', {
      params: { surfaceId: mine },
      body: { type: 'link_group', config: { title: 'İkonlu' } },
    });
    const added = await owner.api.call('addGroupLink', {
      params: { cardId: group.id },
      body: { link: { url: `${site.base}/ok`, iconUrl: 'https://cdn.example.com/g.png' } },
    });
    if (added.type !== 'link_group') throw new Error('type');
    expect(added.config.sections[0]!.items[0]!.iconUrl).toBe('https://cdn.example.com/g.png');
  });

  it('lets only people who may edit the card resolve a link for it', async () => {
    const card = await owner.api.call('createCard', {
      params: { surfaceId: spaceSurface },
      body: { type: 'link', link: { url: `${site.base}/ok` } },
    });
    const viewer = (await join(app, owner, 'izleyici@milvasoft.com', 'member')).person;
    await expect(
      viewer.api.call('resolveLink', { body: { url: `${site.base}/`, cardId: card.id } }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/forbidden|not_found/) });
    const guest = (await join(app, owner, 'misafir@milvasoft.com', 'guest')).person;
    await expect(
      guest.api.call('resolveLink', { body: { url: `${site.base}/` } }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('keeps the link group density; absent means normal', async () => {
    const group = await owner.api.call('createCard', {
      params: { surfaceId: mine },
      body: { type: 'link_group', config: { title: 'Sıkı' } },
    });
    if (group.type !== 'link_group') throw new Error('type');
    expect(group.config.density).toBeUndefined();

    const updated = await owner.api.call('updateCard', {
      params: { cardId: group.id },
      body: { config: { ...group.config, density: 'compact' } },
    });
    if (updated.type !== 'link_group') throw new Error('type');
    expect(updated.config.density).toBe('compact');
    const surface = await owner.api.call('getSurface', { params: { surfaceId: mine } });
    const saved = surface.cards.find((c) => c.id === group.id);
    if (saved?.type !== 'link_group') throw new Error('type');
    expect(saved.config.density).toBe('compact');

    await expect(
      owner.raw('PATCH', `/api/v1/cards/${group.id}`, {
        config: { ...group.config, density: 'huge' },
      }),
    ).resolves.toMatchObject({ status: 422, body: { code: 'validation_failed' } });
  });

  it('notes and todos keep their config; a wrong config is refused', async () => {
    const note = await owner.api.call('createCard', {
      params: { surfaceId: mine },
      body: { type: 'note' },
    });
    const updated = await owner.api.call('updateCard', {
      params: { cardId: note.id },
      body: { config: { text: 'Cuma 17:00 sonrası deploy yok', color: 's3', fontSize: 'large' } },
    });
    expect(updated.config).toEqual({
      text: 'Cuma 17:00 sonrası deploy yok',
      color: 's3',
      fontSize: 'large',
    });
    await expect(
      owner.api.call('updateCard', {
        params: { cardId: note.id },
        body: { config: { title: 'x', items: [] } },
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });

    const todo = await owner.raw<{ config: { title: string } }>(
      'POST',
      `/api/v1/surfaces/${mine}/cards`,
      { type: 'todo' },
      { 'Accept-Language': 'tr' },
    );
    expect(todo.body.config.title).toBe('Yapılacaklar');
  });

  it('saves the layout with a revision check (2.2)', async () => {
    const surface = await owner.api.call('getSurface', { params: { surfaceId: mine } });
    const card = surface.cards[0]!;
    const res = await owner.api.call('updateSurfaceLayout', {
      params: { surfaceId: mine },
      body: {
        layoutRev: surface.layoutRev,
        items: [{ cardId: card.id, layout: { x: 4, y: 2, w: 3, h: 2 } }],
        mobileOrder: surface.cards.map((c) => c.id).reverse(),
      },
    });
    expect(res.layoutRev).toBe(surface.layoutRev + 1);
    await expect(
      owner.api.call('updateSurfaceLayout', {
        params: { surfaceId: mine },
        body: { layoutRev: surface.layoutRev },
      }),
    ).rejects.toMatchObject({ status: 409, code: 'conflict' });
    const after = await owner.api.call('getSurface', { params: { surfaceId: mine } });
    expect(after.cards.find((c) => c.id === card.id)?.layout).toEqual({ x: 4, y: 2, w: 3, h: 2 });
    const listed = await owner.api.call('listSurfaces');
    expect(listed.items[0]?.cardCount).toBe(after.cards.length);
  });

  it('keeps hidden cards and widths of the mobile home on the card, for every phone', async () => {
    const note = await owner.api.call('createCard', {
      params: { surfaceId: mine },
      body: { type: 'note', config: { text: 'Mobil', color: 's1', fontSize: 'normal' } },
    });
    const group = await owner.api.call('createCard', {
      params: { surfaceId: mine },
      body: { type: 'link_group', config: { title: 'Mobil grup' } },
    });
    expect(note).toMatchObject({ mobileHidden: false, mobileWidth: null });
    const before = await owner.api.call('getSurface', { params: { surfaceId: mine } });
    const res = await owner.api.call('updateSurfaceLayout', {
      params: { surfaceId: mine },
      body: {
        layoutRev: before.layoutRev,
        mobile: [
          { cardId: note.id, hidden: true, width: 'full' },
          { cardId: group.id, width: 'half' },
        ],
      },
    });
    expect(res.layoutRev).toBe(before.layoutRev + 1);
    // The same rule as the web layout: a stale revision is a conflict.
    await expect(
      owner.api.call('updateSurfaceLayout', {
        params: { surfaceId: mine },
        body: { layoutRev: before.layoutRev, mobile: [{ cardId: note.id, hidden: false }] },
      }),
    ).rejects.toMatchObject({ status: 409, code: 'conflict' });

    // Editing the content keeps the mobile settings, and clients never see where they live.
    await owner.api.call('updateCard', {
      params: { cardId: note.id },
      body: { config: { text: 'Mobil 2', color: 's2', fontSize: 'large' } },
    });
    await owner.api.call('addGroupLink', {
      params: { cardId: group.id },
      body: { link: { url: 'https://mobil.example.com' } },
    });
    let after = await owner.api.call('getSurface', { params: { surfaceId: mine } });
    const n = after.cards.find((c) => c.id === note.id)!;
    expect(n).toMatchObject({ mobileHidden: true, mobileWidth: 'full' });
    expect(n.config).toEqual({ text: 'Mobil 2', color: 's2', fontSize: 'large' });
    expect(after.cards.find((c) => c.id === group.id)).toMatchObject({
      mobileHidden: false,
      mobileWidth: 'half',
    });

    // Showing it again and width back to "from the web" (null); a copy starts plain.
    await owner.api.call('updateSurfaceLayout', {
      params: { surfaceId: mine },
      body: {
        layoutRev: after.layoutRev,
        mobile: [{ cardId: note.id, hidden: false, width: null }],
      },
    });
    const copy = await owner.api.call('duplicateCard', { params: { cardId: group.id } });
    expect(copy).toMatchObject({ mobileHidden: false, mobileWidth: null });
    after = await owner.api.call('getSurface', { params: { surfaceId: mine } });
    expect(after.cards.find((c) => c.id === note.id)).toMatchObject({
      mobileHidden: false,
      mobileWidth: null,
    });
    // Cards of another surface are not touched through this one.
    const other = await owner.api.call('updateSurfaceLayout', {
      params: { surfaceId: spaceSurface },
      body: {
        layoutRev: (await owner.api.call('getSurface', { params: { surfaceId: spaceSurface } }))
          .layoutRev,
        mobile: [{ cardId: group.id, hidden: true }],
      },
    });
    expect(other.layoutRev).toBeGreaterThan(0);
    after = await owner.api.call('getSurface', { params: { surfaceId: mine } });
    expect(after.cards.find((c) => c.id === group.id)?.mobileHidden).toBe(false);
  });

  it('space surfaces: viewers cannot edit but can pin; pins follow the source (2.8)', async () => {
    const note = await owner.api.call('createCard', {
      params: { surfaceId: spaceSurface },
      body: { type: 'note', config: { text: 'Ekip kuralları', color: 's2', fontSize: 'normal' } },
    });
    const burak = await join(app, owner, 'burak@milvasoft.com', 'member');
    const b = burak.person;
    const surfaces = await b.api.call('listSurfaces');
    const space = surfaces.items.find((s) => s.id === spaceSurface)!;
    expect(space.canEdit).toBe(false);
    await expect(
      b.api.call('createCard', { params: { surfaceId: spaceSurface }, body: { type: 'note' } }),
    ).rejects.toMatchObject({ code: 'forbidden' });

    const myId = surfaces.items[0]!.id;
    const pinned = await b.api.call('pinCard', {
      params: { cardId: note.id },
      body: { surfaceId: myId },
    });
    expect(pinned).toMatchObject({ pinnedFrom: { cardId: note.id }, sourceMissing: false });

    await owner.api.call('updateCard', {
      params: { cardId: note.id },
      body: { config: { text: 'Kurallar güncellendi', color: 's2', fontSize: 'normal' } },
    });
    const benim = await b.api.call('getSurface', { params: { surfaceId: myId } });
    expect(benim.cards[0]?.config).toMatchObject({ text: 'Kurallar güncellendi' });

    await owner.api.call('deleteCard', { params: { cardId: note.id } });
    const gone = await b.api.call('getSurface', { params: { surfaceId: myId } });
    expect(gone.cards[0]?.sourceMissing).toBe(true);
    await owner.api.call('restoreCard', { params: { cardId: note.id } });
    const back = await b.api.call('getSurface', { params: { surfaceId: myId } });
    expect(back.cards[0]?.sourceMissing).toBe(false);
    const detached = await b.api.call('updateCard', {
      params: { cardId: pinned.id },
      body: { detach: true },
    });
    expect(detached.pinnedFrom).toBeNull();
  });

  it('node cards hide what the viewer cannot see', async () => {
    const secret = await owner.api.call('createSpace', { body: { name: 'Yönetim', color: 's5' } });
    const folder = await owner.api.call('createFolder', {
      params: { spaceId: secret.id },
      body: { name: 'Bütçe' },
    });
    const card = await owner.api.call('createCard', {
      params: { surfaceId: spaceSurface },
      body: { type: 'node', config: { nodeId: folder.id } },
    });
    expect(card.node?.name).toBe('Bütçe');
    const selin = await join(app, owner, 'selin@milvasoft.com', 'member');
    const view = await selin.person.api.call('getSurface', { params: { surfaceId: spaceSurface } });
    expect(view.cards.find((c) => c.id === card.id)?.node).toBeNull();
  });

  it('page, chat, meeting and vault cards keep ids only; page cards carry the page (H4)', async () => {
    const surfaces = await owner.api.call('listSurfaces');
    const space = surfaces.items.find((x) => x.id === spaceSurface)!.owner;
    if (space.type !== 'space') throw new Error('expected a space surface');
    const page = await owner.api.call('createPage', {
      params: { spaceId: space.spaceId },
      body: { parentId: null, name: 'Kartlık sayfa' },
    });
    const pageCard = await owner.api.call('createCard', {
      params: { surfaceId: mine },
      body: { type: 'page', config: { nodeId: page.id } },
    });
    expect(pageCard.type).toBe('page');
    expect(pageCard.node).toMatchObject({ id: page.id, type: 'page', name: 'Kartlık sayfa' });
    expect(pageCard.layout).toMatchObject({ w: 3, h: 3 });

    const folder = await owner.api.call('createFolder', {
      params: { spaceId: space.spaceId },
      body: { name: 'Sayfa değil' },
    });
    await expect(
      owner.api.call('createCard', {
        params: { surfaceId: mine },
        body: { type: 'page', config: { nodeId: folder.id } },
      }),
    ).rejects.toMatchObject({ status: 404 });

    const id = '0190f0a0-0000-7000-8000-00000000abcd';
    const chat = await owner.api.call('createCard', {
      params: { surfaceId: mine },
      body: { type: 'chat', config: { conversationId: id } },
    });
    expect(chat.config).toEqual({ conversationId: id, limit: 5 });
    const meeting = await owner.api.call('createCard', {
      params: { surfaceId: mine },
      body: { type: 'meeting' },
    });
    expect(meeting.config).toEqual({ spaceId: null });
    const vault = await owner.api.call('createCard', {
      params: { surfaceId: mine },
      body: { type: 'vault_item', config: { vaultId: id, itemId: id } },
    });
    expect(vault.config).toEqual({ vaultId: id, itemId: id });
    expect(vault.layout).toMatchObject({ w: 3, h: 1 });

    const reread = await owner.api.call('getSurface', { params: { surfaceId: mine } });
    expect(reread.cards.find((c) => c.id === pageCard.id)?.node?.id).toBe(page.id);
  });

  it('moves a card to another editable surface and duplicates it', async () => {
    const card = await owner.api.call('createCard', {
      params: { surfaceId: mine },
      body: { type: 'note' },
    });
    const moved = await owner.api.call('moveCard', {
      params: { cardId: card.id },
      body: { surfaceId: spaceSurface },
    });
    expect(moved.surfaceId).toBe(spaceSurface);
    const copy = await owner.api.call('duplicateCard', { params: { cardId: card.id } });
    expect(copy.id).not.toBe(card.id);
    expect(copy.surfaceId).toBe(spaceSurface);
  });
});

describe('link health (doc 17 §10)', () => {
  let app: TestApp;
  let owner: Client;
  let site: { server: Server; base: string };
  let mine: string;

  beforeAll(async () => {
    site = await startSite();
    app = await createTestApp();
    ({ owner } = await setupWithOwner(app));
    mine = (await owner.api.call('listSurfaces')).items[0]!.id;
  });
  afterAll(async () => {
    await app.close();
    site.server.close();
  });

  async function linkCard(path: string) {
    const card = await owner.api.call('createCard', {
      params: { surfaceId: mine },
      body: { type: 'link', link: { url: `${site.base}${path}`, title: path } },
    });
    if (card.type !== 'link') throw new Error('type');
    return card.config.item.linkId;
  }

  it('2xx, 3xx and 401 are up; HEAD falls back to GET', async () => {
    for (const path of ['/ok', '/redirect', '/login', '/head-not-allowed']) {
      const id = await linkCard(path);
      const link = await owner.api.call('checkLinkNow', { params: { linkId: id } });
      expect(link.health.status, path).toBe('up');
    }
  });

  it('a slow answer is a warning', async () => {
    const id = await linkCard('/slow');
    const link = await owner.api.call('checkLinkNow', { params: { linkId: id } });
    expect(link.health).toMatchObject({ status: 'warn', reason: 'slow' });
  });

  it('turns red after 3 failures in a row and green again on success', async () => {
    const id = await linkCard('/broken');
    const statuses = [];
    for (let i = 0; i < 3; i++) {
      statuses.push(
        (await owner.api.call('checkLinkNow', { params: { linkId: id } })).health.status,
      );
    }
    expect(statuses).toEqual(['unknown', 'unknown', 'down']);
    // Failures are re-checked sooner than the 60 s interval until the link is red.
    const [row] = await app.deps.db.select().from(links).where(eq(links.id, id));
    expect(row!.nextCheckAt!.getTime() - row!.lastCheckedAt!.getTime()).toBeGreaterThanOrEqual(
      60_000,
    );
    const down = await owner.api.call('getLink', { params: { linkId: id } });
    expect(down.health).toMatchObject({ httpStatus: 502, reason: 'http_502' });
    expect(down.health.since).toBeTruthy();

    const history = await owner.api.call('getLinkHistory', { params: { linkId: id } });
    expect(history.items).toHaveLength(3);
    expect(history.availability).toBe(0);

    await app.deps.db
      .update(links)
      .set({ url: `${site.base}/ok` })
      .where(eq(links.id, id));
    const back = await owner.api.call('checkLinkNow', { params: { linkId: id } });
    expect(back.health.status).toBe('up');
  });

  it('re-checks a failing link within 30 s, healthy ones on their interval', async () => {
    const failing = await linkCard('/broken-again');
    await owner.api.call('checkLinkNow', { params: { linkId: failing } });
    const [f] = await app.deps.db.select().from(links).where(eq(links.id, failing));
    expect(f!.nextCheckAt!.getTime() - f!.lastCheckedAt!.getTime()).toBeLessThanOrEqual(33_000);
    const healthy = await linkCard('/login');
    await owner.api.call('checkLinkNow', { params: { linkId: healthy } });
    const [h] = await app.deps.db.select().from(links).where(eq(links.id, healthy));
    expect(h!.nextCheckAt!.getTime() - h!.lastCheckedAt!.getTime()).toBeGreaterThanOrEqual(60_000);
  });

  it('the worker loop checks due links shown on cards, once each', async () => {
    const id = await linkCard('/ok');
    const row = async () => (await app.deps.db.select().from(links).where(eq(links.id, id)))[0]!;
    // Due by the database clock, which decides; a Node timestamp may run ahead of it under load.
    await app.deps.db
      .update(links)
      .set({ nextCheckAt: sql`now() - interval '1 minute'` })
      .where(eq(links.id, id));
    const before = (await row()).lastCheckedAt?.getTime() ?? 0;
    await checkDueLinks(app.deps, 50);
    const first = await row();
    expect(first.lastCheckedAt!.getTime()).toBeGreaterThan(before);
    expect(first.nextCheckAt!.getTime()).toBeGreaterThan(first.lastCheckedAt!.getTime());
    // Not due again until its interval has passed.
    await checkDueLinks(app.deps, 50);
    expect((await row()).lastCheckedAt).toEqual(first.lastCheckedAt);
    const link = await owner.api.call('getLink', { params: { linkId: id } });
    expect(link.health.checkedAt).toBe(first.lastCheckedAt!.toISOString());
  });

  it('counts opens and lets editors turn checks off', async () => {
    const id = await linkCard('/ok');
    await owner.api.call('recordLinkOpen', { params: { linkId: id } });
    await owner.api.call('recordLinkOpen', { params: { linkId: id } });
    expect((await owner.api.call('getLink', { params: { linkId: id } })).opens30d).toBe(2);
    const off = await owner.api.call('updateLink', {
      params: { linkId: id },
      body: { checkEnabled: false, intervalSeconds: 300 },
    });
    expect(off).toMatchObject({ checkEnabled: false, intervalSeconds: 300 });
  });
});

describe('fractional positions', () => {
  it('always finds a key in between', () => {
    let a = keyBetween(null, null);
    let b = keyBetween(a, null);
    expect(a < b).toBe(true);
    for (let i = 0; i < 50; i++) {
      const m = keyBetween(a, b);
      expect(a < m && m < b).toBe(true);
      if (i % 2) a = m;
      else b = m;
    }
    expect(keyBetween(null, 'V') < 'V').toBe(true);
  });
});
