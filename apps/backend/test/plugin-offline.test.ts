import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { auditLogs, organizations } from '@crewhall/db';
import { ApiError } from '@crewhall/api-client';
import type { McpScope } from '@crewhall/shared';
import {
  generateSigningKey,
  PluginManifest,
  signPackage,
  type PluginManifestInput,
  type PluginPackage,
} from '@crewhall/plugin-sdk';
import {
  createServerClient,
  LifecycleRequest,
  OFFLINE_TOKEN_PATH,
  signApiRequest,
  verifySessionToken,
} from '@crewhall/plugin-sdk/server';
import { configureOutbound, outboundPolicy } from '../src/net/outbound';
import { pluginTools } from '../src/services/plugins/tools';
import { Client, createTestApp, join, setupWithOwner, type TestApp } from './helpers';

/**
 * Background access and card events (docs/contracts/eklentiler.md › Arka planda çalışma): a fake
 * plugin server over real sockets, and the three locks in turn.
 */

const PLUGIN = 'com.example.sync';

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

const listen = (a: { fetch: (r: Request) => Response | Promise<Response> }, port: number) =>
  new Promise<Server>((resolve) => {
    const s = serve({ fetch: a.fetch, port, hostname: '127.0.0.1' }, () =>
      resolve(s as Server),
    ) as Server;
  });

const closeServer = (s: Server) =>
  new Promise<void>((r) => {
    s.closeAllConnections?.();
    s.close(() => r());
  });

let app: TestApp;
let servers: Server[] = [];
let apiUrl: string;
let owner: Client;
let elif: Client;
let elifId: string;
let installationId: string;
let boardId: string;
let columnIds: string[];
let secret = '';
const events: { type: string; data: Record<string, unknown> }[] = [];

const client = () => createServerClient({ apiUrl, installationId, secret });

async function expectCode(p: Promise<unknown>, status: number, code: string) {
  try {
    await p;
  } catch (err) {
    expect((err as ApiError).status).toBe(status);
    expect((err as ApiError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

beforeAll(async () => {
  const key = await generateSigningKey();
  const [cPort, mPort, pPort] = [await freePort(), await freePort(), await freePort()];
  apiUrl = `http://127.0.0.1:${cPort}`;
  const origin = `http://127.0.0.1:${pPort}`;
  const manifest: PluginManifestInput = {
    manifestVersion: 1,
    id: PLUGIN,
    version: '1.0.0',
    name: 'Eşitleme',
    description: 'Örnek',
    publisher: { name: 'Example' },
    apiLevel: { min: 2 },
    origin,
    permissions: ['hub:read', 'boards:write', 'offline:access'],
    entryPoints: {
      tabs: [{ id: 'main', title: 'E', url: '/tab', placement: 'rail' }],
      events: [{ type: 'board.card.changed', url: '/events' }],
      tools: [{ name: 'comment', description: 'Yorum yazar', url: '/tools/c', write: true }],
    },
  };
  const pkg = await signPackage(
    PluginManifest.parse(manifest),
    { risk: 'verified', riskNote: null, reviewedAt: new Date().toISOString(), audience: null },
    { keyId: 'test-1', privateKey: key.privateKey },
  );

  const m = new Hono();
  const entry = (p: PluginPackage) => ({
    id: p.manifest.id,
    version: p.manifest.version,
    name: p.manifest.name,
    description: p.manifest.description,
    publisher: { name: 'Example' },
    homepage: null,
    icon: null,
    origin,
    risk: p.review.risk,
    riskNote: null,
    permissions: p.manifest.permissions,
    entryPoints: { tabs: 1, cards: 0, commands: 0, tools: 0, events: 1 },
    restricted: false,
    updatedAt: p.review.reviewedAt,
  });
  m.get('/v1/catalog', (c) => c.json({ items: [entry(pkg)] }));
  m.get('/v1/plugins/:id', (c) =>
    c.json({
      ...entry(pkg),
      hosting: 'hosted',
      visibility: 'public',
      versions: [{ version: '1.0.0', reviewedAt: pkg.review.reviewedAt, digest: 'x' }],
    }),
  );
  m.get('/v1/plugins/:id/versions/:version/package', (c) => c.json(pkg));

  const p = new Hono();
  p.post('/crewhall/lifecycle', async (c) => {
    const req = LifecycleRequest.parse(await c.req.json());
    if (req.type === 'install') secret = req.secret;
    return c.json({ ok: true });
  });
  p.post('/events', async (c) => {
    const b = (await c.req.json()) as { type: string; data: Record<string, unknown> };
    events.push({ type: b.type, data: b.data });
    return c.json({});
  });

  servers.push(await listen(m, mPort), await listen(p, pPort));
  app = await createTestApp({
    API_URL: apiUrl,
    MARKETPLACE_URL: `http://127.0.0.1:${mPort}`,
    MARKETPLACE_PUBLIC_KEYS: `test-1:${key.publicKey}`,
  });
  servers.push(await listen(app.app, cPort));
  ({ owner } = await setupWithOwner(app));
  const spaceId = (await owner.api.call('listSpaces')).items.find(
    (s) => s.name === 'Milvasoft',
  )!.id;
  const e = await join(app, owner, 'elif@milvasoft.com', 'member', [spaceId]);
  elif = e.person;
  elifId = e.me.user.id;
  await owner.api.call('updateSpaceMember', {
    params: { spaceId, userId: elifId },
    body: { role: 'editor' },
  });
  const inst = await owner.api.call('installPlugin', {
    body: {
      pluginId: PLUGIN,
      version: '1.0.0',
      permissions: ['hub:read', 'boards:write', 'offline:access'],
    },
  });
  installationId = inst.id;
  const board = await elif.api.call('createBoard', {
    params: { spaceId },
    body: { parentId: null, name: 'Pano', template: 'sprint', cardChats: false },
  });
  boardId = board.id;
  const detail = await elif.api.call('getBoard', { params: { boardId } });
  columnIds = detail.columns.map((c) => c.id);
}, 120_000);

afterAll(async () => {
  await Promise.all(servers.map(closeServer));
  servers = [];
  configureOutbound(outboundPolicy({}));
  await app?.close();
});

describe('background access', () => {
  const params = () => ({ installationId });

  it('gives nothing to someone who never said yes', async () => {
    await expectCode(client().offlineToken(elifId), 403, 'plugin_offline_not_granted');
    await expect(
      elif.api.call('getPluginOfflineGrant', { params: params() }),
    ).resolves.toMatchObject({
      available: true,
      granted: false,
      grantedAt: null,
    });
  });

  it('refuses a request not signed with the installation secret', async () => {
    const body = JSON.stringify({ userId: elifId });
    const res = await fetch(new URL(OFFLINE_TOKEN_PATH, apiUrl), {
      method: 'POST',
      headers: await signApiRequest('x'.repeat(40), installationId, body),
      body,
    });
    expect(res.status).toBe(401);
  });

  it('after a person agrees, works as them, limited and audited', async () => {
    await expect(elif.api.call('grantPluginOffline', { params: params() })).resolves.toMatchObject({
      granted: true,
    });
    const { token } = await client().offlineToken(elifId);
    const claims = await verifySessionToken(token, { issuer: apiUrl, audience: PLUGIN });
    expect(claims.sub).toBe(elifId);
    expect(claims.scopes).toEqual(['hub:read', 'boards:write']);

    const asPlugin = new Client(app);
    asPlugin.bearer = token;
    const card = await asPlugin.api.call('createBoardCard', {
      params: { boardId },
      body: {
        columnId: columnIds[0]!,
        title: 'Azure’dan',
        afterId: null,
        beforeId: null,
        top: false,
        labels: [],
        assigneeIds: [],
        dueAt: null,
      },
    });
    expect(card.createdBy?.id).toBe(elifId);
    // It cannot reach anything past its permissions, nor give itself more.
    await expectCode(
      asPlugin.api.call('listSpaces').then(() =>
        asPlugin.api.call('createFolder', {
          params: { spaceId: claims.org },
          body: { parentId: null, name: 'x' },
        }),
      ),
      403,
      'token_scope',
    );
    await expectCode(
      asPlugin.api.call('grantPluginOffline', { params: params() }),
      403,
      'token_scope',
    );
    await expectCode(
      asPlugin.api.call('getPluginOfflineGrant', { params: params() }),
      403,
      'token_scope',
    );

    const rows = await app.deps.db
      .select()
      .from(auditLogs)
      .where(
        and(eq(auditLogs.action, 'plugin.offline_grant'), eq(auditLogs.targetId, installationId)),
      );
    expect(rows).toHaveLength(1);
  });

  it('does not hide a write tool from a connection that holds the real scopes', async () => {
    const [org] = await app.deps.db.select().from(organizations);
    const names = async (scopes: McpScope[]) =>
      (await pluginTools(app.deps.db, org!.id, scopes)).map((t) => t.name);
    expect(await names(['hub:read', 'boards:write'])).toEqual([`plugin.${PLUGIN}.comment`]);
    expect(await names(['hub:read'])).toEqual([]);
  });

  it('does not cover anyone else', async () => {
    const me = await owner.api.call('me');
    await expectCode(client().offlineToken(me.user.id), 403, 'plugin_offline_not_granted');
  });

  it('ends when the person takes it back', async () => {
    await expect(elif.api.call('revokePluginOffline', { params: params() })).resolves.toMatchObject(
      {
        granted: false,
      },
    );
    await expectCode(client().offlineToken(elifId), 403, 'plugin_offline_not_granted');
  });

  it('ends when the admin takes the permission away, and cannot be granted then', async () => {
    await elif.api.call('grantPluginOffline', { params: params() });
    await owner.api.call('updatePluginInstallation', {
      params: params(),
      body: { permissions: ['hub:read', 'boards:write'] },
    });
    await expectCode(client().offlineToken(elifId), 403, 'plugin_offline_not_granted');
    await expectCode(
      elif.api.call('grantPluginOffline', { params: params() }),
      403,
      'plugin_offline_not_granted',
    );
    await expect(
      elif.api.call('getPluginOfflineGrant', { params: params() }),
    ).resolves.toMatchObject({
      available: false,
      granted: false,
    });
    await owner.api.call('updatePluginInstallation', {
      params: params(),
      body: { permissions: ['hub:read', 'boards:write', 'offline:access'] },
    });
  });
});

describe('card events', () => {
  const body = {
    afterId: null,
    beforeId: null,
    top: false,
    labels: [],
    assigneeIds: [],
    dueAt: null,
  };
  const changes = () =>
    events.filter((e) => e.type === 'board.card.changed').map((e) => e.data.change);

  it('says what happened to a card, with ids only', async () => {
    events.length = 0;
    const card = await elif.api.call('createBoardCard', {
      params: { boardId },
      body: { ...body, columnId: columnIds[0]!, title: 'gizli başlık' },
    });
    const params = { cardId: card.id };
    await elif.api.call('updateBoardCard', { params, body: { description: 'gizli metin' } });
    await elif.api.call('moveBoardCard', {
      params,
      body: { columnId: columnIds[1]!, afterId: null, beforeId: null },
    });
    await elif.api.call('setBoardCardAssignees', { params, body: { userIds: [elifId] } });
    const comment = await elif.api.call('addBoardCardComment', {
      params,
      body: { text: 'gizli yorum' },
    });
    await elif.api.call('deleteBoardCard', { params });
    await elif.api.call('restoreBoardCard', { params });
    expect(changes()).toEqual([
      'created',
      'updated',
      'moved',
      'assignees',
      'comment',
      'deleted',
      'restored',
    ]);
    expect(events[0]!.data).toMatchObject({ cardId: card.id, boardId, change: 'created' });
    expect(events[4]!.data).toMatchObject({ activityId: comment.id });
    expect(JSON.stringify(events)).not.toContain('gizli');
  });

  it('reports each card of a bulk change', async () => {
    const make = (title: string) =>
      elif.api.call('createBoardCard', {
        params: { boardId },
        body: { ...body, columnId: columnIds[0]!, title },
      });
    const [a, b] = [await make('a'), await make('b')];
    events.length = 0;
    await elif.api.call('bulkUpdateBoardCards', {
      params: { boardId },
      body: { cardIds: [a.id, b.id], columnId: columnIds[1]! },
    });
    expect(events.map((e) => e.data.cardId)).toEqual([a.id, b.id]);
  });
});
