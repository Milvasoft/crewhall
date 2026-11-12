import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { auditLogs, messages, organizations, pluginInstallations } from '@crewhall/db';
import { ApiError, createApiClient } from '@crewhall/api-client';
import {
  generateSigningKey,
  PluginManifest,
  signPackage,
  type PluginManifestInput,
  type PluginPackage,
} from '@crewhall/plugin-sdk';
import {
  CommandRequest,
  LifecycleRequest,
  verifyRequest,
  verifySessionToken,
} from '@crewhall/plugin-sdk/server';
import { configureOutbound, outboundPolicy } from '../src/net/outbound';
import { applyPluginTool, pluginTools } from '../src/services/plugins/tools';
import { uuid } from './chat-helpers';
import { Client, createTestApp, join, setupWithOwner, type TestApp } from './helpers';

/**
 * Plugins end to end: a fake marketplace signs packages, a fake plugin server answers lifecycle,
 * command, event and tool requests over real sockets and calls the REST API back with the
 * person's session token.
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
let crewhall: Server;
let market: Server;
let plugin: Server;
let selfServer: Server;
let selfOrigin: string;
let marketUrl: string;
/** What the org's own copy of the self-hosted plugin serves at /.well-known. */
let served: Record<string, unknown> = {};
const selfLifecycle: LifecycleRequest[] = [];
let apiUrl: string;
let pluginOrigin: string;
let owner: Client;
let elif: Client;
let elifId: string;
let canId: string;

/** What the fake plugin server saw. */
const seen = {
  secret: '' as string,
  lifecycle: [] as LifecycleRequest[],
  events: [] as { type: string; data: Record<string, unknown> }[],
  commands: [] as { user: string; spaces: number; scopes: string[] }[],
};

const manifest = (
  version: string,
  extra: Partial<PluginManifestInput> = {},
): PluginManifestInput => ({
  manifestVersion: 1,
  id: 'com.example.hello',
  version,
  name: { tr: 'Merhaba', en: 'Hello' },
  description: 'Örnek eklenti',
  publisher: { name: 'Example' },
  apiLevel: { min: 1 },
  origin: pluginOrigin,
  icon: '/icon.png',
  permissions: ['hub:read', 'chat:send'],
  entryPoints: {
    tabs: [{ id: 'main', title: 'Merhaba', url: '/tab', placement: 'rail' }],
    cards: [{ id: 'today', title: 'Bugün', url: '/card' }],
    commands: [{ name: 'hello', description: 'Selam ver', url: '/commands/hello' }],
    tools: [
      { name: 'echo', description: 'Girdiyi geri verir', url: '/tools/echo' },
      { name: 'post', description: 'Bir şey yazar', url: '/tools/echo', write: true },
    ],
    events: [
      { type: 'message.created', url: '/events' },
      { type: 'node.created', url: '/events' },
    ],
  },
  ...extra,
});

const packages = new Map<string, unknown>();

const SELF_REFERENCE = 'https://wa.reference.example';
const selfManifest = (
  version: string,
  extra: Partial<PluginManifestInput> = {},
): PluginManifestInput => ({
  manifestVersion: 1,
  id: 'com.acme.wa',
  version,
  name: 'WhatsApp',
  description: 'Kendi sunucunda WhatsApp köprüsü',
  publisher: { name: 'Acme' },
  apiLevel: { min: 1 },
  origin: SELF_REFERENCE,
  hosting: 'self',
  permissions: ['hub:read', 'chat:send'],
  entryPoints: { tabs: [{ id: 'chats', title: 'WhatsApp', url: '/', placement: 'chat' }] },
  ...extra,
});

beforeAll(async () => {
  const key = await generateSigningKey();
  const other = await generateSigningKey();
  const [cPort, mPort, pPort, sPort] = [
    await freePort(),
    await freePort(),
    await freePort(),
    await freePort(),
  ];
  apiUrl = `http://127.0.0.1:${cPort}`;
  pluginOrigin = `http://127.0.0.1:${pPort}`;
  selfOrigin = `http://127.0.0.1:${sPort}`;
  marketUrl = `http://127.0.0.1:${mPort}`;
  const review = {
    risk: 'verified' as const,
    riskNote: null,
    reviewedAt: new Date().toISOString(),
    audience: null,
  };
  const sign = (m: PluginManifestInput, k = key) =>
    signPackage(PluginManifest.parse(m), review, { keyId: 'test-1', privateKey: k.privateKey });
  packages.set('com.example.hello@1.0.0', await sign(manifest('1.0.0')));
  packages.set(
    'com.example.hello@1.1.0',
    await sign(manifest('1.1.0', { permissions: ['hub:read', 'chat:send', 'drive:write'] })),
  );
  const tampered = structuredClone(
    await sign(manifest('1.0.0', { id: 'com.evil.tamper' })),
  ) as PluginPackage;
  tampered.manifest.permissions.push('drive:write');
  packages.set('com.evil.tamper@1.0.0', tampered);
  packages.set(
    'com.evil.forged@1.0.0',
    await sign(manifest('1.0.0', { id: 'com.evil.forged' }), other),
  );
  // Self-hosted and unlisted: every org runs its own copy; the reviewed one is elsewhere.
  const selfVersions: [string, Partial<PluginManifestInput>][] = [
    ['1.0.0', {}],
    ['1.1.0', { permissions: ['hub:read', 'chat:send', 'drive:write'] }],
    ['1.2.0', { hosting: 'hosted' }],
  ];
  // Browser features (API 32): a tab that records voice notes and shares the location.
  packages.set(
    'com.example.media@1.0.0',
    await sign(
      manifest('1.0.0', { id: 'com.example.media', browser: ['microphone', 'geolocation'] }),
    ),
  );
  packages.set(
    'com.example.media@1.1.0',
    await sign(
      manifest('1.1.0', {
        id: 'com.example.media',
        browser: ['microphone', 'geolocation', 'camera'],
      }),
    ),
  );
  for (const [version, extra] of selfVersions) {
    packages.set(`com.acme.wa@${version}`, await sign(selfManifest(version, extra)));
  }

  // ---- fake marketplace ----
  const m = new Hono();
  const entry = (pkg: PluginPackage) => ({
    id: pkg.manifest.id,
    version: pkg.manifest.version,
    name: pkg.manifest.name,
    description: pkg.manifest.description,
    publisher: { name: pkg.manifest.publisher.name },
    homepage: null,
    icon: `${pluginOrigin}/icon.png`,
    origin: pkg.manifest.origin,
    risk: pkg.review.risk,
    riskNote: pkg.review.riskNote,
    permissions: pkg.manifest.permissions,
    entryPoints: { tabs: 1, cards: 1, commands: 1, tools: 2, events: 2 },
    restricted: false,
    updatedAt: pkg.review.reviewedAt,
  });
  m.get('/v1/catalog', (c) =>
    c.json({ items: [entry(packages.get('com.example.hello@1.1.0') as PluginPackage)] }),
  );
  m.get('/v1/plugins/:id', (c) => {
    const id = c.req.param('id');
    const versions = [...packages.keys()]
      .filter((k) => k.startsWith(`${id}@`) && !k.endsWith('@1.2.0'))
      .map((k) => packages.get(k) as PluginPackage);
    const newest = versions.at(-1);
    if (!newest) return c.json({ code: 'not_found' }, 404);
    return c.json({
      ...entry(newest),
      hosting: newest.manifest.hosting,
      visibility: id === 'com.acme.wa' ? 'unlisted' : 'public',
      versions: versions.map((v) => ({
        version: v.manifest.version,
        reviewedAt: v.review.reviewedAt,
        digest: 'x',
      })),
    });
  });
  m.get('/v1/plugins/:id/versions/:version/package', (c) => {
    const pkg = packages.get(`${c.req.param('id')}@${c.req.param('version')}`);
    return pkg ? c.json(pkg) : c.json({ code: 'not_found' }, 404);
  });
  market = await listen(m, mPort);

  // ---- fake plugin server ----
  const p = new Hono();
  const signed = async (c: {
    req: { text(): Promise<string>; header(n: string): string | undefined };
  }) => {
    const body = await c.req.text();
    const ok = await verifyRequest({
      secret: seen.secret,
      body,
      signature: c.req.header('crewhall-signature'),
    });
    return { ok, body: JSON.parse(body) as Record<string, unknown> };
  };
  p.post('/crewhall/lifecycle', async (c) => {
    const body = await c.req.text();
    const req = LifecycleRequest.parse(JSON.parse(body));
    if (req.type === 'install') seen.secret = req.secret;
    if (
      !(await verifyRequest({
        secret: seen.secret,
        body,
        signature: c.req.header('crewhall-signature'),
      }))
    ) {
      return c.json({}, 401);
    }
    seen.lifecycle.push(req);
    return c.json({ ok: true });
  });
  p.post('/commands/hello', async (c) => {
    const { ok, body } = await signed(c);
    if (!ok) return c.json({}, 401);
    const req = CommandRequest.parse(body);
    const who = await verifySessionToken(req.token, {
      issuer: apiUrl,
      audience: 'com.example.hello',
    });
    // The plugin calls Crewhall back as the person.
    const api = createApiClient({ baseUrl: apiUrl, getToken: () => req.token });
    const spaces = await api.call('listSpaces');
    seen.commands.push({ user: who.sub, spaces: spaces.items.length, scopes: who.scopes });
    return c.json({ reply: `Merhaba ${req.user.name}, ${req.args}`, post: `👋 ${req.args}` });
  });
  p.post('/events', async (c) => {
    const { ok, body } = await signed(c);
    if (!ok) return c.json({}, 401);
    seen.events.push({ type: String(body.type), data: body.data as Record<string, unknown> });
    return c.json({});
  });
  p.post('/tools/echo', async (c) => {
    const { ok, body } = await signed(c);
    if (!ok) return c.json({}, 401);
    return c.json({ content: { echoed: body.input }, summary: 'echo' });
  });
  plugin = await listen(p, pPort);

  // ---- the org's own copy of the self-hosted plugin ----
  const s = new Hono();
  s.get('/.well-known/crewhall-plugin.json', (c) => c.json(served));
  s.post('/crewhall/lifecycle', async (c) => {
    selfLifecycle.push(LifecycleRequest.parse(JSON.parse(await c.req.text())));
    return c.json({ ok: true });
  });
  selfServer = await listen(s, sPort);

  app = await createTestApp({
    API_URL: apiUrl,
    MARKETPLACE_URL: `http://127.0.0.1:${mPort}`,
    MARKETPLACE_PUBLIC_KEYS: `test-1:${key.publicKey}`,
  });
  crewhall = await listen(app.app, cPort);
  ({ owner } = await setupWithOwner(app));
  const spaceId = (await owner.api.call('listSpaces')).items.find(
    (s) => s.name === 'Milvasoft',
  )!.id;
  const e = await join(app, owner, 'elif@milvasoft.com', 'member', [spaceId]);
  elif = e.person;
  elifId = e.me.user.id;
  canId = (await join(app, owner, 'can@milvasoft.com', 'member', [spaceId])).me.user.id;
}, 120_000);

afterAll(async () => {
  await Promise.all([crewhall, market, plugin, selfServer].filter(Boolean).map(closeServer));
  configureOutbound(outboundPolicy({}));
  await app?.close();
});

async function expectCode(p: Promise<unknown>, status: number, code?: string) {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(status);
    if (code) expect((err as ApiError).code).toBe(code);
    return (err as ApiError).details;
  }
  throw new Error(`expected ${status}`);
}

const installation = async () =>
  (await owner.api.call('listPluginInstallations')).items.find(
    (i) => i.pluginId === 'com.example.hello',
  )!;

describe('installing from the marketplace', () => {
  it('shows the catalog to admins only', async () => {
    const catalog = await owner.api.call('listPluginCatalog', { query: {} });
    expect(catalog.items).toMatchObject([
      { id: 'com.example.hello', installedVersion: null, risk: 'verified' },
    ]);
    await expectCode(elif.api.call('listPluginCatalog', { query: {} }), 403, 'forbidden');
  });

  it('refuses tampered and foreign-signed packages and a partial approval', async () => {
    for (const id of ['com.evil.tamper', 'com.evil.forged']) {
      await expectCode(
        owner.api.call('installPlugin', {
          body: { pluginId: id, version: '1.0.0', permissions: ['hub:read', 'chat:send'] },
        }),
        422,
        'plugin_signature_invalid',
      );
    }
    await expectCode(
      owner.api.call('installPlugin', {
        // Only what the manifest asks for can be granted.
        body: {
          pluginId: 'com.example.hello',
          version: '1.0.0',
          permissions: ['hub:read', 'drive:write'],
        },
      }),
      422,
      'plugin_permissions_mismatch',
    );
    expect(seen.lifecycle).toHaveLength(0);
  });

  it('installs with the admin approval and hands the plugin its secret once', async () => {
    const inst = await owner.api.call('installPlugin', {
      body: {
        pluginId: 'com.example.hello',
        version: '1.0.0',
        permissions: ['chat:send', 'hub:read'],
      },
    });
    expect(inst).toMatchObject({
      version: '1.0.0',
      status: 'active',
      permissions: ['hub:read', 'chat:send'],
    });
    expect(seen.lifecycle[0]).toMatchObject({ type: 'install', installationId: inst.id, apiUrl });
    expect(seen.secret).toHaveLength(43);
    const [row] = await app.deps.db
      .select()
      .from(pluginInstallations)
      .where(eq(pluginInstallations.id, inst.id));
    expect(row!.secretEnc).not.toContain(seen.secret);
    const audits = await app.deps.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'plugin.install'), eq(auditLogs.targetId, inst.id)));
    expect(audits).toHaveLength(1);
    // The catalog's newer version shows up as an update asking for one more permission.
    expect((await installation()).update).toEqual({
      version: '1.1.0',
      addedPermissions: ['drive:write'],
    });
    await expectCode(
      owner.api.call('installPlugin', {
        body: {
          pluginId: 'com.example.hello',
          version: '1.0.0',
          permissions: ['hub:read', 'chat:send'],
        },
      }),
      409,
      'plugin_already_installed',
    );
  });

  it('lists tabs, cards and commands for members', async () => {
    const { items } = await elif.api.call('listPluginSurfaces');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      pluginId: 'com.example.hello',
      icon: `${pluginOrigin}/icon.png`,
      tabs: [{ id: 'main', placement: 'rail' }],
      cards: [{ id: 'today' }],
      commands: [{ name: 'hello' }],
    });
  });
});

describe('session tokens', () => {
  it('say who the person is and open the REST API within the approved permissions', async () => {
    const inst = await installation();
    const { token } = await elif.api.call('createPluginSessionToken', {
      params: { installationId: inst.id },
    });
    const claims = await verifySessionToken(token, {
      issuer: apiUrl,
      audience: 'com.example.hello',
    });
    expect(claims).toMatchObject({ sub: elifId, inst: inst.id, scopes: ['hub:read', 'chat:send'] });
    await expect(
      verifySessionToken(token, { issuer: apiUrl, audience: 'com.other.plugin' }),
    ).rejects.toThrow();

    const asPlugin = new Client(app);
    asPlugin.bearer = token;
    expect((await asPlugin.api.call('listSpaces')).items.length).toBeGreaterThan(0);
    const spaceId = (await asPlugin.api.call('listSpaces')).items[0]!.id;
    await expectCode(
      asPlugin.api.call('createFolder', {
        params: { spaceId },
        body: { parentId: null, name: 'x' },
      }),
      403,
      'token_scope',
    );
    // A token never mints another one.
    await expectCode(
      asPlugin.api.call('createPluginSessionToken', { params: { installationId: inst.id } }),
      403,
      'token_scope',
    );
    const dm = await elif.api.call('createConversation', {
      body: { type: 'direct', userId: canId },
    });
    const sent = await asPlugin.api.call('sendMessage', {
      params: { conversationId: dm.id },
      body: { clientMsgId: uuid(), text: 'eklentiden' },
    });
    expect(sent.via).toEqual({ kind: 'plugin', client: 'Merhaba' });
  });
});

describe('commands, events and tools', () => {
  let groupId: string;

  it('runs a /command on the plugin server, which calls back as the person', async () => {
    const group = await elif.api.call('createConversation', {
      body: { type: 'group', userIds: [canId, (await owner.api.call('me')).user.id], name: 'Ekip' },
    });
    groupId = group.id;
    const inst = await installation();
    const res = await elif.api.call('runPluginCommand', {
      params: { conversationId: group.id },
      body: { installationId: inst.id, command: 'hello', args: 'dünya' },
    });
    expect(res.reply).toBe('Merhaba elif, dünya');
    expect(seen.commands.at(-1)).toMatchObject({ user: elifId, scopes: ['hub:read', 'chat:send'] });
    expect(seen.commands.at(-1)!.spaces).toBeGreaterThan(0);
    const [msg] = await app.deps.db.select().from(messages).where(eq(messages.id, res.messageId!));
    expect(msg!.text).toBe('👋 dünya');
    expect(msg!.body.via).toMatchObject({ kind: 'plugin', client: 'Merhaba' });
  });

  it('sends ids-only events for group messages and new nodes, never for direct chats', async () => {
    seen.events.length = 0;
    await elif.api.call('sendMessage', {
      params: { conversationId: groupId },
      body: { clientMsgId: uuid(), text: 'gizli içerik' },
    });
    const dm = await elif.api.call('createConversation', {
      body: { type: 'direct', userId: canId },
    });
    await elif.api.call('sendMessage', {
      params: { conversationId: dm.id },
      body: { clientMsgId: uuid(), text: 'dm' },
    });
    const spaceId = (await owner.api.call('listSpaces')).items.find(
      (s) => s.name === 'Milvasoft',
    )!.id;
    const folder = await owner.api.call('createFolder', {
      params: { spaceId },
      body: { parentId: null, name: 'Olay' },
    });
    const types = seen.events.map((e) => e.type);
    expect(types).toEqual(['message.created', 'node.created']);
    expect(seen.events[0]!.data).toMatchObject({
      conversationId: groupId,
      conversationType: 'group',
    });
    expect(JSON.stringify(seen.events)).not.toContain('gizli içerik');
    expect(seen.events[1]!.data).toMatchObject({ nodeId: folder.id, spaceId });
  });

  it('lists plugin tools for assistant connections that cover them and runs an approved write', async () => {
    const [org] = await app.deps.db.select().from(organizations);
    const orgId = org!.id;
    const readOnly = await pluginTools(app.deps.db, orgId, ['hub:read']);
    expect(readOnly.map((t) => t.name)).toEqual(['plugin.com.example.hello.echo']);
    const both = await pluginTools(app.deps.db, orgId, ['hub:read', 'chat:send']);
    expect(both.map((t) => t.name)).toEqual([
      'plugin.com.example.hello.echo',
      'plugin.com.example.hello.post',
    ]);
    const inst = await installation();
    const out = await applyPluginTool(
      app.deps,
      {
        org: org!,
        actor: { userId: elifId, orgRole: 'member', orgPermissions: [] },
        userId: elifId,
      },
      {
        installationId: inst.id,
        tool: 'post',
        input: { text: 'selam' },
        scopes: ['hub:read', 'chat:send'],
      },
    );
    expect(out.result).toEqual({ content: { echoed: { text: 'selam' } }, summary: 'echo' });
  });
});

describe('updates, turning off and removing', () => {
  it('waits for new permissions before upgrading', async () => {
    const inst = await installation();
    const details = await expectCode(
      owner.api.call('upgradePlugin', {
        params: { installationId: inst.id },
        body: { version: '1.1.0' },
      }),
      409,
      'plugin_permissions_changed',
    );
    expect(details).toEqual({ added: ['drive:write'] });
    // Declining the new permission still upgrades; the plugin hears what it got.
    const next = await owner.api.call('upgradePlugin', {
      params: { installationId: inst.id },
      body: { version: '1.1.0', acceptPermissions: [] },
    });
    expect(next).toMatchObject({
      version: '1.1.0',
      update: null,
      permissions: ['hub:read', 'chat:send'],
      requestedPermissions: ['hub:read', 'chat:send', 'drive:write'],
    });
    expect(seen.lifecycle.at(-1)).toMatchObject({
      type: 'update',
      pluginVersion: '1.1.0',
      permissions: ['hub:read', 'chat:send'],
    });
  });

  it('changes the grant to a subset later, and tokens follow it', async () => {
    const inst = await installation();
    const narrowed = await owner.api.call('updatePluginInstallation', {
      params: { installationId: inst.id },
      body: { permissions: ['hub:read'] },
    });
    expect(narrowed.permissions).toEqual(['hub:read']);
    expect(seen.lifecycle.at(-1)).toMatchObject({ type: 'update', permissions: ['hub:read'] });
    const { token } = await elif.api.call('createPluginSessionToken', {
      params: { installationId: inst.id },
    });
    const claims = await verifySessionToken(token, {
      issuer: apiUrl,
      audience: 'com.example.hello',
    });
    expect(claims.scopes).toEqual(['hub:read']);
    const asPlugin = new Client(app);
    asPlugin.bearer = token;
    const dm = await elif.api.call('createConversation', {
      body: { type: 'direct', userId: canId },
    });
    await expectCode(
      asPlugin.api.call('sendMessage', {
        params: { conversationId: dm.id },
        body: { clientMsgId: uuid(), text: 'izin yok' },
      }),
      403,
      'token_scope',
    );
    expect((await elif.api.call('listPluginSurfaces')).items[0]?.permissions).toEqual(['hub:read']);
    // Granting what the version asks for, the one declined at the upgrade included, works too.
    const widened = await owner.api.call('updatePluginInstallation', {
      params: { installationId: inst.id },
      body: { permissions: ['hub:read', 'chat:send', 'drive:write'] },
    });
    expect(widened.permissions).toEqual(['hub:read', 'chat:send', 'drive:write']);
    await expectCode(
      owner.api.call('updatePluginInstallation', {
        params: { installationId: inst.id },
        body: { permissions: ['portal:publish'] },
      }),
      422,
      'plugin_permissions_mismatch',
    );
  });

  it('turns a plugin off for everyone and removes it', async () => {
    const inst = await installation();
    const { token } = await elif.api.call('createPluginSessionToken', {
      params: { installationId: inst.id },
    });
    await owner.api.call('updatePluginInstallation', {
      params: { installationId: inst.id },
      body: { enabled: false },
    });
    await expectCode(
      elif.api.call('createPluginSessionToken', { params: { installationId: inst.id } }),
      409,
      'plugin_disabled',
    );
    const asPlugin = new Client(app);
    asPlugin.bearer = token;
    await expectCode(asPlugin.api.call('listSpaces'), 409, 'plugin_disabled');
    expect((await elif.api.call('listPluginSurfaces')).items).toEqual([]);
    await owner.api.call('uninstallPlugin', { params: { installationId: inst.id } });
    expect(seen.lifecycle.at(-1)).toMatchObject({ type: 'uninstall', installationId: inst.id });
    expect((await owner.api.call('listPluginInstallations')).items).toEqual([]);
  });
});

describe('unlisted and self-hosted plugins', () => {
  beforeAll(() => {
    // The org's copy listens on a local port; only it is let through the outbound checks.
    configureOutbound(
      outboundPolicy({
        PRIVATE_FETCH_ALLOWLIST: '127.0.0.1',
        OUTBOUND_ALLOWED_PORTS: new URL(selfOrigin).port,
      }),
    );
  });

  it('finds an unlisted plugin by its id or the install link, never another host', async () => {
    const byId = await owner.api.call('lookupPlugin', { query: { ref: 'com.acme.wa' } });
    expect(byId).toMatchObject({
      id: 'com.acme.wa',
      hosting: 'self',
      visibility: 'unlisted',
      installationId: null,
    });
    const byLink = await owner.api.call('lookupPlugin', {
      query: { ref: `${marketUrl}/p/com.acme.wa` },
    });
    expect(byLink.id).toBe('com.acme.wa');
    await expectCode(
      owner.api.call('lookupPlugin', {
        query: { ref: 'https://market.evil.example/p/com.acme.wa' },
      }),
      422,
      'plugin_link_invalid',
    );
    await expectCode(
      owner.api.call('lookupPlugin', { query: { ref: 'bir şey' } }),
      422,
      'plugin_link_invalid',
    );
    await expectCode(
      elif.api.call('lookupPlugin', { query: { ref: 'com.acme.wa' } }),
      403,
      'forbidden',
    );
  });

  it("installs only when the org's own https copy serves the signed manifest", async () => {
    const install = (selfOriginInput?: string) =>
      owner.api.call('installPlugin', {
        body: {
          pluginId: 'com.acme.wa',
          version: '1.0.0',
          permissions: ['hub:read', 'chat:send'],
          ...(selfOriginInput !== undefined ? { selfOrigin: selfOriginInput } : {}),
        },
      });
    await expectCode(install(), 422, 'plugin_self_origin_required');
    await expectCode(install('https://wa.acme.com/bridge'), 422, 'plugin_self_origin_invalid');
    await expectCode(install('ftp://wa.acme.com'), 422, 'plugin_self_origin_invalid');
    expect(
      await expectCode(install('https://10.0.0.5'), 422, 'plugin_self_origin_invalid'),
    ).toEqual({ reason: 'blocked' });

    served = {
      ...selfManifest('1.0.0'),
      origin: selfOrigin,
      permissions: ['hub:read', 'drive:write'],
    };
    expect(await expectCode(install(selfOrigin), 422, 'plugin_self_manifest_mismatch')).toEqual({
      reason: 'permissions',
    });
    served = { ...selfManifest('1.0.0'), origin: 'https://someone-else.example' };
    expect(await expectCode(install(selfOrigin), 422, 'plugin_self_manifest_mismatch')).toEqual({
      reason: 'origin',
    });
    served = { ...selfManifest('1.0.0'), origin: selfOrigin, name: 'Başka' };
    expect(await expectCode(install(selfOrigin), 422, 'plugin_self_manifest_mismatch')).toEqual({
      reason: 'manifest',
    });

    served = { ...selfManifest('1.0.0'), origin: selfOrigin };
    const inst = await install(`${selfOrigin}/`);
    expect(inst).toMatchObject({ hosting: 'self', selfOrigin, origin: selfOrigin });
    // The lifecycle went to the org's copy, not to the reviewed reference deployment.
    expect(selfLifecycle.at(-1)).toMatchObject({ type: 'install', installationId: inst.id });
    const surface = (await elif.api.call('listPluginSurfaces')).items.find(
      (x) => x.pluginId === 'com.acme.wa',
    );
    expect(surface?.origin).toBe(selfOrigin);
    const [audit] = await app.deps.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'plugin.install'), eq(auditLogs.targetId, inst.id)));
    expect(audit!.meta).toMatchObject({ hosting: 'self', selfOrigin });
    // The signed package is kept as it was signed.
    const [row] = await app.deps.db
      .select()
      .from(pluginInstallations)
      .where(eq(pluginInstallations.id, inst.id));
    expect(row!.package.manifest.origin).toBe(SELF_REFERENCE);
    expect(row!.manifest.origin).toBe(selfOrigin);
  });

  it('sees updates of an unlisted plugin and checks the copy again before upgrading', async () => {
    const inst = (await owner.api.call('listPluginInstallations')).items.find(
      (i) => i.pluginId === 'com.acme.wa',
    )!;
    expect(inst.update).toEqual({ version: '1.1.0', addedPermissions: ['drive:write'] });
    const upgrade = (version: string) =>
      owner.api.call('upgradePlugin', {
        params: { installationId: inst.id },
        body: { version, acceptPermissions: [] },
      });
    // The copy still serves 1.0.0: not upgraded.
    expect(await expectCode(upgrade('1.1.0'), 422, 'plugin_self_manifest_mismatch')).toEqual({
      reason: 'version',
    });
    served = {
      ...selfManifest('1.1.0', { permissions: ['hub:read', 'chat:send', 'drive:write'] }),
      origin: selfOrigin,
    };
    expect(await upgrade('1.1.0')).toMatchObject({
      version: '1.1.0',
      origin: selfOrigin,
      permissions: ['hub:read', 'chat:send'],
    });
    expect(selfLifecycle.at(-1)).toMatchObject({ type: 'update', pluginVersion: '1.1.0' });
    // A version that moves to the publisher's server needs a fresh install.
    await expectCode(upgrade('1.2.0'), 409, 'plugin_hosting_changed');
    await owner.api.call('uninstallPlugin', { params: { installationId: inst.id } });
    expect(selfLifecycle.at(-1)).toMatchObject({ type: 'uninstall' });
  });
});

describe('browser features', () => {
  it('delegates only what the admin granted, asks again for new ones', async () => {
    const inst = await owner.api.call('installPlugin', {
      body: {
        pluginId: 'com.example.media',
        version: '1.0.0',
        permissions: ['hub:read', 'chat:send'],
        browser: ['geolocation'],
      },
    });
    expect(inst).toMatchObject({
      browser: ['geolocation'],
      requestedBrowser: ['microphone', 'geolocation'],
    });
    expect(seen.lifecycle.at(-1)).toMatchObject({ type: 'install', browser: ['geolocation'] });
    const surface = (await elif.api.call('listPluginSurfaces')).items.find(
      (s) => s.installationId === inst.id,
    );
    expect(surface?.browser).toEqual(['geolocation']);

    // Not asked for: refused.
    await expectCode(
      owner.api.call('updatePluginInstallation', {
        params: { installationId: inst.id },
        body: { browser: ['camera'] },
      }),
      422,
      'plugin_permissions_mismatch',
    );
    const changed = await owner.api.call('updatePluginInstallation', {
      params: { installationId: inst.id },
      body: { browser: ['microphone', 'geolocation'] },
    });
    expect(changed.browser).toEqual(['microphone', 'geolocation']);
    expect(seen.lifecycle.at(-1)).toMatchObject({
      type: 'update',
      browser: ['microphone', 'geolocation'],
    });

    // 1.1.0 asks for the camera too: the upgrade waits for the admin's answer.
    expect(
      await expectCode(
        owner.api.call('upgradePlugin', {
          params: { installationId: inst.id },
          body: { version: '1.1.0', acceptPermissions: [] },
        }),
        409,
        'plugin_permissions_changed',
      ),
    ).toMatchObject({ addedBrowser: ['camera'] });
    const up = await owner.api.call('upgradePlugin', {
      params: { installationId: inst.id },
      body: { version: '1.1.0', acceptPermissions: [], acceptBrowser: [] },
    });
    expect(up).toMatchObject({
      version: '1.1.0',
      browser: ['microphone', 'geolocation'],
      requestedBrowser: ['microphone', 'geolocation', 'camera'],
    });
    await owner.api.call('uninstallPlugin', { params: { installationId: inst.id } });
  });

  it('grants none when the install leaves them out', async () => {
    const inst = await owner.api.call('installPlugin', {
      body: { pluginId: 'com.example.media', version: '1.0.0', permissions: [] },
    });
    expect(inst.browser).toEqual([]);
    await owner.api.call('uninstallPlugin', { params: { installationId: inst.id } });
  });
});
