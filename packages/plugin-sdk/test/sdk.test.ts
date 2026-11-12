import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  apiLevelSupported,
  canonicalJson,
  compareVersions,
  generateSigningKey,
  manifestDigest,
  PackageError,
  PluginManifest,
  pluginUrl,
  publicKeyOf,
  signPackage,
  selfHostedMismatch,
  verifyPackage,
  type PluginManifestInput,
} from '../src/index';
import {
  attachHost,
  BridgeContext,
  connect,
  createNativeHost,
  injectScript,
  type BridgeContextInput,
} from '../src/bridge';
import {
  pluginTabUrl,
  SESSION_TOKEN_TYPE,
  signApiRequest,
  signRequest,
  verifyApiRequest,
  verifyRequest,
  verifySessionToken,
} from '../src/server';
import { runCli } from '../src/cli';

const base: PluginManifestInput = {
  manifestVersion: 1,
  id: 'com.example.hello',
  version: '1.0.0',
  name: { tr: 'Merhaba', en: 'Hello' },
  description: 'Örnek eklenti',
  publisher: { name: 'Example' },
  apiLevel: { min: 1 },
  origin: 'https://hello.example.com',
  permissions: ['hub:read', 'chat:send'],
  entryPoints: {
    tabs: [{ id: 'main', title: 'Merhaba', url: '/tab', placement: 'rail' }],
    commands: [{ name: 'hello', description: 'Selam ver', url: '/commands/hello' }],
    events: [{ type: 'message.created', url: '/events' }],
  },
};

const review = {
  risk: 'verified' as const,
  riskNote: null,
  reviewedAt: '2026-10-29T00:00:00Z',
  audience: null,
};

describe('manifest', () => {
  it('accepts a valid manifest and fills defaults', () => {
    const m = PluginManifest.parse(base);
    expect(m.entryPoints.cards).toEqual([]);
    expect(m.lifecycle.url).toBe('/crewhall/lifecycle');
    expect(apiLevelSupported(m)).toBe(true);
    expect(pluginUrl(m, '/tab?x=1')).toBe('https://hello.example.com/tab?x=1');
  });

  it('refuses plain http off localhost, foreign paths and duplicate entries', () => {
    const bad = (patch: Partial<PluginManifestInput>) =>
      PluginManifest.safeParse({ ...base, ...patch }).success;
    expect(bad({ origin: 'http://hello.example.com' })).toBe(false);
    expect(bad({ origin: 'http://localhost:4400' })).toBe(true);
    expect(bad({ origin: 'https://hello.example.com/path' })).toBe(false);
    expect(
      bad({
        entryPoints: { tabs: [{ id: 'x', title: 'X', url: '//evil.com/x', placement: 'rail' }] },
      }),
    ).toBe(false);
    expect(
      bad({
        entryPoints: {
          tabs: [
            { id: 'x', title: 'X', url: '/a', placement: 'rail' },
            { id: 'x', title: 'Y', url: '/b', placement: 'chat' },
          ],
        },
      }),
    ).toBe(false);
    expect(
      bad({ permissions: [], entryPoints: { events: [{ type: 'node.created', url: '/e' }] } }),
    ).toBe(false);
    expect(bad({ id: 'hello' })).toBe(false);
    expect(bad({ version: '1.0' })).toBe(false);
  });

  it('orders versions like semver', () => {
    expect(compareVersions('1.2.0', '1.10.0')).toBe(-1);
    expect(compareVersions('2.0.0', '2.0.0-beta.1')).toBe(1);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
  });
});

describe('signed packages', () => {
  it('verifies a package signed by a trusted key and nothing else', async () => {
    const key = await generateSigningKey();
    expect(await publicKeyOf(key.privateKey)).toBe(key.publicKey);
    const manifest = PluginManifest.parse(base);
    const pkg = await signPackage(manifest, review, { keyId: 'k1', privateKey: key.privateKey });
    const json = JSON.parse(JSON.stringify(pkg)) as typeof pkg;
    const ok = await verifyPackage(json, [{ keyId: 'k1', publicKey: key.publicKey }]);
    expect(ok.manifest.id).toBe('com.example.hello');

    const tampered = structuredClone(json);
    tampered.manifest.permissions.push('drive:write');
    await expect(
      verifyPackage(tampered, [{ keyId: 'k1', publicKey: key.publicKey }]),
    ).rejects.toMatchObject({
      reason: 'signature',
    });
    const riskless = structuredClone(json);
    riskless.review.risk = 'official';
    await expect(
      verifyPackage(riskless, [{ keyId: 'k1', publicKey: key.publicKey }]),
    ).rejects.toBeInstanceOf(PackageError);
    const other = await generateSigningKey();
    await expect(
      verifyPackage(json, [{ keyId: 'k1', publicKey: other.publicKey }]),
    ).rejects.toMatchObject({
      reason: 'signature',
    });
    await expect(
      verifyPackage(json, [{ keyId: 'k2', publicKey: key.publicKey }]),
    ).rejects.toMatchObject({
      reason: 'unknown_key',
    });
  });

  it('signs canonical JSON: key order does not matter', async () => {
    expect(canonicalJson({ b: 1, a: [2, { d: null, c: 'x' }] })).toBe(
      '{"a":[2,{"c":"x","d":null}],"b":1}',
    );
    const m = PluginManifest.parse(base);
    const reordered = Object.fromEntries(Object.entries(m).reverse());
    expect(await manifestDigest(reordered)).toBe(await manifestDigest(m));
  });
});

describe('signed requests', () => {
  it('accepts the right secret within the time window only', async () => {
    const body = JSON.stringify({ hello: 'world' });
    const now = Date.now();
    const headers = await signRequest('s'.repeat(40), 'inst-1', body, now);
    const signature = headers['crewhall-signature'];
    expect(await verifyRequest({ secret: 's'.repeat(40), body, signature, now })).toBe(true);
    expect(await verifyRequest({ secret: 'x'.repeat(40), body, signature, now })).toBe(false);
    expect(await verifyRequest({ secret: 's'.repeat(40), body: '{}', signature, now })).toBe(false);
    expect(
      await verifyRequest({ secret: 's'.repeat(40), body, signature, now: now + 600_000 }),
    ).toBe(false);
    expect(await verifyRequest({ secret: 's'.repeat(40), body, signature: null })).toBe(false);
  });

  it('verifies a session token for this plugin and installation', async () => {
    const { publicKey, privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
    const jwks = createLocalJWKSet({
      keys: [{ ...(await exportJWK(publicKey)), kid: 'a', alg: 'EdDSA' }],
    });
    const issue = (aud: string, iss = 'https://hub.acme.com') =>
      new SignJWT({
        org: 'o1',
        inst: 'i1',
        name: 'Elif',
        email: 'elif@acme.com',
        scope: 'hub:read chat:send bogus',
      })
        .setProtectedHeader({ alg: 'EdDSA', kid: 'a', typ: SESSION_TOKEN_TYPE })
        .setIssuer(iss)
        .setAudience(aud)
        .setSubject('u1')
        .setExpirationTime('5m')
        .sign(privateKey);
    const claims = await verifySessionToken(await issue('com.example.hello'), {
      issuer: 'https://hub.acme.com',
      audience: 'com.example.hello',
      jwks,
    });
    expect(claims).toMatchObject({ sub: 'u1', inst: 'i1', scopes: ['hub:read', 'chat:send'] });
    await expect(
      verifySessionToken(await issue('com.other.plugin'), {
        issuer: 'https://hub.acme.com',
        audience: 'com.example.hello',
        jwks,
      }),
    ).rejects.toThrow();
    await expect(
      verifySessionToken(await issue('com.example.hello', 'https://evil.example'), {
        issuer: 'https://hub.acme.com',
        audience: 'com.example.hello',
        jwks,
      }),
    ).rejects.toThrow();
  });
});

/** Two windows joined by postMessage, enough for the bridge's origin and source checks. */
function fakeWindows(hostOrigin: string, pluginOrigin: string) {
  type L = (e: MessageEvent) => void;
  const make = () => {
    const listeners = new Set<L>();
    return {
      listeners,
      addEventListener: (_: 'message', l: L) => listeners.add(l),
      removeEventListener: (_: 'message', l: L) => listeners.delete(l),
    };
  };
  const host = make();
  const plugin = make();
  const deliver = (to: typeof host, data: unknown, origin: string, source: unknown) =>
    queueMicrotask(() => {
      for (const l of to.listeners) l({ data, origin, source } as MessageEvent);
    });
  const frameWindow = {
    postMessage: (data: unknown, target: string) => {
      if (target === pluginOrigin) deliver(plugin, data, hostOrigin, hostWindow);
    },
  };
  const hostWindow = {
    ...host,
    postMessage: () => undefined,
  };
  const pluginWindow = {
    ...plugin,
    parent: {
      postMessage: (data: unknown) => deliver(host, data, pluginOrigin, frameWindow),
    },
  };
  return { hostWindow, pluginWindow, frameWindow };
}

describe('bridge', () => {
  it('drops permissions and browser features this build does not know instead of failing', () => {
    const parsed = BridgeContext.parse({
      pluginId: 'com.example.hello',
      installationId: 'i1',
      placement: 'rail',
      entryId: 'main',
      user: { id: 'u1', name: 'Elif', email: 'elif@acme.com' },
      org: { id: 'o1', name: 'Acme' },
      locale: 'tr',
      theme: { scheme: 'light', accent: '#FBC419' },
      permissions: ['hub:read', 'boards:write', 'future:scope'],
      browser: ['microphone', 'future-feature'],
    });
    expect(parsed.permissions).toEqual(['hub:read', 'boards:write']);
    expect(parsed.browser).toEqual(['microphone']);
    expect(BridgeContext.parse({ ...parsed, permissions: undefined }).permissions).toEqual([]);
  });

  it('hands context and a token to the plugin and refuses other origins', async () => {
    const w = fakeWindows('https://hub.acme.com', 'https://hello.example.com');
    const context: BridgeContextInput = {
      pluginId: 'com.example.hello',
      installationId: 'i1',
      placement: 'rail',
      entryId: 'main',
      user: { id: 'u1', name: 'Elif', email: 'elif@acme.com' },
      org: { id: 'o1', name: 'Acme' },
      locale: 'tr',
      theme: { scheme: 'light', accent: '#FBC419' },
    };
    const toasts: string[] = [];
    const host = attachHost({
      window: w.hostWindow as unknown as Window,
      frame: () => w.frameWindow as unknown as Window,
      origin: 'https://hello.example.com',
      context,
      handlers: {
        token: async () => ({
          token: 'jwt',
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
        }),
        navigate: () => undefined,
        toast: (t) => toasts.push(t),
      },
    });
    const bridge = await connect({ window: w.pluginWindow, timeoutMs: 1000 });
    expect(bridge.context.user.name).toBe('Elif');
    expect(await bridge.getToken()).toBe('jwt');
    await bridge.toast('Kaydedildi');
    expect(toasts).toEqual(['Kaydedildi']);

    // A message from another origin never reaches the host handlers.
    for (const l of w.hostWindow.listeners) {
      l({
        data: {
          crewhall: 1,
          id: 'x',
          type: 'request',
          request: { method: 'toast', text: 'sahte' },
        },
        origin: 'https://evil.example',
        source: w.frameWindow,
      } as MessageEvent);
    }
    await new Promise((r) => setTimeout(r, 10));
    expect(toasts).toEqual(['Kaydedildi']);
    bridge.close();
    host.detach();
  });
});

describe('bridge in the mobile app (WebView)', () => {
  it('talks through the native channel and ignores messages from frames in the page', async () => {
    type L = (e: MessageEvent) => void;
    const listeners = new Set<L>();
    const sent: unknown[] = [];
    const deliver = (data: unknown, source: unknown = null) => {
      for (const l of listeners) l({ data, origin: '', source } as MessageEvent);
    };
    const win = {
      parent: { postMessage: () => undefined },
      addEventListener: (_: 'message', l: L) => listeners.add(l),
      removeEventListener: (_: 'message', l: L) => listeners.delete(l),
    };
    const native = {
      postMessage(message: string) {
        const msg = JSON.parse(message) as {
          type: string;
          id: string;
          request?: { method: string };
        };
        sent.push(msg);
        queueMicrotask(() => {
          if (msg.type === 'ready') {
            // A frame inside the page cannot pose as the app.
            deliver(
              {
                crewhall: 1,
                id: 'f',
                type: 'init',
                context: { ...ctx, user: { ...ctx.user, name: 'Sahte' } },
              },
              {},
            );
            deliver(JSON.stringify({ crewhall: 1, id: 'i', type: 'init', context: ctx }));
          } else if (msg.request?.method === 'token') {
            deliver(
              JSON.stringify({
                crewhall: 1,
                id: 'r',
                type: 'response',
                replyTo: msg.id,
                ok: true,
                result: { token: 'm', expiresAt: new Date(Date.now() + 300_000).toISOString() },
              }),
            );
          }
        });
      },
    };
    const ctx = {
      pluginId: 'com.example.hello',
      installationId: 'i1',
      placement: 'rail',
      entryId: 'main',
      user: { id: 'u1', name: 'Elif', email: 'elif@acme.com' },
      org: { id: 'o1', name: 'Acme' },
      locale: 'tr',
      theme: { scheme: 'dark', accent: '#FBC419' },
      platform: 'mobile',
      permissions: ['hub:read'],
    };
    const bridge = await connect({ window: win, native, timeoutMs: 1000 });
    expect(bridge.context).toMatchObject({
      platform: 'mobile',
      permissions: ['hub:read'],
      user: { name: 'Elif' },
    });
    expect(await bridge.getToken()).toBe('m');
    expect((sent[0] as { type: string }).type).toBe('ready');
    bridge.close();
  });

  it('pairs with the app-side native host through injected scripts', async () => {
    type L = (e: MessageEvent) => void;
    const listeners = new Set<L>();
    const page = {
      parent: { postMessage: () => undefined },
      addEventListener: (_: 'message', l: L) => listeners.add(l),
      removeEventListener: (_: 'message', l: L) => listeners.delete(l),
      dispatchEvent: (e: { data: unknown }) => {
        for (const l of listeners) l({ data: e.data, origin: '', source: null } as MessageEvent);
        return true;
      },
    };
    class FakeMessageEvent {
      data: unknown;
      constructor(_type: string, init: { data: unknown }) {
        this.data = init.data;
      }
    }
    const navigated: string[] = [];
    // What the app does with `injectJavaScript`: run the script in the page.
    const run = (script: string) =>
      new Function('window', 'MessageEvent', script)(page, FakeMessageEvent);
    const host = createNativeHost({
      context: {
        pluginId: 'com.example.hello',
        installationId: 'i1',
        placement: 'card',
        entryId: 'today',
        user: { id: 'u1', name: 'Elif', email: 'elif@acme.com' },
        org: { id: 'o1', name: 'Acme' },
        locale: 'tr',
        theme: { scheme: 'light', accent: '#FBC419' },
        permissions: ['hub:read', 'chat:send'],
      },
      handlers: {
        token: async () => ({
          token: 'n',
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
        }),
        navigate: (to) => navigated.push(to),
        toast: () => undefined,
      },
      send: (script) => queueMicrotask(() => run(script)),
    });
    // What the app does in `onMessage`: hand the string to the host.
    const native = { postMessage: (message: string) => host.receive(message) };

    const bridge = await connect({ window: page, native, timeoutMs: 1000 });
    expect(bridge.context).toMatchObject({
      platform: 'mobile',
      placement: 'card',
      permissions: ['hub:read', 'chat:send'],
    });
    expect(await bridge.getToken()).toBe('n');
    await bridge.navigate('/chat');
    expect(navigated).toEqual(['/chat']);
    // Garbage from the page never reaches the handlers.
    host.receive('{ not json');
    host.receive(
      JSON.stringify({ crewhall: 1, id: 'x', type: 'request', request: { method: 'nope' } }),
    );
    // Quotes in the message cannot break out of the injected string literal.
    const themes: unknown[] = [];
    bridge.onTheme((t) => themes.push(t));
    run(
      injectScript({
        crewhall: 1,
        id: 'a',
        type: 'theme',
        theme: { scheme: 'dark', accent: `"');x('` },
      }),
    );
    expect(themes).toEqual([{ scheme: 'dark', accent: `"');x('` }]);
    bridge.close();
  });
});

describe('self-hosted copies', () => {
  const signed = PluginManifest.parse({ ...base, hosting: 'self' });
  const own = 'https://wa.acme.com';
  const copy = (patch: Partial<PluginManifestInput> = {}) => ({
    ...base,
    hosting: 'self',
    origin: own,
    ...patch,
  });

  it('accepts the signed manifest on another origin, and nothing else', () => {
    expect(signed.hosting).toBe('self');
    expect(PluginManifest.parse(base).hosting).toBe('hosted');
    expect(selfHostedMismatch(signed, copy(), own)).toBeNull();
    expect(selfHostedMismatch(signed, copy(), 'https://other.acme.com')).toBe('origin');
    expect(selfHostedMismatch(signed, copy({ version: '1.0.1' }), own)).toBe('version');
    expect(selfHostedMismatch(signed, copy({ id: 'com.evil.hello' }), own)).toBe('id');
    expect(
      selfHostedMismatch(signed, copy({ permissions: ['hub:read', 'drive:write'] }), own),
    ).toBe('permissions');
    expect(selfHostedMismatch(signed, copy({ name: 'Başka' }), own)).toBe('manifest');
    expect(selfHostedMismatch(signed, { nope: true }, own)).toBe('shape');
  });
});

describe('connect() when the host listens late', () => {
  afterEach(() => vi.useRealTimers());
  const ctx = {
    pluginId: 'com.example.hello',
    installationId: 'i1',
    placement: 'rail' as const,
    entryId: 'main',
    user: { id: 'u1', name: 'Elif', email: 'elif@acme.com' },
    org: { id: 'o1', name: 'Acme' },
    locale: 'tr',
    theme: { scheme: 'light' as const, accent: '#FBC419' },
  };

  /** A page in a WebView: the app's host is attached only when `attach()` is called. */
  function page() {
    type L = (e: MessageEvent) => void;
    const listeners = new Set<L>();
    const readies: number[] = [];
    let host: ReturnType<typeof createNativeHost> | null = null;
    const win = {
      parent: { postMessage: () => undefined },
      addEventListener: (_: 'message', l: L) => listeners.add(l),
      removeEventListener: (_: 'message', l: L) => listeners.delete(l),
      dispatchEvent: (e: { data: unknown }) => {
        for (const l of listeners) l({ data: e.data, origin: '', source: null } as MessageEvent);
        return true;
      },
    };
    class FakeMessageEvent {
      data: unknown;
      constructor(_type: string, init: { data: unknown }) {
        this.data = init.data;
      }
    }
    const native = {
      postMessage(message: string) {
        if ((JSON.parse(message) as { type: string }).type === 'ready') readies.push(Date.now());
        // Before the host exists the message is simply lost.
        host?.receive(message);
      },
    };
    const inits: string[] = [];
    const attach = () => {
      host = createNativeHost({
        context: ctx,
        handlers: {
          token: async () => ({
            token: 't',
            expiresAt: new Date(Date.now() + 300_000).toISOString(),
          }),
          navigate: () => undefined,
          toast: () => undefined,
        },
        send: (script) => {
          inits.push(script);
          new Function('window', 'MessageEvent', script)(win, FakeMessageEvent);
        },
      });
    };
    const got: { context?: unknown }[] = [];
    return { win, native, readies, inits, attach, got };
  }

  it('says ready again until the host answers, then stops', async () => {
    vi.useFakeTimers();
    const p = page();
    const bridge = connect({ window: p.win, native: p.native });
    await vi.advanceTimersByTimeAsync(3_500);
    expect(p.readies).toHaveLength(4);
    p.attach();
    await vi.advanceTimersByTimeAsync(1_000);
    const b = await bridge;
    expect(b.context).toMatchObject({ installationId: 'i1', platform: 'mobile' });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(p.readies).toHaveLength(5);
    b.close();
  });

  it('gives up after 15 tries', async () => {
    vi.useFakeTimers();
    const p = page();
    const bridge = connect({ window: p.win, native: p.native });
    const failed = expect(bridge).rejects.toThrow('no Crewhall host answered');
    await vi.advanceTimersByTimeAsync(30_000);
    await failed;
    expect(p.readies).toHaveLength(15);
  });

  it('gets the same init for every ready, and keeps the first', async () => {
    const p = page();
    p.attach();
    p.win.addEventListener('message', (e) => {
      const m = JSON.parse(String(e.data)) as { type: string; context?: unknown };
      if (m.type === 'init') p.got.push(m);
    });
    const ready = JSON.stringify({ crewhall: 1, id: 'r', type: 'ready' });
    p.native.postMessage(ready);
    p.native.postMessage(ready);
    expect(p.inits).toHaveLength(2);
    const contexts = p.got.map((m) => JSON.stringify(m.context));
    expect(contexts).toHaveLength(2);
    expect(contexts[0]).toBe(contexts[1]);
    const b = await connect({ window: p.win, native: p.native, timeoutMs: 1_000 });
    expect(b.context.installationId).toBe('i1');
    b.close();
  });
});

describe('requests to Crewhall', () => {
  it('are signed for their own direction only', async () => {
    const secret = 's'.repeat(48);
    const body = '{"userId":"u"}';
    const up = (await signApiRequest(secret, 'i1', body))['crewhall-signature'];
    const down = (await signRequest(secret, 'i1', body))['crewhall-signature'];
    expect(await verifyApiRequest({ secret, body, signature: up })).toBe(true);
    expect(await verifyApiRequest({ secret, body, signature: down })).toBe(false);
    expect(await verifyRequest({ secret, body, signature: up })).toBe(false);
    expect(await verifyApiRequest({ secret, body: `${body} `, signature: up })).toBe(false);
  });

  it('build deep links into a plugin tab', () => {
    expect(
      pluginTabUrl({
        installationId: 'i1',
        tab: 'inbox',
        placement: 'chat',
        search: { chat: '42' },
      }),
    ).toBe('/chat/plugins/i1/inbox?chat=42');
    expect(
      pluginTabUrl({ installationId: 'i1', tab: 'main', placement: 'rail', hash: '#top' }),
    ).toBe('/plugins/i1/main#top');
  });
});

describe('CLI', () => {
  it('validates a manifest file and reports problems with their path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'plugin-'));
    const good = join(dir, 'good.json');
    const bad = join(dir, 'bad.json');
    await writeFile(good, JSON.stringify(base));
    await writeFile(bad, JSON.stringify({ ...base, origin: 'ftp://x' }));
    const out: string[] = [];
    const err: string[] = [];
    const io = { out: (l: string) => out.push(l), err: (l: string) => err.push(l), fetch };
    expect(await runCli(['validate', good], io)).toBe(0);
    expect(out[0]).toMatch(/^com\.example\.hello@1\.0\.0 ok/);
    expect(await runCli(['validate', bad], io)).toBe(1);
    expect(err.join('\n')).toContain('origin');
  });
});
