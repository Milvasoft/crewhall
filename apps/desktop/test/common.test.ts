import { resources } from '@crewhall/i18n';
import { DEFAULT_THEME, type Call, type Notification } from '@crewhall/shared';
import { describe, expect, it, vi } from 'vitest';
import { badgeBitmap, badgeCount, badgeLabel, withDot } from '../src/common/badge';
import { deepLinkTarget, findDeepLinkArg, parseDeepLink } from '../src/common/deeplink';
import { createTranslator, pickLocale, type Dictionary } from '../src/common/i18n';
import {
  callContent,
  notificationContent,
  NoteGuard,
  notificationTone,
  wantsNativeNotification,
} from '../src/common/notify';
import { RealtimeClient, type SocketLike } from '../src/common/realtime';
import { checkServer, isServerUrl, normalizeServerUrl } from '../src/common/server';
import { feedUrlFor, isNoRelease, updatePlatform } from '../src/common/update';
import { conflictName, localNameProblem } from '../src/sync/names';

const t = createTranslator('tr', resources.tr.web as unknown as Dictionary);
const tEn = createTranslator('en', resources.en.web as unknown as Dictionary);

describe('server address', () => {
  it('normalizes what people type to an origin', () => {
    expect(normalizeServerUrl(' calisma.kurum.com ')).toBe('https://calisma.kurum.com');
    expect(normalizeServerUrl('https://calisma.kurum.com/drive?x=1')).toBe(
      'https://calisma.kurum.com',
    );
    expect(normalizeServerUrl('http://localhost:4110')).toBe('http://localhost:4110');
    expect(normalizeServerUrl('ftp://x.com')).toBeNull();
    expect(normalizeServerUrl('https://user:pw@x.com')).toBeNull();
    expect(normalizeServerUrl('')).toBeNull();
  });

  const bootstrap = {
    branding: {
      orgName: 'Örnek Kurum',
      appName: 'Crewhall',
      logoLightUrl: null,
      logoDarkUrl: null,
      markUrl: null,
      faviconUrl: null,
      showPoweredBy: true,
      defaultLocale: 'tr',
    },
    theme: DEFAULT_THEME,
    needsSetup: false,
    auth: { passkey: true, signupOpen: false },
  };
  const respond = (body: unknown, status = 200) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status }));

  it('accepts a Crewhall server and returns its branding', async () => {
    const fetchFn = respond(bootstrap);
    const result = await checkServer('calisma.kurum.com', fetchFn);
    expect(fetchFn).toHaveBeenCalledWith(
      'https://calisma.kurum.com/api/v1/bootstrap',
      expect.anything(),
    );
    expect(result).toMatchObject({ ok: true, bootstrap: { branding: { orgName: 'Örnek Kurum' } } });
  });

  it('tells apart unreachable, foreign and not yet set up servers', async () => {
    expect(await checkServer('::', respond(bootstrap))).toEqual({ ok: false, error: 'invalid' });
    const down = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    expect(await checkServer('x.com', down)).toEqual({ ok: false, error: 'unreachable' });
    expect(await checkServer('x.com', respond({ hello: 1 }))).toEqual({
      ok: false,
      error: 'notCrewhall',
    });
    expect(await checkServer('x.com', respond({}, 404))).toEqual({
      ok: false,
      error: 'notCrewhall',
    });
    expect(await checkServer('x.com', respond({ ...bootstrap, needsSetup: true }))).toEqual({
      ok: false,
      error: 'needsSetup',
    });
  });

  it('knows which pages belong to the server', () => {
    expect(isServerUrl('https://a.com/chat', 'https://a.com')).toBe(true);
    expect(isServerUrl('https://a.com.evil.io/', 'https://a.com')).toBe(false);
  });
});

describe('deep links', () => {
  it('maps crewhall:// links to server paths', () => {
    expect(parseDeepLink('crewhall://chat/c1?m=5#x')).toEqual({
      kind: 'open',
      path: '/chat/c1?m=5#x',
    });
    expect(parseDeepLink('crewhall://open/drive/n1')).toEqual({ kind: 'open', path: '/drive/n1' });
    expect(parseDeepLink('crewhall:///toplantilar/oda/abc')).toEqual({
      kind: 'open',
      path: '/toplantilar/oda/abc',
    });
    expect(parseDeepLink('crewhall://connect?server=calisma.kurum.com')).toEqual({
      kind: 'connect',
      server: 'calisma.kurum.com',
    });
    expect(parseDeepLink('https://chat/x')).toBeNull();
    expect(parseDeepLink('not a url')).toBeNull();
  });

  it('never leaves the configured server', () => {
    const link = parseDeepLink('crewhall://open//evil.example/x');
    expect(link).toEqual({ kind: 'open', path: '/evil.example/x' });
    expect(deepLinkTarget('/evil.example/x', 'https://a.com')).toBe('https://a.com/evil.example/x');
    expect(deepLinkTarget('//evil.example/x', 'https://a.com')).toBeNull();
  });

  it('finds the link among command line arguments', () => {
    expect(findDeepLinkArg(['app.exe', '--hidden', 'crewhall://chat/1'])).toBe('crewhall://chat/1');
    expect(findDeepLinkArg(['app.exe'])).toBeUndefined();
  });
});

describe('badge', () => {
  it('counts unread conversations and non-chat notifications once', () => {
    expect(badgeCount(3, { chat: 5, drive: 1, boards: 2 })).toBe(6);
    expect(badgeLabel(0)).toBe('');
    expect(badgeLabel(7)).toBe('7');
    expect(badgeLabel(120)).toBe('99+');
  });

  it('draws a red disc with white digits', () => {
    const bmp = badgeBitmap('7', 32);
    expect(bmp.length).toBe(32 * 32 * 4);
    const px = (x: number, y: number) => [...bmp.subarray((y * 32 + x) * 4, (y * 32 + x) * 4 + 4)];
    expect(px(0, 0)[3]).toBe(0); // corner stays transparent
    expect(px(16, 26)).toEqual([0x4d, 0x48, 0xe5, 255]); // red below the digit
    expect(px(15, 9)).toEqual([255, 255, 255, 255]); // top bar of the 7
  });

  it('adds a dot to the tray icon without touching the original', () => {
    const icon = Buffer.alloc(16 * 16 * 4);
    const dotted = withDot(icon, 16);
    expect(icon.every((b) => b === 0)).toBe(true);
    expect(dotted[(3 * 16 + 12) * 4 + 3]).toBe(255);
  });
});

describe('i18n', () => {
  it('picks the OS language when supported, else the org default', () => {
    expect(pickLocale(['en-US', 'tr'])).toBe('en');
    expect(pickLocale(['de-DE'], 'en')).toBe('en');
    expect(pickLocale(['de-DE'])).toBe('tr');
    expect(pickLocale(['en-US'], 'en', 'tr')).toBe('tr');
  });

  it('formats desktop texts in both languages', () => {
    expect(t('desktop.tray.unread', { count: 3 })).toBe('3 okunmamış');
    expect(tEn('desktop.tray.unread', { count: 0 })).toBe('Nothing unread');
    expect(t('desktop.no.such.key')).toBe('desktop.no.such.key');
  });

  it('names conflict copies with the translated label', () => {
    const at = new Date(2026, 9, 22, 9, 3);
    expect(conflictName('Rapor.pdf', t('desktop.sync.conflictLabel'), 'PC', at, () => false)).toBe(
      'Rapor (çakışan kopya PC 2026-10-22 0903).pdf',
    );
    const taken = new Set(['Rapor (conflicted copy PC 2026-10-22 0903).pdf']);
    expect(
      conflictName('Rapor.pdf', tEn('desktop.sync.conflictLabel'), 'PC', at, (n) => taken.has(n)),
    ).toBe('Rapor (conflicted copy PC 2026-10-22 0903 2).pdf');
    expect(localNameProblem('ok name.txt', 'win32')).toBeNull();
    expect(localNameProblem('trailing.', 'win32')).toBe('invalid_name');
    expect(localNameProblem('a:b', 'darwin')).toBeNull();
  });
});

describe('native notification texts', () => {
  const user = { id: 'u1', name: 'Ayşe Demir', email: 'ayse@example.com', imageUrl: null };
  const notification = (patch: Partial<Notification>): Notification => ({
    id: 'n1',
    type: 'chat.mention',
    category: 'mention',
    source: 'chat',
    actor: user,
    target: { type: 'message', id: 'm1', conversationId: 'c1', seq: 4, spaceId: null },
    data: { conversationTitle: 'Pazarlama', excerpt: '@sen bakar mısın?' },
    count: 1,
    url: '/chat/c1?m=4',
    readAt: null,
    snoozedUntil: null,
    dismissedAt: null,
    createdAt: '2026-10-22T10:00:00.000Z',
    updatedAt: '2026-10-22T10:00:00.000Z',
    ...patch,
  });

  it('uses the bell texts and the message excerpt', () => {
    expect(notificationContent(notification({}), t, 'https://a.com')).toEqual({
      title: 'Ayşe Demir senden bahsetti · Pazarlama',
      body: '@sen bakar mısın?',
      path: '/chat/c1?m=4',
    });
    const unknown = notificationContent(
      notification({ type: 'future.thing', url: 'https://a.com/x', data: {} }),
      t,
      'https://a.com',
    );
    expect(unknown).toEqual({ title: 'Yeni bildirim', body: '', path: '/x' });
  });

  it('shows a popup only when the server wants one on the desktop', () => {
    expect(wantsNativeNotification(notification({}))).toBe(true);
    expect(wantsNativeNotification({ ...notification({}), desktop: true })).toBe(true);
    // Desktop channel off, quiet hours or do not disturb: the bell still counts it.
    expect(wantsNativeNotification({ ...notification({}), desktop: false })).toBe(false);
    expect(wantsNativeNotification(notification({ readAt: '2026-10-22T10:01:00.000Z' }))).toBe(
      false,
    );
  });

  it('picks the chime: the bright one for mentions, replies and direct messages', () => {
    expect(notificationTone(notification({}))).toEqual({ tone: 'mention', conversationId: 'c1' });
    expect(notificationTone(notification({ type: 'chat.direct' })).tone).toBe('mention');
    expect(notificationTone(notification({ type: 'chat.reply' })).tone).toBe('mention');
    expect(notificationTone(notification({ type: 'chat.message' })).tone).toBe('message');
    expect(notificationTone(notification({ type: 'chat.alert' })).tone).toBe('message');
    expect(
      notificationTone(
        notification({
          type: 'boards.assigned',
          target: { type: 'card', id: 'k1', conversationId: null, seq: null, spaceId: null },
        }),
      ),
    ).toEqual({ tone: 'message', conversationId: null });
  });

  it('announces calls', () => {
    const call = {
      caller: user,
      video: true,
      conversationTitle: null,
      slug: 'abc',
    } as unknown as Call;
    expect(callContent(call, t)).toEqual({
      title: 'Ayşe Demir sizi görüntülü arıyor',
      body: 'Yanıtlamak için tıklayın',
      path: '',
    });
  });
});

describe('RealtimeClient', () => {
  class FakeSocket implements SocketLike {
    readyState = 0;
    sent: string[] = [];
    onopen: SocketLike['onopen'] = null;
    onmessage: SocketLike['onmessage'] = null;
    onclose: SocketLike['onclose'] = null;
    onerror: SocketLike['onerror'] = null;
    constructor(readonly url: string) {}
    send(data: string) {
      this.sent.push(data);
    }
    close() {
      this.readyState = 3;
    }
    serverSends(event: unknown) {
      this.readyState = 1;
      this.onmessage?.({ data: JSON.stringify(event) });
    }
  }

  it('connects with a ticket, beats without claiming focus and reconnects', async () => {
    const sockets: FakeSocket[] = [];
    const events: string[] = [];
    let tickets = 0;
    const client = new RealtimeClient({
      getTicket: async () => ({ ticket: `t${++tickets}`, path: '/ws' }),
      origin: () => 'https://a.com',
      openSocket: (url) => {
        const s = new FakeSocket(url);
        sockets.push(s);
        return s;
      },
      onEvent: (e) => events.push(e.type),
      backoff: [1],
    });
    client.start();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    expect(sockets[0]!.url).toBe('wss://a.com/ws?ticket=t1');

    sockets[0]!.serverSends({
      type: 'ready',
      userId: '0b6c3f4e-8d1a-4f7e-9c2b-1a2b3c4d5e6f',
      orgId: '1c7d4a5f-9e2b-4a8f-8d3c-2b3c4d5e6f70',
      serverTime: '2026-10-22T10:00:00.000Z',
      heartbeatSeconds: 25,
    });
    sockets[0]!.serverSends({ type: 'notifications.changed', unreadCount: 2 });
    sockets[0]!.serverSends({ type: 'something.new' });
    expect(events).toEqual(['ready', 'notifications.changed']);
    expect(JSON.parse(sockets[0]!.sent[0]!)).toMatchObject({ type: 'heartbeat', focused: false });

    sockets[0]!.onclose?.({ code: 1006 });
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    expect(sockets[1]!.url).toBe('wss://a.com/ws?ticket=t2');
    client.stop();
  });

  describe('with the page navigating while it connects (1 message, 3 notifications)', () => {
    const NOTE = { type: 'notifications.changed', unreadCount: 1 };
    const setup = () => {
      const sockets: FakeSocket[] = [];
      const events: string[] = [];
      const client = new RealtimeClient({
        getTicket: async () => ({ ticket: 't', path: '/ws' }),
        origin: () => 'https://a.com',
        openSocket: (url) => {
          const s = new FakeSocket(url);
          sockets.push(s);
          return s;
        },
        onEvent: (e) => events.push(e.type),
        backoff: [1],
      });
      return { sockets, events, client };
    };

    it('opens one socket while the ticket is on its way', async () => {
      const { sockets, events, client } = setup();
      client.start();
      // did-navigate and did-navigate-in-page of the first page load.
      client.retryNow();
      client.retryNow();
      await vi.waitFor(() => expect(sockets.length).toBeGreaterThan(0));
      await new Promise((r) => setTimeout(r, 20));
      expect(sockets).toHaveLength(1);
      sockets[0]!.serverSends(NOTE);
      expect(events).toEqual(['notifications.changed']);
      client.stop();
    });

    it('opens no second socket while the first is still connecting', async () => {
      const { sockets, client } = setup();
      client.start();
      await vi.waitFor(() => expect(sockets).toHaveLength(1));
      expect(sockets[0]!.readyState).toBe(0);
      client.retryNow();
      await new Promise((r) => setTimeout(r, 20));
      expect(sockets).toHaveLength(1);
      client.stop();
    });

    it('still reconnects at once when nothing is connected', async () => {
      const { sockets, client } = setup();
      client.start();
      await vi.waitFor(() => expect(sockets).toHaveLength(1));
      sockets[0]!.readyState = 3;
      client.retryNow();
      await vi.waitFor(() => expect(sockets).toHaveLength(2));
      client.stop();
    });

    it('a replaced socket is closed and says nothing more', async () => {
      const { sockets, events, client } = setup();
      client.start();
      await vi.waitFor(() => expect(sockets).toHaveLength(1));
      sockets[0]!.readyState = 2;
      client.retryNow();
      await vi.waitFor(() => expect(sockets).toHaveLength(2));
      sockets[0]!.onmessage?.({ data: JSON.stringify(NOTE) });
      expect(events).toEqual([]);
      client.stop();
    });
  });
});

describe('NoteGuard', () => {
  const note = (id: string, count = 1) => ({ id, count });
  const content = { title: 'Sena', body: 'selam', path: '/chat' };

  it('shows one notification once, however many times it arrives', () => {
    const guard = new NoteGuard();
    expect(guard.first(note('a'), content)).toBe(true);
    expect(guard.first(note('a'), content)).toBe(false);
    expect(guard.first(note('a'), content)).toBe(false);
    expect(guard.first(note('b'), content)).toBe(true);
  });

  it('shows it again when the row has news, even with the same words', () => {
    const guard = new NoteGuard();
    expect(guard.first(note('a'), content)).toBe(true);
    expect(guard.first(note('a', 2), content)).toBe(true);
    expect(guard.first(note('a', 2), { ...content, body: 'yeni' })).toBe(true);
  });

  it('keeps a bounded memory', () => {
    const guard = new NoteGuard(2);
    guard.first(note('a'), content);
    guard.first(note('b'), content);
    guard.first(note('c'), content);
    expect(guard.first(note('c'), content)).toBe(false);
    expect(guard.first(note('a'), content)).toBe(true);
  });
});

describe('update feed', () => {
  it("comes from the organization's own server", () => {
    expect(feedUrlFor('https://calisma.kurum.com', 'win32')).toBe(
      'https://calisma.kurum.com/api/v1/desktop/updates/win/',
    );
    expect(feedUrlFor('https://calisma.kurum.com', 'darwin')).toBe(
      'https://calisma.kurum.com/api/v1/desktop/updates/mac/',
    );
  });

  it('follows a server change and is off without a server or a build', () => {
    expect(feedUrlFor('https://yeni.kurum.com', 'win32')).toBe(
      'https://yeni.kurum.com/api/v1/desktop/updates/win/',
    );
    expect(feedUrlFor(null, 'win32')).toBeNull();
    expect(feedUrlFor('https://a.com', 'linux')).toBeNull();
    expect(updatePlatform('darwin')).toBe('mac');
  });

  it('lets a developer override the feed', () => {
    expect(feedUrlFor('https://a.com', 'win32', 'http://localhost:9000/feed/')).toBe(
      'http://localhost:9000/feed/',
    );
  });

  it('treats a 404 from the server as "no release"', () => {
    expect(isNoRelease(Object.assign(new Error('HttpError: 404'), { statusCode: 404 }))).toBe(true);
    expect(isNoRelease(new Error('Cannot find latest.yml: HttpError: 404 Not Found'))).toBe(true);
    expect(isNoRelease(new Error('net::ERR_CONNECTION_REFUSED'))).toBe(false);
  });
});
