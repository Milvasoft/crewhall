import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Hono, type Context } from 'hono';
import type { JWTVerifyGetKey } from 'jose';
import { z } from 'zod';
import { ApiError, createApiClient, type ApiClient } from '@crewhall/api-client';
import { PluginManifest, type PluginManifest as Manifest } from '@crewhall/plugin-sdk';
import {
  CommandRequest,
  EventRequest,
  INSTALLATION_HEADER,
  LifecycleRequest,
  SIGNATURE_HEADER,
  ToolRequest,
  verifyRequest,
  verifySessionToken,
  type CommandResponse,
  type SessionClaims,
  type ToolResponse,
} from '@crewhall/plugin-sdk/server';
import { portOf } from './crewhall';
import { Engine, safeEqual } from './engine';
import { AzureProvider } from './providers/azure';
import type { AzureOps } from './providers/azure-ops';
import { cleanBaseUrl, type FetchLike } from './providers/http';
import { entraAuthorizeUrl, entraToken, pkce, providerFor } from './providers';
import type { Sealer, Store } from './store';
import { CSS } from './style';
import {
  ProviderError,
  type AuthSecret,
  type Connection,
  type ExternalItem,
  type Installation,
  type Link,
  type LogEntry,
  type OAuthState,
  type Product,
  type Provider,
  type Sync,
} from './types';

/**
 * The plugin's own server: Crewhall's signed calls, the page's API (a person's session token on
 * every request), webhooks from the two services and the Entra sign-in.
 */

const manifestPath = (product: Product) =>
  fileURLToPath(
    new URL(product === 'jira' ? '../manifest.jira.json' : '../manifest.json', import.meta.url),
  );

export function productFrom(raw: string | undefined): Product {
  if (!raw || raw === 'azure') return 'azure';
  if (raw === 'jira') return 'jira';
  throw new Error('PLUGIN_PRODUCT must be azure or jira');
}

export async function loadManifest(origin?: string, product: Product = 'azure'): Promise<Manifest> {
  const raw = JSON.parse(await readFile(manifestPath(product), 'utf8')) as Record<string, unknown>;
  return PluginManifest.parse(origin ? { ...raw, origin } : raw);
}

/**
 * In the address of what a page loads: Cloudflare sets its own four-hour browser cache on .js and
 * .css whatever we answer, so without this a release stays invisible to anyone who opened it.
 */
const versionOf = (content: string) =>
  createHash('sha256').update(content).digest('hex').slice(0, 12);

// Simple Icons (CC0).
const BRAND_MARK: Record<Product, string> = {
  azure:
    'M0 8.877L2.247 5.91l8.405-3.416V.022l7.37 5.393L2.966 8.338v8.225L0 15.707zm24-4.45v14.651l-5.753 4.9-9.303-3.057v3.056l-5.978-7.416 15.057 1.798V5.415z',
  jira: 'M11.571 11.513H0a5.218 5.218 0 0 0 5.232 5.215h2.13v2.057A5.215 5.215 0 0 0 12.575 24V12.518a1.005 1.005 0 0 0-1.005-1.005zm5.723-5.756H5.736a5.215 5.215 0 0 0 5.215 5.214h2.129v2.058a5.218 5.218 0 0 0 5.215 5.214V6.758a1.001 1.001 0 0 0-1.001-1.001zM23.013 0H11.455a5.215 5.215 0 0 0 5.215 5.215h2.129v2.057A5.215 5.215 0 0 0 24 12.483V1.005A1.001 1.001 0 0 0 23.013 0Z',
};

const fonts = new Map<string, Buffer>();
/** The brand font, from this server: the frame loads nothing from elsewhere. */
function fontFile(subset: 'latin' | 'latin-ext') {
  let file = fonts.get(subset);
  if (!file) {
    file = readFileSync(
      fileURLToPath(
        import.meta.resolve(`@fontsource-variable/nunito/files/nunito-${subset}-wght-normal.woff2`),
      ),
    );
    fonts.set(subset, file);
  }
  return file;
}

export interface PluginOptions {
  product: Product;
  manifest: Manifest;
  store: Store;
  sealer: Sealer;
  fetch: FetchLike;
  engine: Engine;
  allowPrivateHosts: boolean;
  clientJs: string;
  entraDefaults?: { tenant: string; clientId: string; clientSecret?: string };
  /** Tests: a local key set instead of the installation's JWKS. */
  jwks?: JWTVerifyGetKey;
  /** Tests: Crewhall's API without the network. */
  apiFetch?: FetchLike;
}

const STATE_TTL_MS = 15 * 60_000;
const MINE_LIMIT = 25;

const ConnectionBody = z.object({
  provider: z.enum(['azure', 'jira']),
  name: z.string().trim().min(1).max(80),
  baseUrl: z.string().trim().min(8).max(300),
  token: z.string().trim().min(8).max(2000),
  email: z.email().max(255).optional(),
});

const EntraBody = z.object({
  name: z.string().trim().min(1).max(80),
  baseUrl: z.string().trim().min(8).max(300),
  tenant: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9.-]{3,100}$/)
    .optional(),
  clientId: z.string().trim().min(8).max(100).optional(),
  clientSecret: z.string().trim().max(500).optional(),
});

const SyncSettings = z.object({
  columnMap: z.record(z.string(), z.array(z.string().min(1).max(120)).max(30)),
  direction: z.enum(['both', 'to_crewhall', 'to_external']).default('both'),
  conflict: z.enum(['newest', 'external', 'crewhall']).default('newest'),
  comments: z.boolean().default(true),
  pushNewCards: z.boolean().default(false),
  defaultType: z.string().max(120).default(''),
  enabled: z.boolean().default(true),
});

const SyncBody = SyncSettings.extend({
  connectionId: z.string().uuid(),
  boardId: z.string().uuid(),
  project: z.string().min(1).max(200),
  types: z.array(z.string().min(1).max(120)).max(30).default([]),
  filter: z.string().max(2000).default(''),
  timeZone: z.string().max(64).default('UTC'),
});

const ProjectBody = z.object({ project: z.string().min(1).max(200) });
const VariableName = z.string().regex(/^[A-Za-z0-9_.-]{1,256}$/);
const VariableBody = ProjectBody.extend({
  name: VariableName,
  value: z.string().max(32_000),
  secret: z.boolean().default(false),
});

/** Who changed what in Azure from here. Names only, never a variable's value. */
interface Activity {
  at: string;
  user: string;
  action: string;
  project: string;
  target: string;
}

const view = (c: Connection) => ({
  id: c.id,
  provider: c.provider,
  name: c.name,
  baseUrl: c.baseUrl,
  account: c.account,
  authKind: c.authKind,
  createdAt: c.createdAt,
});

const syncView = ({ webhookToken: _t, ...s }: Sync) => s;

const brief = (i: ExternalItem) => ({
  id: i.id,
  key: i.key,
  url: i.url,
  type: i.type,
  title: i.fields.title,
  status: i.fields.status,
  assignee: i.fields.assignee ?? null,
  priority: i.fields.priority ?? null,
  dueDate: i.fields.dueDate ?? null,
  updatedAt: i.updatedAt,
});

interface Session {
  inst: Installation;
  who: SessionClaims;
  token: string;
  api: ApiClient;
}

export function createPlugin(opts: PluginOptions) {
  const { product, manifest, store, sealer, engine } = opts;
  const app = new Hono();

  // Registered first, so the routes below that only Azure has do not exist on a Jira copy.
  if (product === 'jira') {
    for (const path of [
      '/pipelines',
      '/library',
      '/api/azure/*',
      '/api/activity',
      '/api/oauth/*',
      '/oauth/entra/*',
      '/commands/pipeline',
      '/tools/pipelines',
      '/tools/run-pipeline',
    ]) {
      app.all(path, (c) => c.json({ error: 'not_found' }, 404));
    }
  }
  const deps = { sealer, fetch: opts.fetch, store };
  const providerOf = (c: Connection): Provider => providerFor(c, deps);

  const verifyToken = (inst: Installation, token: string) =>
    verifySessionToken(token, {
      issuer: inst.apiUrl,
      audience: manifest.id,
      ...(opts.jwks ? { jwks: opts.jwks } : {}),
    });

  const apiFor = (inst: Installation, token: string) =>
    createApiClient({
      baseUrl: inst.apiUrl,
      getToken: () => token,
      ...(opts.apiFetch ? { fetch: opts.apiFetch } : {}),
    });

  /** A request from the plugin's own page, as the person inside the frame. */
  async function session(c: Context): Promise<Session | null> {
    const token = /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') ?? '')?.[1] ?? '';
    const inst = await store.get<Installation>(
      'installation',
      c.req.header(INSTALLATION_HEADER) ?? '',
    );
    if (!inst || !token) return null;
    try {
      const who = await verifyToken(inst, token);
      if (who.inst !== inst.id) return null;
      return { inst, who, token, api: apiFor(inst, token) };
    } catch {
      return null;
    }
  }

  /** A request Crewhall signed with this installation's secret. */
  async function signed(c: Context) {
    const body = await c.req.text();
    const inst = await store.get<Installation>(
      'installation',
      c.req.header(INSTALLATION_HEADER) ?? '',
    );
    if (!inst) return null;
    const ok = await verifyRequest({
      secret: sealer.open(inst.secret),
      body,
      signature: c.req.header(SIGNATURE_HEADER),
    });
    return ok ? { inst, json: JSON.parse(body) as unknown } : null;
  }

  type Handler = (c: Context, s: Session) => Promise<Response>;
  const page =
    (h: Handler) =>
    async (c: Context): Promise<Response> => {
      const s = await session(c);
      if (!s) return c.json({ error: 'unauthenticated' }, 401);
      try {
        return await h(c, s);
      } catch (err) {
        if (err instanceof z.ZodError) return c.json({ error: 'validation_failed' }, 400);
        if (err instanceof ProviderError) {
          return c.json(
            { error: err.code, detail: err.message === err.code ? undefined : err.message },
            400,
          );
        }
        if (err instanceof ApiError) return c.json({ error: err.code }, 400);
        throw err;
      }
    };

  const ownConnection = async (s: Session, id: string) => {
    const conn = await store.get<Connection>('connection', id);
    return conn && conn.installationId === s.inst.id && conn.ownerId === s.who.sub ? conn : null;
  };
  const ownSync = async (s: Session, id: string) => {
    const sync = await store.get<Sync>('sync', id);
    return sync && sync.installationId === s.inst.id && sync.ownerId === s.who.sub ? sync : null;
  };
  const connectionsOf = async (installationId: string, userId: string) =>
    (await store.list<Connection>('connection', installationId)).filter(
      (c) => c.ownerId === userId,
    );

  const webhookUrl = (sync: Sync) => `${manifest.origin}/webhooks/${sync.id}/${sync.webhookToken}`;

  async function subscribe(sync: Sync, conn: Connection) {
    try {
      return await providerOf(conn).createWebhook(sync.scope, webhookUrl(sync));
    } catch {
      return null;
    }
  }

  async function removeSync(sync: Sync) {
    const conn = await store.get<Connection>('connection', sync.connectionId);
    if (conn && sync.webhookId) {
      await providerOf(conn)
        .removeWebhook(sync.webhookId)
        .catch(() => undefined);
    }
    await store.delScope('link', sync.id);
    await store.delScope('log', sync.id);
    await store.del('sync', sync.id);
  }

  // ---- public files ----
  app.get('/healthz', (c) => c.json({ status: 'ok' }));
  app.get('/manifest.json', (c) => c.json(manifest));
  app.get('/.well-known/crewhall-plugin.json', (c) => c.json(manifest));
  app.get('/icon.svg', (c) =>
    c.body(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#141516"/><path transform="translate(14 14) scale(1.5)" d="${BRAND_MARK[product]}" fill="#FBC419"/></svg>`,
      200,
      { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' },
    ),
  );
  const html = (placement: string) => `<!doctype html>
<html lang="tr" data-placement="${placement}" data-product="${product}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Crewhall</title>
<link rel="stylesheet" href="/app.css?v=${versionOf(CSS)}" />
</head>
<body><main id="app"></main><script type="module" src="/client.js?v=${versionOf(opts.clientJs)}"></script></body>
</html>`;
  for (const subset of ['latin', 'latin-ext'] as const) {
    app.get(`/nunito-${subset}.woff2`, (c) =>
      c.body(new Uint8Array(fontFile(subset)), 200, {
        'Content-Type': 'font/woff2',
        'Cache-Control': 'public, max-age=31536000, immutable',
      }),
    );
  }
  app.get('/tab', (c) => c.html(html('tab')));
  app.get('/card', (c) => c.html(html('card')));
  app.get('/pipelines', (c) => c.html(html('pipelines')));
  app.get('/library', (c) => c.html(html('library')));
  app.get('/app.css', (c) =>
    c.body(CSS, 200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-cache' }),
  );
  app.get('/client.js', (c) =>
    c.body(opts.clientJs, 200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-cache',
    }),
  );

  // ---- lifecycle: the secret arrives once, on install ----
  app.post(manifest.lifecycle.url, async (c) => {
    const body = await c.req.text();
    const parsed = LifecycleRequest.safeParse(JSON.parse(body));
    if (!parsed.success) return c.json({ error: 'bad_request' }, 400);
    const req = parsed.data;
    const stored = await store.get<Installation>('installation', req.installationId);
    const secret = req.type === 'install' ? req.secret : stored ? sealer.open(stored.secret) : null;
    if (
      !secret ||
      !(await verifyRequest({ secret, body, signature: c.req.header(SIGNATURE_HEADER) }))
    ) {
      return c.json({ error: 'signature' }, 401);
    }
    if (req.type === 'install') {
      const row: Installation = {
        id: req.installationId,
        apiUrl: req.apiUrl,
        orgId: req.org.id,
        orgName: req.org.name,
        secret: sealer.seal(req.secret),
        permissions: req.permissions,
      };
      await store.put('installation', row.id, 'all', row);
    } else if (req.type === 'update') {
      if (stored) {
        await store.put('installation', stored.id, 'all', {
          ...stored,
          permissions: req.permissions,
        });
      }
    } else {
      for (const sync of await store.list<Sync>('sync', req.installationId)) await removeSync(sync);
      await store.delScope('connection', req.installationId);
      await store.del('installation', req.installationId);
    }
    return c.json({ ok: true });
  });

  // ---- connections ----
  app.get(
    '/api/state',
    page(async (c, s) => {
      const [connections, syncs] = await Promise.all([
        connectionsOf(s.inst.id, s.who.sub),
        store.list<Sync>('sync', s.inst.id),
      ]);
      return c.json({
        connections: connections.map(view),
        syncs: syncs.filter((x) => x.ownerId === s.who.sub).map(syncView),
        entraDefaults: !!opts.entraDefaults,
        canWriteBoards: s.who.scopes.includes('boards:write'),
      });
    }),
  );

  app.post(
    '/api/connections',
    page(async (c, s) => {
      const body = ConnectionBody.parse(await c.req.json());
      // A connection saved before the split keeps working; a new one belongs to its own plugin.
      if (body.provider !== product) return c.json({ error: 'validation_failed' }, 400);
      const baseUrl = cleanBaseUrl(body.baseUrl, opts.allowPrivateHosts);
      const secret: AuthSecret = {
        kind: 'pat',
        token: body.token,
        ...(body.email ? { email: body.email } : {}),
      };
      const conn: Connection = {
        id: randomUUID(),
        installationId: s.inst.id,
        ownerId: s.who.sub,
        provider: body.provider,
        name: body.name,
        baseUrl,
        account: '',
        authKind: 'pat',
        auth: sealer.seal(JSON.stringify(secret)),
        createdAt: new Date().toISOString(),
      };
      // Nothing is saved until the service has accepted the token.
      const me = await providerOf(conn).whoami();
      conn.account = me.email ?? me.name;
      await store.put('connection', conn.id, conn.installationId, conn);
      return c.json(view(conn), 201);
    }),
  );

  app.delete(
    '/api/connections/:id',
    page(async (c, s) => {
      const conn = await ownConnection(s, c.req.param('id')!);
      if (!conn) return c.json({ error: 'not_found' }, 404);
      const used = (await store.list<Sync>('sync', s.inst.id)).some(
        (x) => x.connectionId === conn.id,
      );
      if (used) return c.json({ error: 'connection_in_use' }, 409);
      await store.del('connection', conn.id);
      return c.json({});
    }),
  );

  app.get(
    '/api/connections/:id/projects',
    page(async (c, s) => {
      const conn = await ownConnection(s, c.req.param('id')!);
      if (!conn) return c.json({ error: 'not_found' }, 404);
      return c.json({ items: await providerOf(conn).listProjects() });
    }),
  );

  app.get(
    '/api/connections/:id/meta',
    page(async (c, s) => {
      const conn = await ownConnection(s, c.req.param('id')!);
      if (!conn) return c.json({ error: 'not_found' }, 404);
      return c.json(await providerOf(conn).projectMeta(c.req.query('project') ?? ''));
    }),
  );

  // ---- Entra ID ----
  const redirectUri = () => `${manifest.origin}/oauth/entra/callback`;

  app.post(
    '/api/oauth/entra',
    page(async (c, s) => {
      const body = EntraBody.parse(await c.req.json());
      const baseUrl = cleanBaseUrl(body.baseUrl, opts.allowPrivateHosts);
      const tenant = body.tenant || opts.entraDefaults?.tenant || 'organizations';
      const clientId = body.clientId || opts.entraDefaults?.clientId;
      if (!clientId) return c.json({ error: 'entra_client_required' }, 400);
      const clientSecret = body.clientId ? body.clientSecret : opts.entraDefaults?.clientSecret;
      const { verifier, challenge } = pkce();
      const state: OAuthState = {
        id: randomBytes(32).toString('base64url'),
        installationId: s.inst.id,
        ownerId: s.who.sub,
        name: body.name,
        baseUrl,
        tenant,
        clientId,
        clientSecret: clientSecret ? sealer.seal(clientSecret) : null,
        verifier,
        createdAt: new Date().toISOString(),
        result: 'pending',
      };
      await store.put('oauth', state.id, 'all', state);
      return c.json({
        id: state.id,
        url: entraAuthorizeUrl({
          tenant,
          clientId,
          redirectUri: redirectUri(),
          state: state.id,
          challenge,
        }),
      });
    }),
  );

  app.get(
    '/api/oauth/:id',
    page(async (c, s) => {
      const state = await store.get<OAuthState>('oauth', c.req.param('id')!);
      if (!state || state.ownerId !== s.who.sub) return c.json({ error: 'not_found' }, 404);
      if (state.result !== 'pending') await store.del('oauth', state.id);
      return c.json({ result: state.result });
    }),
  );

  /** Microsoft sends the browser here; the only trust is the unguessable `state`. */
  app.get('/oauth/entra/callback', async (c) => {
    const done = (ok: boolean) =>
      c.html(
        `<!doctype html><meta charset="utf-8"><title>Crewhall</title><body style="font:15px system-ui;padding:32px"><p>${
          ok
            ? 'Bağlantı kuruldu. Bu pencereyi kapatabilirsin.'
            : 'Bağlantı kurulamadı. Pencereyi kapatıp yeniden dene.'
        }</p></body>`,
        ok ? 200 : 400,
      );
    const id = c.req.query('state') ?? '';
    const state = id ? await store.get<OAuthState>('oauth', id) : null;
    if (!state || state.result !== 'pending') return done(false);
    const fail = async () => {
      await store.put('oauth', state.id, 'all', { ...state, result: 'failed' });
      return done(false);
    };
    if (Date.now() - Date.parse(state.createdAt) > STATE_TTL_MS) return fail();
    const code = c.req.query('code');
    if (!code) return fail();
    try {
      const clientSecret = state.clientSecret ? sealer.open(state.clientSecret) : undefined;
      const token = await entraToken(opts.fetch, {
        tenant: state.tenant,
        clientId: state.clientId,
        clientSecret,
        form: {
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri(),
          code_verifier: state.verifier,
        },
      });
      if (!token.refresh_token) return await fail();
      const secret: AuthSecret = {
        kind: 'entra',
        tenant: state.tenant,
        clientId: state.clientId,
        ...(clientSecret ? { clientSecret } : {}),
        refreshToken: token.refresh_token,
        accessToken: token.access_token,
        expiresAt: Date.now() + (token.expires_in ?? 3600) * 1000,
      };
      const conn: Connection = {
        id: randomUUID(),
        installationId: state.installationId,
        ownerId: state.ownerId,
        provider: 'azure',
        name: state.name,
        baseUrl: state.baseUrl,
        account: '',
        authKind: 'entra',
        auth: sealer.seal(JSON.stringify(secret)),
        createdAt: new Date().toISOString(),
      };
      const me = await providerOf(conn).whoami();
      conn.account = me.email ?? me.name;
      await store.put('connection', conn.id, conn.installationId, conn);
      await store.put('oauth', state.id, 'all', { ...state, result: 'ok', clientSecret: null });
      return done(true);
    } catch {
      return fail();
    }
  });

  // ---- boards, as the person ----
  app.get(
    '/api/boards',
    page(async (c, s) => {
      const spaces = await s.api.call('listSpaces');
      const lists = await Promise.all(
        spaces.items.map(async (sp) => {
          const boards = await s.api.call('listBoards', { params: { spaceId: sp.id } });
          return boards.items.map((b) => ({ id: b.id, name: b.name, key: b.key, space: sp.name }));
        }),
      );
      return c.json({ items: lists.flat() });
    }),
  );

  app.get(
    '/api/boards/:id',
    page(async (c, s) => {
      const d = await s.api.call('getBoard', { params: { boardId: c.req.param('id')! } });
      return c.json({
        id: d.board.id,
        name: d.board.name,
        myRole: d.board.myRole,
        columns: d.columns.map((x) => ({ id: x.id, name: x.name, isDone: x.isDone })),
      });
    }),
  );

  // ---- syncs ----
  app.post(
    '/api/syncs',
    page(async (c, s) => {
      const body = SyncBody.parse(await c.req.json());
      const conn = await ownConnection(s, body.connectionId);
      if (!conn) return c.json({ error: 'not_found' }, 404);
      const board = await portOf(s.api).board(body.boardId);
      if (board.board.myRole === 'viewer') {
        return c.json({ error: 'board_read_only' }, 403);
      }
      const existing = await store.list<Sync>('sync', s.inst.id);
      if (existing.some((x) => x.boardId === body.boardId)) {
        return c.json({ error: 'board_already_synced' }, 409);
      }
      const known = new Set(board.columns.map((x) => x.id));
      if (Object.keys(body.columnMap).some((k) => !known.has(k))) {
        return c.json({ error: 'validation_failed' }, 400);
      }
      const meta = await providerOf(conn).projectMeta(body.project);
      if (body.pushNewCards && !meta.types.includes(body.defaultType)) {
        return c.json({ error: 'unknown_type' }, 400);
      }
      const sync: Sync = {
        id: randomUUID(),
        installationId: s.inst.id,
        ownerId: s.who.sub,
        connectionId: conn.id,
        boardId: body.boardId,
        boardName: board.board.name,
        scope: { project: body.project, types: body.types, filter: body.filter },
        columnMap: body.columnMap,
        direction: body.direction,
        conflict: body.conflict,
        comments: body.comments,
        pushNewCards: body.pushNewCards,
        defaultType: body.defaultType,
        timeZone: body.timeZone,
        enabled: body.enabled,
        webhookToken: randomBytes(24).toString('base64url'),
        webhookId: null,
        watermark: null,
        lastRunAt: null,
        lastError: null,
        linked: 0,
        createdAt: new Date().toISOString(),
      };
      sync.webhookId = await subscribe(sync, conn);
      await store.put('sync', sync.id, sync.installationId, sync);
      void engine.request(sync.id, { full: true });
      return c.json(syncView(sync), 201);
    }),
  );

  app.patch(
    '/api/syncs/:id',
    page(async (c, s) => {
      const sync = await ownSync(s, c.req.param('id')!);
      if (!sync) return c.json({ error: 'not_found' }, 404);
      const body = SyncSettings.partial().parse(await c.req.json());
      const next: Sync = { ...sync, ...body };
      await store.put('sync', sync.id, sync.installationId, next);
      if (next.enabled) void engine.request(sync.id, { full: true });
      return c.json(syncView(next));
    }),
  );

  app.delete(
    '/api/syncs/:id',
    page(async (c, s) => {
      const sync = await ownSync(s, c.req.param('id')!);
      if (!sync) return c.json({ error: 'not_found' }, 404);
      await removeSync(sync);
      return c.json({});
    }),
  );

  app.post(
    '/api/syncs/:id/run',
    page(async (c, s) => {
      const sync = await ownSync(s, c.req.param('id')!);
      if (!sync) return c.json({ error: 'not_found' }, 404);
      void engine.request(sync.id, { full: true });
      return c.json({});
    }),
  );

  app.get(
    '/api/syncs/:id/log',
    page(async (c, s) => {
      const sync = await ownSync(s, c.req.param('id')!);
      if (!sync) return c.json({ error: 'not_found' }, 404);
      const [log, links] = await Promise.all([
        store.list<LogEntry>('log', sync.id),
        store.list<Link>('link', sync.id),
      ]);
      return c.json({
        log: log.slice(0, 100),
        links: links
          .filter((l) => !l.removed)
          .slice(0, 200)
          .map((l) => ({ extKey: l.extKey, extUrl: l.extUrl, cardKey: l.cardKey })),
      });
    }),
  );

  // ---- Azure Pipelines and Library ----
  const azureRoute = (
    method: 'get' | 'post' | 'put' | 'delete',
    path: string,
    run: (c: Context, s: Session, ops: AzureOps, conn: Connection) => Promise<Response>,
  ) =>
    app[method](
      `/api/azure/:conn${path}`,
      page(async (c, s) => {
        const conn = await ownConnection(s, c.req.param('conn')!);
        if (!conn) return c.json({ error: 'not_found' }, 404);
        const provider = providerOf(conn);
        if (!(provider instanceof AzureProvider)) return c.json({ error: 'azure_only' }, 400);
        return run(c, s, provider.ops, conn);
      }),
    );

  const record = async (s: Session, action: string, project: string, target: string) => {
    const entry: Activity = {
      at: new Date().toISOString(),
      user: s.who.name,
      action,
      project,
      target,
    };
    const id = `ops:${s.inst.id}:${String(9_999_999_999_999 - Date.now()).padStart(13, '0')}-${randomBytes(3).toString('hex')}`;
    await store.put('log', id, `ops:${s.inst.id}`, entry);
  };

  const projectOf = (c: Context) => ProjectBody.parse({ project: c.req.query('project') }).project;
  const numeric = (raw: string | undefined) => z.coerce.number().int().positive().parse(raw);

  azureRoute('get', '/projects', async (c, _s, _ops, conn) =>
    c.json({ items: await providerOf(conn).listProjects() }),
  );

  azureRoute('get', '/pipelines', async (c, _s, ops) => {
    const project = projectOf(c);
    // Approvals are a preview API: a server without it still shows its pipelines.
    const [pipelines, active, approvals] = await Promise.all([
      ops.pipelines(project),
      ops.builds(project, { active: true, top: 30 }),
      ops.approvals(project).catch(() => []),
    ]);
    return c.json({ pipelines, active, approvals });
  });

  azureRoute('get', '/pipelines/:id/runs', async (c, _s, ops) =>
    c.json({
      items: await ops.builds(projectOf(c), { definitionId: numeric(c.req.param('id')) }),
    }),
  );

  azureRoute('post', '/pipelines/:id/runs', async (c, s, ops) => {
    const body = ProjectBody.extend({
      name: z.string().max(300).default(''),
      branch: z.string().trim().max(300).default(''),
    }).parse(await c.req.json());
    const run = await ops.run(body.project, numeric(c.req.param('id')), body.branch);
    await record(s, 'run', body.project, `${body.name || run.definitionName} · ${run.branch}`);
    return c.json(run, 201);
  });

  azureRoute('post', '/runs/:id/cancel', async (c, s, ops) => {
    const body = ProjectBody.extend({ name: z.string().max(300).default('') }).parse(
      await c.req.json(),
    );
    await ops.cancel(body.project, numeric(c.req.param('id')));
    await record(s, 'cancel', body.project, body.name || c.req.param('id')!);
    return c.json({});
  });

  azureRoute('post', '/runs/:id/retry', async (c, s, ops) => {
    const body = ProjectBody.extend({
      stage: z.string().min(1).max(300),
      name: z.string().max(300).default(''),
    }).parse(await c.req.json());
    await ops.retryStage(body.project, numeric(c.req.param('id')), body.stage);
    await record(s, 'retry', body.project, `${body.name} · ${body.stage}`);
    return c.json({});
  });

  azureRoute('get', '/runs/:id/timeline', async (c, _s, ops) =>
    c.json({ stages: await ops.timeline(projectOf(c), numeric(c.req.param('id'))) }),
  );

  azureRoute('get', '/runs/:id/logs/:log', async (c, _s, ops) =>
    c.json(await ops.log(projectOf(c), numeric(c.req.param('id')), numeric(c.req.param('log')))),
  );

  azureRoute('post', '/approvals/:id', async (c, s, ops) => {
    const body = ProjectBody.extend({
      decision: z.enum(['approved', 'rejected']),
      comment: z.string().max(1000).default(''),
      name: z.string().max(300).default(''),
    }).parse(await c.req.json());
    await ops.decide(body.project, c.req.param('id')!, body.decision, body.comment);
    await record(s, body.decision, body.project, body.name);
    return c.json({});
  });

  azureRoute('get', '/library', async (c, _s, ops) =>
    c.json({ items: await ops.groups(projectOf(c)) }),
  );

  azureRoute('put', '/library/:id/variables', async (c, s, ops) => {
    const body = VariableBody.parse(await c.req.json());
    const group = await ops.setVariable(
      body.project,
      numeric(c.req.param('id')),
      body.name,
      body.value,
      body.secret,
    );
    await record(
      s,
      body.secret ? 'set_secret' : 'set_variable',
      body.project,
      `${group.name} · ${body.name}`,
    );
    return c.json(group);
  });

  azureRoute('delete', '/library/:id/variables/:name', async (c, s, ops) => {
    const project = projectOf(c);
    const name = VariableName.parse(c.req.param('name'));
    const group = await ops.removeVariable(project, numeric(c.req.param('id')), name);
    await record(s, 'remove_variable', project, `${group.name} · ${name}`);
    return c.json(group);
  });

  app.get(
    '/api/activity',
    page(async (c, s) => {
      const items = await store.list<Activity>('log', `ops:${s.inst.id}`);
      return c.json({ items: items.slice(0, 50) });
    }),
  );

  // ---- my work ----
  async function eachConnection<T>(
    installationId: string,
    userId: string,
    run: (p: Provider, c: Connection) => Promise<T[]>,
  ): Promise<{ items: T[]; failed: string[] }> {
    const conns = await connectionsOf(installationId, userId);
    const failed: string[] = [];
    const lists = await Promise.all(
      conns.map(async (conn) => {
        try {
          return await run(providerOf(conn), conn);
        } catch {
          failed.push(conn.name);
          return [];
        }
      }),
    );
    return { items: lists.flat(), failed };
  }

  app.get(
    '/api/mine',
    page(async (c, s) => {
      const { items, failed } = await eachConnection(s.inst.id, s.who.sub, async (p, conn) =>
        (await p.assignedToMe(MINE_LIMIT)).map((i) => ({
          ...brief(i),
          provider: conn.provider,
          connection: conn.name,
        })),
      );
      items.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
      return c.json({ items: items.slice(0, MINE_LIMIT * 2), failed });
    }),
  );

  // ---- /is in a chat ----
  const looksAzure = (s: string) => /^#?\d+$/.test(s);
  const looksJira = (s: string) => /^[A-Za-z][A-Za-z0-9_]+-\d+$/.test(s);

  const line = (i: ExternalItem) =>
    `**${i.key} ${i.fields.title}** · ${i.fields.status}${
      i.fields.assignee ? ` · ${i.fields.assignee}` : ''
    }\n${i.url}`;

  async function lookup(inst: Installation, userId: string, ref: string) {
    const wanted = looksAzure(ref) ? 'azure' : looksJira(ref) ? 'jira' : null;
    if (!wanted) return null;
    const id = ref.replace(/^#/, '').toUpperCase();
    for (const conn of await connectionsOf(inst.id, userId)) {
      if (conn.provider !== wanted) continue;
      try {
        const item = await providerOf(conn).getItem(id);
        if (item) return { item, provider: providerOf(conn) };
      } catch {
        // The next connection may be the one that can see it.
      }
    }
    return null;
  }

  const commandName = product === 'jira' ? 'jira' : 'is';
  app.post(`/commands/${commandName}`, async (c) => {
    const s = await signed(c);
    if (!s) return c.json({ error: 'signature' }, 401);
    const req = CommandRequest.parse(s.json);
    await verifyToken(s.inst, req.token);
    const en = req.locale.startsWith('en');
    const say = (tr: string, english: string) => (en ? english : tr);
    const args = req.args.trim();
    if (!args) {
      const res: CommandResponse = {
        reply:
          product === 'jira'
            ? say(
                'Kullanım: /jira ABC-12 ya da /jira ara <metin>',
                'Usage: /jira ABC-12 or /jira search <text>',
              )
            : say('Kullanım: /is 123 ya da /is ara <metin>', 'Usage: /is 123 or /is ara <text>'),
      };
      return c.json(res);
    }
    const search = /^(?:ara|search)\s+(.+)$/i.exec(args)?.[1];
    if (search) {
      const { items } = await eachConnection(s.inst.id, req.user.id, (p) => p.search(search, 5));
      const res: CommandResponse = items.length
        ? { reply: items.slice(0, 10).map(line).join('\n\n').slice(0, 3900) }
        : { reply: say('Eşleşen iş bulunamadı.', 'No matching item.') };
      return c.json(res);
    }
    const hit = await lookup(s.inst, req.user.id, args);
    const res: CommandResponse = hit
      ? { post: line(hit.item).slice(0, 7900) }
      : {
          reply: say(
            'Bulunamadı. Eklenti sekmesinden bu işi görebilen bir bağlantı eklediğine bak.',
            'Not found. Check that you added a connection that can see it in the plugin tab.',
          ),
        };
    return c.json(res);
  });

  // ---- assistant tools ----
  app.post('/tools/search', async (c) => {
    const s = await signed(c);
    if (!s) return c.json({ error: 'signature' }, 401);
    const req = ToolRequest.parse(s.json);
    await verifyToken(s.inst, req.token);
    const query = z.string().min(1).max(200).parse(req.input.query);
    const { items, failed } = await eachConnection(s.inst.id, req.user.id, async (p) =>
      (await p.search(query, 10)).map(brief),
    );
    const res: ToolResponse = { content: { items, failed }, summary: `${items.length}` };
    return c.json(res);
  });

  app.post('/tools/mine', async (c) => {
    const s = await signed(c);
    if (!s) return c.json({ error: 'signature' }, 401);
    const req = ToolRequest.parse(s.json);
    await verifyToken(s.inst, req.token);
    const { items, failed } = await eachConnection(s.inst.id, req.user.id, async (p) =>
      (await p.assignedToMe(MINE_LIMIT)).map(brief),
    );
    const res: ToolResponse = { content: { items, failed }, summary: `${items.length}` };
    return c.json(res);
  });

  app.post('/tools/comment', async (c) => {
    const s = await signed(c);
    if (!s) return c.json({ error: 'signature' }, 401);
    const req = ToolRequest.parse(s.json);
    await verifyToken(s.inst, req.token);
    const input = z
      .object({ id: z.string().min(1).max(100), text: z.string().min(1).max(10_000) })
      .parse(req.input);
    const hit = await lookup(s.inst, req.user.id, input.id);
    const res: ToolResponse = hit
      ? {
          content: {
            ok: true,
            id: await hit.provider.addComment(hit.item, input.text),
            url: hit.item.url,
          },
          summary: hit.item.key,
        }
      : { content: { ok: false, error: 'not_found' } };
    return c.json(res);
  });

  // ---- pipelines from chat and the assistant ----
  const pipelineLine = (b: {
    definitionName: string;
    number: string;
    status: string;
    result: string | null;
    branch: string;
    url: string | null;
  }) =>
    `**${b.definitionName}** ${b.number} · ${b.result ?? b.status} · ${b.branch}${b.url ? `\n${b.url}` : ''}`;

  async function azureOpsOf(installationId: string, userId: string) {
    const out: AzureOps[] = [];
    for (const conn of await connectionsOf(installationId, userId)) {
      const p = providerOf(conn);
      if (p instanceof AzureProvider) out.push(p.ops);
    }
    return out;
  }

  app.post('/commands/pipeline', async (c) => {
    const s = await signed(c);
    if (!s) return c.json({ error: 'signature' }, 401);
    const req = CommandRequest.parse(s.json);
    await verifyToken(s.inst, req.token);
    const en = req.locale.startsWith('en');
    const project = req.args.trim();
    if (!project) {
      const res: CommandResponse = {
        reply: en ? 'Usage: /pipeline <project>' : 'Kullanım: /pipeline <proje>',
      };
      return c.json(res);
    }
    for (const ops of await azureOpsOf(s.inst.id, req.user.id)) {
      try {
        const runs = await ops.builds(project, { top: 8 });
        const res: CommandResponse = {
          reply: runs.length
            ? runs.map(pipelineLine).join('\n\n').slice(0, 3900)
            : en
              ? 'No runs in this project.'
              : 'Bu projede koşu yok.',
        };
        return c.json(res);
      } catch {
        // The next connection may be the one that can see it.
      }
    }
    const res: CommandResponse = {
      reply: en
        ? 'Project not found on your Azure DevOps connections.'
        : 'Bu proje Azure DevOps bağlantılarında bulunamadı.',
    };
    return c.json(res);
  });

  app.post('/tools/pipelines', async (c) => {
    const s = await signed(c);
    if (!s) return c.json({ error: 'signature' }, 401);
    const req = ToolRequest.parse(s.json);
    await verifyToken(s.inst, req.token);
    const project = z.string().min(1).max(200).parse(req.input.project);
    for (const ops of await azureOpsOf(s.inst.id, req.user.id)) {
      try {
        const items = await ops.pipelines(project);
        const res: ToolResponse = {
          content: {
            items: items.map((p) => ({
              id: p.id,
              name: p.name,
              status: p.latest?.status ?? null,
              result: p.latest?.result ?? null,
              branch: p.latest?.branch ?? null,
            })),
          },
          summary: String(items.length),
        };
        return c.json(res);
      } catch {
        // Try the next connection.
      }
    }
    const res: ToolResponse = { content: { error: 'not_found' } };
    return c.json(res);
  });

  app.post('/tools/run-pipeline', async (c) => {
    const s = await signed(c);
    if (!s) return c.json({ error: 'signature' }, 401);
    const req = ToolRequest.parse(s.json);
    await verifyToken(s.inst, req.token);
    const input = z
      .object({
        project: z.string().min(1).max(200),
        pipeline: z.union([z.number().int().positive(), z.string().min(1).max(300)]),
        branch: z.string().max(300).default(''),
      })
      .parse(req.input);
    for (const ops of await azureOpsOf(s.inst.id, req.user.id)) {
      try {
        const all = await ops.pipelines(input.project);
        const target = all.find((p) => p.id === input.pipeline || p.name === input.pipeline);
        if (!target) continue;
        const run = await ops.run(input.project, target.id, input.branch);
        const res: ToolResponse = {
          content: { id: run.id, number: run.number, branch: run.branch, url: run.url },
          summary: target.name,
        };
        return c.json(res);
      } catch {
        // Try the next connection.
      }
    }
    const res: ToolResponse = { content: { error: 'not_found' } };
    return c.json(res);
  });

  // ---- what changes ----
  app.post('/events', async (c) => {
    const s = await signed(c);
    if (!s) return c.json({ error: 'signature' }, 401);
    const ev = EventRequest.parse(s.json);
    if (ev.type !== 'board.card.changed') return c.json({});
    const boardId = String(ev.data.boardId ?? '');
    const cardId = String(ev.data.cardId ?? '');
    for (const sync of await store.list<Sync>('sync', s.inst.id)) {
      if (sync.boardId === boardId && sync.enabled)
        void engine.request(sync.id, { cardIds: [cardId] });
    }
    return c.json({});
  });

  /** The token in the address is the proof; what the body says is only a hint where to look. */
  app.post('/webhooks/:syncId/:token', async (c) => {
    const sync = await store.get<Sync>('sync', c.req.param('syncId'));
    if (!sync || !safeEqual(sync.webhookToken, c.req.param('token'))) {
      return c.json({ error: 'not_found' }, 404);
    }
    const conn = await store.get<Connection>('connection', sync.connectionId);
    if (!conn) return c.json({});
    const body = (await c.req.json().catch(() => null)) as unknown;
    const extIds = providerOf(conn).webhookItems(body).slice(0, 50);
    if (extIds.length && sync.enabled) void engine.request(sync.id, { extIds });
    return c.json({});
  });

  return { app };
}
