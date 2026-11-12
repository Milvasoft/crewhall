import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chatGifSettings } from '@crewhall/db';
import { GIF_BUDGET } from '@crewhall/shared';
import { clearGifCache } from '../src/services/chat/gif';
import { uuid } from './chat-helpers';
import { Client, createTestApp, join, setupWithOwner, type TestApp } from './helpers';

/** GIFs through GIPHY with the org's own key; GIPHY is a local stub here. */

const KEY = 'giphy-test-key-123456';
const calls: URL[] = [];
let stub: Server;
let stubUrl: string;

const item = (id: string, host = 'media1.giphy.com') => ({
  id,
  title: `gif ${id}`,
  images: {
    fixed_width: { url: `https://${host}/media/${id}/200w.gif`, width: '200', height: '113' },
    downsized: { url: `https://${host}/media/${id}/giphy.gif`, width: '480', height: '270' },
    fixed_width_still: {
      url: `https://${host}/media/${id}/200w_s.gif`,
      width: '200',
      height: '113',
    },
  },
});

let app: TestApp;
let owner: Client;
let elif: Client;
let groupId: string;

beforeAll(async () => {
  stub = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://stub');
    calls.push(url);
    res.setHeader('content-type', 'application/json');
    if (url.searchParams.get('api_key') !== KEY) {
      res.statusCode = 401;
      res.end(JSON.stringify({ message: 'Unauthorized' }));
      return;
    }
    const data =
      url.pathname === '/v1/gifs/search'
        ? [item('s1'), item('s2')]
        : [item('t1'), item('t2'), item('evil', 'evil.example')];
    res.end(JSON.stringify({ data, pagination: { total_count: 100, count: data.length } }));
  });
  await new Promise<void>((r) => stub.listen(0, '127.0.0.1', () => r()));
  stubUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
  app = await createTestApp({ GIPHY_API_URL: stubUrl });
  owner = (await setupWithOwner(app)).owner;
  const spaces = await owner.api.call('listSpaces');
  const spaceId = spaces.items.find((s) => s.name === 'Milvasoft')!.id;
  elif = (await join(app, owner, 'elif@milvasoft.com', 'member', [spaceId])).person;
  const can = (await join(app, owner, 'can@milvasoft.com', 'member', [spaceId])).person;
  const ids = await Promise.all([elif, can].map(async (c) => (await c.api.call('me')).user.id));
  groupId = (await owner.api.call('createConversation', { body: { type: 'group', userIds: ids } }))
    .id;
});

afterAll(async () => {
  await app.close();
  await new Promise<void>((r) => stub.close(() => r()));
});

const gif = {
  provider: 'giphy' as const,
  id: 't1',
  url: 'https://media1.giphy.com/media/t1/giphy.gif',
  width: 480,
  height: 270,
  title: 'gif t1',
};

describe('GIF (GIPHY)', () => {
  it('is off without a key: no capability, proxy and messages refused', async () => {
    await expect(elif.api.call('trendingGifs')).rejects.toMatchObject({
      status: 409,
      code: 'gif_disabled',
    });
    const boot = await owner.api.call('bootstrap');
    expect(boot.server?.capabilities).not.toContain('chat.gif');
    await expect(
      elif.api.call('sendMessage', {
        params: { conversationId: groupId },
        body: { clientMsgId: uuid(), gif },
      }),
    ).rejects.toMatchObject({ code: 'gif_disabled' });
  });

  it('lets only admins set the key, which is stored encrypted and never returned', async () => {
    await expect(elif.api.call('getGifSettings')).rejects.toMatchObject({ status: 403 });
    await expect(
      elif.api.call('updateGifSettings', { body: { apiKey: KEY, enabled: true } }),
    ).rejects.toMatchObject({ status: 403 });
    const s = await owner.api.call('updateGifSettings', {
      body: { apiKey: KEY, enabled: true, rating: 'pg', lang: 'tr' },
    });
    expect(s).toMatchObject({ enabled: true, active: true, rating: 'pg', lang: 'tr' });
    expect(s.apiKey.set).toBe(true);
    expect(JSON.stringify(s)).not.toContain(KEY);
    const [row] = await app.deps.db.select().from(chatGifSettings);
    expect(row?.apiKeyEnc).toBeTruthy();
    expect(row?.apiKeyEnc).not.toContain(KEY);
    expect(await owner.api.call('testGifSettings')).toMatchObject({ ok: true, count: 2 });
    const boot = await owner.api.call('bootstrap');
    expect(boot.server?.capabilities).toContain('chat.gif');
  });

  it('proxies trending and search with the key, rating and language; drops foreign media', async () => {
    clearGifCache();
    calls.length = 0;
    const trending = await elif.api.call('trendingGifs', { query: { limit: 3 } });
    expect(trending.items.map((g) => g.id)).toEqual(['t1', 't2']);
    expect(trending.items[0]).toMatchObject({
      url: 'https://media1.giphy.com/media/t1/giphy.gif',
      width: 480,
      height: 270,
      previewUrl: 'https://media1.giphy.com/media/t1/200w.gif',
    });
    expect(trending.nextOffset).toBe(3);
    const t = calls.at(-1)!;
    expect(t.searchParams.get('rating')).toBe('pg');

    const search = await elif.api.call('searchGifs', { query: { q: 'kedi', limit: 2 } });
    expect(search.items.map((g) => g.id)).toEqual(['s1', 's2']);
    const s = calls.at(-1)!;
    expect(s.pathname).toBe('/v1/gifs/search');
    expect(s.searchParams.get('q')).toBe('kedi');
    expect(s.searchParams.get('lang')).toBe('tr');
    // The same search within a minute comes from the cache.
    const before = calls.length;
    await elif.api.call('searchGifs', { query: { q: 'kedi', limit: 2 } });
    expect(calls.length).toBe(before);
  });

  it('sends a GIF message from GIPHY media only', async () => {
    const m = await elif.api.call('sendMessage', {
      params: { conversationId: groupId },
      body: { clientMsgId: uuid(), gif },
    });
    expect(m.gif).toMatchObject({ provider: 'giphy', id: 't1', width: 480 });
    expect(m.text).toBe('');
    // The list row reads "GIF", not an empty line.
    const conv = await owner.api.call('getConversation', { params: { conversationId: groupId } });
    expect(conv.lastMessage?.excerpt).toBe('GIF');
    // So do the notification (and the push built from it) in a direct chat.
    const ownerId = (await owner.api.call('me')).user.id;
    const direct = await elif.api.call('createConversation', {
      body: { type: 'direct', userId: ownerId },
    });
    await elif.api.call('sendMessage', {
      params: { conversationId: direct.id },
      body: { clientMsgId: uuid(), gif },
    });
    const bell = await owner.api.call('listNotifications');
    const note = bell.items.find(
      (n) => n.type === 'chat.direct' && n.target.conversationId === direct.id,
    );
    expect(note?.data.excerpt).toBe('GIF');
    await expect(
      elif.api.call('sendMessage', {
        params: { conversationId: groupId },
        body: {
          clientMsgId: uuid(),
          gif: { ...gif, url: 'https://evil.example/media/t1/giphy.gif' },
        },
      }),
    ).rejects.toMatchObject({ code: 'invalid_target' });
  });

  it('shares one GIPHY call between identical requests arriving together', async () => {
    clearGifCache();
    calls.length = 0;
    const [a, b] = await Promise.all([
      elif.api.call('searchGifs', { query: { q: 'kopek', limit: 2 } }),
      elif.api.call('searchGifs', { query: { q: 'Kopek', limit: 2 } }),
    ]);
    expect(a.items).toEqual(b.items);
    expect(calls.filter((c) => c.pathname === '/v1/gifs/search')).toHaveLength(1);
  });

  it('stops at the hourly budget of a beta key without calling GIPHY', async () => {
    clearGifCache();
    await app.deps.db
      .update(chatGifSettings)
      .set({ usageHour: sql`date_trunc('hour', now())`, usageCount: GIF_BUDGET.beta });
    const settings = await owner.api.call('getGifSettings');
    expect(settings.keyTier).toBe('beta');
    expect(settings.usage).toMatchObject({ used: GIF_BUDGET.beta, limit: GIF_BUDGET.beta });
    calls.length = 0;
    await expect(elif.api.call('trendingGifs', { query: { limit: 7 } })).rejects.toMatchObject({
      status: 429,
      code: 'gif_busy',
    });
    expect(calls).toHaveLength(0);
    // A production key has no hourly budget.
    const prod = await owner.api.call('updateGifSettings', { body: { keyTier: 'production' } });
    expect(prod.usage.limit).toBeNull();
    const page = await elif.api.call('trendingGifs', { query: { limit: 7 } });
    expect(page.items.length).toBeGreaterThan(0);
    expect(calls).toHaveLength(1);
    expect((await owner.api.call('getGifSettings')).usage.used).toBe(GIF_BUDGET.beta + 1);
  });

  it('reports a wrong key on the test and as a provider error in chat', async () => {
    await owner.api.call('updateGifSettings', { body: { apiKey: 'wrong-key-0000000000' } });
    expect(await owner.api.call('testGifSettings')).toMatchObject({ ok: false, error: '401' });
    clearGifCache();
    await expect(elif.api.call('trendingGifs')).rejects.toMatchObject({
      status: 502,
      code: 'gif_provider_error',
    });
  });
});
