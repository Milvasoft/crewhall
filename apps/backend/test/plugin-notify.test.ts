import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLogs, notifications, users } from '@crewhall/db';
import { ApiError } from '@crewhall/api-client';
import { generateSigningKey, PluginManifest, signPackage } from '@crewhall/plugin-sdk';
import {
  CrewhallApiError,
  createServerClient,
  LifecycleRequest,
  NOTIFICATIONS_CLEAR_PATH,
  NOTIFICATIONS_PATH,
  pluginTabUrl,
  signRequest,
} from '@crewhall/plugin-sdk/server';
import type { PluginInstallation } from '@crewhall/shared';
import { expoStub } from './chat-helpers';
import { Client, createTestApp, join, setupWithOwner, type TestApp } from './helpers';

/**
 * Plugin notifications end to end: a plugin server, as its installation (no person), notifies
 * people who opened it; signature, scope, linked people, deep links, collapse, rate limits,
 * the person's per-plugin mode and push.
 */

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

async function listen(app: { fetch: (r: Request) => Response | Promise<Response> }, port: number) {
  return new Promise<Server>((resolve) => {
    const s = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, () =>
      resolve(s as Server),
    ) as Server;
  });
}

const closeServer = (s: Server) =>
  new Promise<void>((r) => {
    s.closeAllConnections?.();
    s.close(() => r());
  });

let app: TestApp;
let servers: Server[] = [];
let expo: Awaited<ReturnType<typeof expoStub>>;
let apiUrl: string;
let owner: Client;
let elif: Client;
let elifId: string;
let canId: string;
let inst: PluginInstallation;
/** The installation secret the fake plugin server got at install. */
let secret = '';
const ID = 'com.example.notify';

const client = () => createServerClient({ apiUrl, installationId: inst.id, secret });

async function expectCode(p: Promise<unknown>, status: number, code?: string) {
  try {
    await p;
  } catch (err) {
    const e = err as ApiError | CrewhallApiError;
    expect(e.status).toBe(status);
    if (code) expect(e.code).toBe(code);
    return e.details;
  }
  throw new Error(`expected ${status}`);
}

const rows = (userId: string) =>
  app.deps.db
    .select()
    .from(notifications)
    .where(and(eq(notifications.userId, userId), eq(notifications.type, 'plugin.notification')));

beforeAll(async () => {
  const key = await generateSigningKey();
  const [cPort, mPort, pPort] = [await freePort(), await freePort(), await freePort()];
  apiUrl = `http://127.0.0.1:${cPort}`;
  const origin = `http://127.0.0.1:${pPort}`;
  const pkg = await signPackage(
    PluginManifest.parse({
      manifestVersion: 1,
      id: ID,
      version: '1.0.0',
      // The full name carries more than the source; notifications show the short one.
      name: 'Notlar (deneme sürümü)',
      notificationName: { tr: 'Notlar', en: 'Notes' },
      description: 'Bildirim gönderen örnek eklenti',
      publisher: { name: 'Example' },
      apiLevel: { min: 1 },
      origin,
      icon: '/icon.png',
      permissions: ['hub:read', 'notifications:write'],
      entryPoints: {
        tabs: [
          { id: 'main', title: 'Notlar', url: '/tab', placement: 'rail' },
          { id: 'inbox', title: 'Gelen', url: '/inbox', placement: 'chat' },
        ],
      },
    }),
    { risk: 'verified', riskNote: null, reviewedAt: new Date().toISOString(), audience: null },
    { keyId: 'test-1', privateKey: key.privateKey },
  );
  const m = new Hono();
  m.get('/v1/catalog', (c) => c.json({ items: [] }));
  m.get('/v1/plugins/:id/versions/:version/package', (c) => c.json(pkg));
  const p = new Hono();
  p.post('/crewhall/lifecycle', async (c) => {
    const req = LifecycleRequest.parse(JSON.parse(await c.req.text()));
    if (req.type === 'install') secret = req.secret;
    return c.json({ ok: true });
  });
  expo = await expoStub();
  servers = [await listen(m, mPort), await listen(p, pPort)];
  app = await createTestApp({
    API_URL: apiUrl,
    MARKETPLACE_URL: `http://127.0.0.1:${mPort}`,
    MARKETPLACE_PUBLIC_KEYS: `test-1:${key.publicKey}`,
    EXPO_PUSH_URL: expo.url,
  });
  servers.push(await listen(app.app, cPort));
  ({ owner } = await setupWithOwner(app));
  const spaceId = (await owner.api.call('listSpaces')).items.find(
    (s) => s.name === 'Milvasoft',
  )!.id;
  const e = await join(app, owner, 'elif@milvasoft.com', 'member', [spaceId]);
  elif = e.person;
  elifId = e.me.user.id;
  canId = (await join(app, owner, 'can@milvasoft.com', 'member', [spaceId])).me.user.id;
  inst = await owner.api.call('installPlugin', {
    body: { pluginId: ID, version: '1.0.0', permissions: ['hub:read', 'notifications:write'] },
  });
  await elif.api.call('registerPushDevice', {
    body: { expoToken: 'ExponentPushToken[elif-phone]', platform: 'ios' },
  });
}, 120_000);

afterAll(async () => {
  await Promise.all(servers.map(closeServer));
  await expo?.close();
  await app?.close();
});

describe('plugin notifications', () => {
  it('only reaches people who opened the plugin', async () => {
    await expectCode(
      client().notify({ userId: elifId, title: 'Merhaba' }),
      403,
      'plugin_user_not_linked',
    );
    await expectCode(
      client().notify({ userId: 'not-a-uuid', title: 'Merhaba' }),
      403,
      'plugin_user_not_linked',
    );
    // Elif opens the plugin: the frame asks for a session token.
    await elif.api.call('createPluginSessionToken', { params: { installationId: inst.id } });
    const deep = pluginTabUrl({
      installationId: inst.id,
      tab: 'inbox',
      placement: 'chat',
      search: { chat: '42' },
    });
    const res = await client().notify({
      userId: elifId,
      title: 'Ayşe',
      body: 'Yarın görüşelim mi?',
      url: deep,
    });
    expect(res).toMatchObject({ delivered: true, collapsed: false });
    // Can never opened it.
    await expectCode(client().notify({ userId: canId, title: 'x' }), 403, 'plugin_user_not_linked');

    const list = await elif.api.call('listNotifications', { query: {} });
    const n = list.items.find((x) => x.id === res.id)!;
    expect(n).toMatchObject({
      type: 'plugin.notification',
      source: 'alerts',
      url: `/chat/plugins/${inst.id}/inbox?chat=42`,
      target: { type: 'plugin', id: inst.id },
      data: { plugin: 'Notlar', title: 'Ayşe', excerpt: 'Yarın görüşelim mi?' },
    });
    expect(n.data.icon).toMatch(/\/icon\.png$/);
    // The phone got it, titled by the plugin, opening the deep link.
    expect(expo.sent.at(-1)).toMatchObject({
      to: 'ExponentPushToken[elif-phone]',
      title: 'Notlar · Ayşe',
      body: 'Yarın görüşelim mi?',
      data: { type: 'plugin.notification', url: `/chat/plugins/${inst.id}/inbox?chat=42` },
    });
    const [audit] = await app.deps.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'plugin.notify'), eq(auditLogs.targetId, inst.id)));
    expect(audit!.meta).toMatchObject({ pluginId: ID, userId: elifId });

    // In the recipient's language, on the bell and the phone alike.
    await app.deps.db.update(users).set({ locale: 'en' }).where(eq(users.id, elifId));
    try {
      const en = await client().notify({ userId: elifId, title: 'Ayşe' });
      const row = (await elif.api.call('listNotifications', { query: {} })).items.find(
        (x) => x.id === en.id,
      )!;
      expect(row.data).toMatchObject({ plugin: 'Notes' });
      expect(expo.sent.at(-1)).toMatchObject({ title: 'Notes · Ayşe' });
    } finally {
      await app.deps.db.update(users).set({ locale: 'tr' }).where(eq(users.id, elifId));
    }
  });

  it('accepts only the installation signature, made for this direction', async () => {
    const body = JSON.stringify({ userId: elifId, title: 'x' });
    const post = (headers: Record<string, string>) =>
      fetch(new URL(NOTIFICATIONS_PATH, apiUrl), { method: 'POST', headers, body });
    // A signature like Crewhall's own requests to the plugin is not one of these.
    expect((await post(await signRequest(secret, inst.id, body))).status).toBe(401);
    expect((await post(await signRequest('x'.repeat(48), inst.id, body))).status).toBe(401);
    expect((await post({ 'Content-Type': 'application/json' })).status).toBe(401);
    const wrong = createServerClient({ apiUrl, installationId: inst.id, secret: 'y'.repeat(48) });
    await expectCode(wrong.notify({ userId: elifId, title: 'x' }), 401, 'unauthenticated');
  });

  it("links only to the plugin's own tabs, deep links pass through", async () => {
    const send = (url: string) => client().notify({ userId: elifId, title: 'x', url });
    await expectCode(send('/chat/c/123'), 422, 'plugin_url_invalid');
    await expectCode(send(`/plugins/${inst.id}/nope`), 422, 'plugin_url_invalid');
    // `inbox` lives in chat, not in the rail.
    await expectCode(send(`/plugins/${inst.id}/inbox`), 422, 'plugin_url_invalid');
    await expectCode(send('https://evil.example/plugins/x/main'), 422, 'plugin_url_invalid');
    const ok = await send(`/plugins/${inst.id}/main?note=7#top`);
    const [row] = (await rows(elifId)).filter((r) => r.id === ok.id);
    expect(row!.url).toBe(`/plugins/${inst.id}/main?note=7#top`);
    // No url: the plugin's first tab.
    const plain = await client().notify({ userId: elifId, title: 'y' });
    expect((await rows(elifId)).find((r) => r.id === plain.id)!.url).toBe(
      `/plugins/${inst.id}/main`,
    );
  });

  it('collapses notifications with the same thread key', async () => {
    const a = await client().notify({
      userId: elifId,
      title: 'Ayşe',
      body: '1',
      threadKey: 'ayse',
    });
    const b = await client().notify({
      userId: elifId,
      title: 'Ayşe',
      body: '2',
      threadKey: 'ayse',
    });
    expect(a.collapsed).toBe(false);
    expect(b).toMatchObject({ id: a.id, collapsed: true });
    const row = (await rows(elifId)).find((r) => r.id === a.id)!;
    expect(row.count).toBe(2);
    expect(row.payload.excerpt).toBe('2');
  });

  it('follows the per-plugin mode: on, muted (bell only), off', async () => {
    const prefs = await elif.api.call('listPluginNotificationPrefs');
    expect(prefs.items).toEqual([
      expect.objectContaining({
        installationId: inst.id,
        pluginId: ID,
        mode: 'on',
        channels: { bell: true, desktop: true, push: true },
        showOnMobile: true,
        canNotify: true,
      }),
    ]);
    // The owner never opened it: listed (for "show on mobile"), but it cannot notify them.
    expect((await owner.api.call('listPluginNotificationPrefs')).items).toEqual([
      expect.objectContaining({ installationId: inst.id, canNotify: false }),
    ]);

    await elif.api.call('updatePluginNotificationPref', {
      params: { installationId: inst.id },
      body: { mode: 'muted' },
    });
    const pushes = expo.sent.length;
    const muted = await client().notify({ userId: elifId, title: 'Sessiz' });
    const row = (await rows(elifId)).find((r) => r.id === muted.id)!;
    expect(row.wantsPush).toBe(false);
    expect(row.dismissedAt).toBeNull();
    expect(expo.sent.length).toBe(pushes);

    await elif.api.call('updatePluginNotificationPref', {
      params: { installationId: inst.id },
      body: { mode: 'off' },
    });
    const before = (await rows(elifId)).length;
    expect(await client().notify({ userId: elifId, title: 'Kapalı' })).toEqual({
      id: null,
      collapsed: false,
      delivered: false,
    });
    expect((await rows(elifId)).length).toBe(before);
    await expectCode(
      owner.api.call('updatePluginNotificationPref', {
        params: { installationId: '01a157ef-56c0-7944-8111-dcb4b723bf46' },
        body: { mode: 'on' },
      }),
      404,
      'plugin_not_found',
    );
    await elif.api.call('updatePluginNotificationPref', {
      params: { installationId: inst.id },
      body: { mode: 'on' },
    });
  });

  it('follows each channel on its own, and keeps the old mode in step', async () => {
    const set = (body: {
      mode?: 'on' | 'muted' | 'off';
      channels?: { bell?: boolean; desktop?: boolean; push?: boolean };
      showOnMobile?: boolean;
    }) =>
      elif.api.call('updatePluginNotificationPref', { params: { installationId: inst.id }, body });
    // On the desktop only: the bell and its toast, never a phone push.
    expect(await set({ channels: { push: false } })).toMatchObject({
      mode: 'on',
      channels: { bell: true, desktop: true, push: false },
    });
    let pushes = expo.sent.length;
    const desktopOnly = await client().notify({ userId: elifId, title: 'Masaüstü' });
    let row = (await rows(elifId)).find((r) => r.id === desktopOnly.id)!;
    expect(row).toMatchObject({ wantsPush: false, dismissedAt: null });
    expect(expo.sent.length).toBe(pushes);
    let listed = (await elif.api.call('listNotifications', { query: {} })).items.find(
      (n) => n.id === desktopOnly.id,
    )!;
    // API 34: every row says whether it shows on the desktop.
    expect(listed.desktop).toBe(true);

    // The bell without the desktop toast.
    expect(await set({ channels: { desktop: false } })).toMatchObject({ mode: 'muted' });
    const bellOnly = await client().notify({ userId: elifId, title: 'Zil' });
    listed = (await elif.api.call('listNotifications', { query: {} })).items.find(
      (n) => n.id === bellOnly.id,
    )!;
    expect(listed.desktop).toBe(false);
    expect(listed.data).not.toHaveProperty('desktop');

    // The phone only: a push, no bell row.
    await set({ channels: { bell: false, desktop: false, push: true } });
    pushes = expo.sent.length;
    const phone = await client().notify({ userId: elifId, title: 'Telefon' });
    row = (await rows(elifId)).find((r) => r.id === phone.id)!;
    expect(row.dismissedAt).not.toBeNull();
    expect(expo.sent.length).toBe(pushes + 1);

    // An old client's mode sets every channel.
    expect(await set({ mode: 'off' })).toMatchObject({
      channels: { bell: false, desktop: false, push: false },
    });
    expect((await client().notify({ userId: elifId, title: 'x' })).delivered).toBe(false);
    expect(await set({ mode: 'on' })).toMatchObject({
      channels: { bell: true, desktop: true, push: true },
    });
  });

  it('hides the plugin from the mobile apps when the person turns it off there', async () => {
    const surfaces = (client: string | null) =>
      elif.raw<{ items: { installationId: string; hiddenOnMobile?: boolean }[] }>(
        'GET',
        '/api/v1/plugins/surfaces',
        undefined,
        client ? { 'X-Crewhall-Client': client } : {},
      );
    expect((await surfaces('android/9.9.9')).body.items.map((s) => s.installationId)).toContain(
      inst.id,
    );
    await elif.api.call('updatePluginNotificationPref', {
      params: { installationId: inst.id },
      body: { showOnMobile: false },
    });
    expect((await surfaces('android/9.9.9')).body.items).toEqual([]);
    expect((await surfaces('ios/9.9.9')).body.items).toEqual([]);
    // The web still has it, flagged.
    expect((await surfaces(null)).body.items).toEqual([
      expect.objectContaining({ installationId: inst.id, hiddenOnMobile: true }),
    ]);
    // Only for Elif.
    expect((await owner.api.call('listPluginSurfaces')).items[0]?.hiddenOnMobile).toBe(false);
    await elif.api.call('updatePluginNotificationPref', {
      params: { installationId: inst.id },
      body: { showOnMobile: true },
    });
  });

  it('clears what it sent when the person reads it in the plugin', async () => {
    const unread = async () =>
      (await elif.api.call('listNotifications', { query: {} })).items.filter((n) => !n.readAt)
        .length;
    const a = await client().notify({ userId: elifId, title: 'Ayşe', threadKey: 'chat-42' });
    await client().notify({ userId: elifId, title: 'Ayşe', threadKey: 'chat-42' });
    const other = await client().notify({ userId: elifId, title: 'Can', threadKey: 'chat-7' });
    const before = await unread();

    expect(await client().clearNotifications({ userId: elifId, threadKey: 'chat-42' })).toEqual({
      cleared: 1,
    });
    expect(await unread()).toBe(before - 1);
    const all = await rows(elifId);
    expect(all.find((r) => r.id === a.id)!.readAt).not.toBeNull();
    expect(all.find((r) => r.id === other.id)!.readAt).toBeNull();
    // Already read, or a key never sent: nothing to do, not an error.
    expect(await client().clearNotifications({ userId: elifId, threadKey: 'chat-42' })).toEqual({
      cleared: 0,
    });
    expect(await client().clearNotifications({ userId: canId, threadKey: 'chat-7' })).toEqual({
      cleared: 0,
    });
    // A new message after that is a new, unread notification.
    const again = await client().notify({ userId: elifId, title: 'Ayşe', threadKey: 'chat-42' });
    expect(again).toMatchObject({ collapsed: false });
    expect(again.id).not.toBe(a.id);

    expect(
      await client().clearNotifications({ userId: elifId, threadKey: 'chat-7', action: 'dismiss' }),
    ).toEqual({ cleared: 1 });
    const gone = (await rows(elifId)).find((r) => r.id === other.id)!;
    expect(gone.dismissedAt).not.toBeNull();

    // Only with the installation's signature, in this direction.
    const body = JSON.stringify({ userId: elifId, threadKey: 'chat-42' });
    const res = await fetch(new URL(NOTIFICATIONS_CLEAR_PATH, apiUrl), {
      method: 'POST',
      headers: await signRequest(secret, inst.id, body),
      body,
    });
    expect(res.status).toBe(401);
    expect((await rows(elifId)).find((r) => r.id === again.id)!.readAt).toBeNull();
    await client().clearNotifications({ userId: elifId, threadKey: 'chat-42' });
  });

  it('pins a tab to the rail for one person', async () => {
    const pin = (who: Client, pinnedTabs: string[]) =>
      who.api.call('updatePluginNotificationPref', {
        params: { installationId: inst.id },
        body: { pinnedTabs },
      });
    const surface = async (who: Client) =>
      (await who.api.call('listPluginSurfaces')).items.find((s) => s.installationId === inst.id)!;
    expect((await surface(elif)).pinnedTabs).toEqual([]);
    expect(await pin(elif, ['inbox'])).toMatchObject({ pinnedTabs: ['inbox'] });
    expect((await surface(elif)).pinnedTabs).toEqual(['inbox']);
    expect((await elif.api.call('listPluginNotificationPrefs')).items[0]?.pinnedTabs).toEqual([
      'inbox',
    ]);
    // Only this person's rail, and their other settings stay.
    expect((await surface(owner)).pinnedTabs).toEqual([]);
    expect((await elif.api.call('listPluginNotificationPrefs')).items[0]?.channels).toEqual({
      bell: true,
      desktop: true,
      push: true,
    });
    await expectCode(pin(elif, ['nope']), 422, 'validation_failed');

    // A notification from a pinned chat tab opens where this person uses it, deep link included.
    const deep = pluginTabUrl({
      installationId: inst.id,
      tab: 'inbox',
      placement: 'chat',
      search: { chat: '7' },
    });
    const urlOf = async (title: string) => {
      const { id } = await client().notify({ userId: elifId, title, url: deep });
      return (await elif.api.call('listNotifications', { query: {} })).items.find(
        (x) => x.id === id,
      )!.url;
    };
    expect(await urlOf('Sol menüden')).toBe(`/plugins/${inst.id}/inbox?chat=7`);
    expect(await pin(elif, [])).toMatchObject({ pinnedTabs: [] });
    expect(await urlOf('Sohbetten')).toBe(`/chat/plugins/${inst.id}/inbox?chat=7`);
  });

  it('limits how often one person is notified', async () => {
    let limited: unknown = null;
    for (let i = 0; i < 30 && !limited; i++) {
      limited = await client()
        .notify({ userId: elifId, title: 'Çok', threadKey: 'flood' })
        .then(() => null)
        .catch((e: unknown) => e);
    }
    expect(limited).toBeInstanceOf(CrewhallApiError);
    expect((limited as CrewhallApiError).status).toBe(429);
    expect((limited as CrewhallApiError).code).toBe('rate_limited');
  });

  it('stops when the permission is taken back, the plugin is off or removed', async () => {
    await owner.api.call('updatePluginInstallation', {
      params: { installationId: inst.id },
      body: { permissions: ['hub:read'] },
    });
    await expectCode(client().notify({ userId: elifId, title: 'x' }), 403, 'token_scope');
    // Without the permission its channels no longer apply.
    expect((await elif.api.call('listPluginNotificationPrefs')).items).toEqual([
      expect.objectContaining({ installationId: inst.id, canNotify: false }),
    ]);
    await owner.api.call('updatePluginInstallation', {
      params: { installationId: inst.id },
      body: { permissions: ['hub:read', 'notifications:write'], enabled: false },
    });
    await expectCode(client().notify({ userId: elifId, title: 'x' }), 409, 'plugin_disabled');
    await expectCode(
      client().clearNotifications({ userId: elifId, threadKey: 'chat-42' }),
      409,
      'plugin_disabled',
    );
    await owner.api.call('uninstallPlugin', { params: { installationId: inst.id } });
    await expectCode(client().notify({ userId: elifId, title: 'x' }), 401, 'unauthenticated');
  });
});
