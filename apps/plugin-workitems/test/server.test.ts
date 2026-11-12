import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from 'jose';
import { PluginManifest } from '@crewhall/plugin-sdk';
import { signRequest, SESSION_TOKEN_TYPE } from '@crewhall/plugin-sdk/server';
import { Engine, type Hint } from '../src/engine';
import type { FetchLike } from '../src/providers/http';
import { createPlugin, loadManifest, productFrom } from '../src/server';
import { memoryStore, sealer as makeSealer, type Store } from '../src/store';
import type { Connection, Product, Sync } from '../src/types';

const API = 'https://hub.test';
const INSTALL = 'inst-1';
const SECRET = 's'.repeat(40);
const sealer = makeSealer('k'.repeat(40));
let privateKey: CryptoKey;
let jwks: JWTVerifyGetKey;
let audience = 'com.milvasoft.workitems';

beforeAll(async () => {
  const pair = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  privateKey = pair.privateKey;
  const jwk = await exportJWK(pair.publicKey);
  jwks = createLocalJWKSet({ keys: [{ ...jwk, kid: 'k', alg: 'EdDSA', use: 'sig' }] });
});

const token = (sub: string, over: { inst?: string; aud?: string } = {}) =>
  new SignJWT({
    org: 'org',
    inst: over.inst ?? INSTALL,
    name: 'N',
    email: 'n@x.dev',
    scope: 'hub:read boards:write',
  })
    .setProtectedHeader({ alg: 'EdDSA', kid: 'k', typ: SESSION_TOKEN_TYPE })
    .setIssuer(API)
    .setAudience(over.aud ?? audience)
    .setSubject(sub)
    .setExpirationTime('5m')
    .sign(privateKey);

describe('plugin server', () => {
  let store: Store;
  let app: ReturnType<typeof createPlugin>['app'];
  let requested: { id: string; hint: Partial<Hint> }[];
  let remote: (url: URL, init?: RequestInit) => Response;

  const page = async (method: string, path: string, user: string | null, body?: unknown) =>
    app.request(path, {
      method,
      headers: {
        ...(user ? { Authorization: `Bearer ${await token(user)}` } : {}),
        'crewhall-installation': INSTALL,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

  const crewhallSigned = async (path: string, payload: unknown, secret = SECRET) => {
    const body = JSON.stringify(payload);
    return app.request(path, {
      method: 'POST',
      headers: await signRequest(secret, INSTALL, body),
      body,
    });
  };

  const install = () =>
    crewhallSigned('/crewhall/lifecycle', {
      type: 'install',
      installationId: INSTALL,
      apiUrl: API,
      org: { id: 'org', name: 'Org', domain: 'x' },
      pluginVersion: '0.1.0',
      permissions: ['hub:read', 'boards:write'],
      secret: SECRET,
    });

  /** A fresh copy of the server for one product, with one installation in it. */
  const start = async (product: Product) => {
    store = memoryStore();
    requested = [];
    remote = () => new Response('{}', { status: 404 });
    audience = product === 'jira' ? 'com.milvasoft.jira' : 'com.milvasoft.workitems';
    const doFetch = (async (input: URL | string, init?: RequestInit) =>
      remote(new URL(String(input)), init)) as unknown as FetchLike;
    const engine = {
      request: async (id: string, hint: Partial<Hint> = {}) => void requested.push({ id, hint }),
    } as unknown as Engine;
    const manifest = PluginManifest.parse({
      ...(await loadManifest('https://plugin.test', product)),
    });
    ({ app } = createPlugin({
      product,
      manifest,
      store,
      sealer,
      fetch: doFetch,
      engine,
      allowPrivateHosts: false,
      clientJs: '',
      jwks,
      apiFetch: doFetch,
    }));
    expect((await install()).status).toBe(200);
  };

  beforeEach(() => start('azure'));

  it('loads its script and styles from addresses a release changes', async () => {
    const page = await (await app.request('/tab')).text();
    expect(page).toMatch(/\/client\.js\?v=[0-9a-f]{12}/);
    expect(page).toMatch(/\/app\.css\?v=[0-9a-f]{12}/);
  });

  it('ships a manifest the SDK accepts, with everything sync needs', async () => {
    const m = await loadManifest();
    expect(m.permissions).toEqual(
      expect.arrayContaining(['boards:write', 'offline:access', 'hub:read']),
    );
    expect(m.entryPoints.events.map((e) => e.type)).toContain('board.card.changed');
    expect(m.apiLevel.min).toBe(2);
    expect(m.hosting).toBe('self');
  });

  it('keeps the installation secret sealed and refuses a bad signature', async () => {
    const row = await store.get<{ secret: string }>('installation', INSTALL);
    expect(row!.secret).not.toContain(SECRET);
    expect(sealer.open(row!.secret)).toBe(SECRET);
    const res = await crewhallSigned(
      '/events',
      { id: 'e', type: 'x', installationId: INSTALL, occurredAt: 'n', data: {} },
      'w'.repeat(40),
    );
    expect(res.status).toBe(401);
  });

  it('needs a session token from this installation for the plugin', async () => {
    expect((await page('GET', '/api/state', null)).status).toBe(401);
    const res = await app.request('/api/state', {
      headers: {
        Authorization: `Bearer ${await token('u1', { aud: 'com.other' })}`,
        'crewhall-installation': INSTALL,
      },
    });
    expect(res.status).toBe(401);
    const wrong = await app.request('/api/state', {
      headers: {
        Authorization: `Bearer ${await token('u1', { inst: 'other' })}`,
        'crewhall-installation': INSTALL,
      },
    });
    expect(wrong.status).toBe(401);
    expect((await page('GET', '/api/state', 'u1')).status).toBe(200);
  });

  const azureOk = () => {
    remote = (url) =>
      url.pathname.endsWith('/_apis/connectionData')
        ? Response.json({
            authenticatedUser: {
              providerDisplayName: 'Ali',
              properties: { Account: { $value: 'ali@x.dev' } },
            },
          })
        : new Response('{}', { status: 404 });
  };

  it('saves a PAT only after the service accepts it, and never returns it', async () => {
    azureOk();
    const res = await page('POST', '/api/connections', 'u1', {
      provider: 'azure',
      name: 'Org',
      baseUrl: 'https://dev.azure.com/org/',
      token: 'super-secret-token',
    });
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(text).not.toContain('super-secret');
    expect(JSON.parse(text)).toMatchObject({
      baseUrl: 'https://dev.azure.com/org',
      account: 'ali@x.dev',
      authKind: 'pat',
    });
    const stored = await store.all<Connection>('connection');
    expect(JSON.stringify(stored)).not.toContain('super-secret');

    remote = () => new Response('{}', { status: 401 });
    const bad = await page('POST', '/api/connections', 'u1', {
      provider: 'azure',
      name: 'X',
      baseUrl: 'https://dev.azure.com/org',
      token: 'wrong-token-value',
    });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: 'auth_failed' });
    expect(await store.all('connection')).toHaveLength(1);
  });

  it('refuses plain http addresses', async () => {
    const res = await page('POST', '/api/connections', 'u1', {
      provider: 'azure',
      name: 'X',
      baseUrl: 'http://azure.internal',
      token: 'token-value-x',
    });
    expect(await res.json()).toMatchObject({ error: 'invalid_url' });
  });

  it('keeps one person out of another’s connections and syncs', async () => {
    azureOk();
    const made = (await (
      await page('POST', '/api/connections', 'u1', {
        provider: 'azure',
        name: 'O',
        baseUrl: 'https://dev.azure.com/o',
        token: 'token-value-x',
      })
    ).json()) as { id: string };
    expect((await page('DELETE', `/api/connections/${made.id}`, 'u2')).status).toBe(404);
    expect((await page('GET', `/api/connections/${made.id}/projects`, 'u2')).status).toBe(404);
    const state = (await (await page('GET', '/api/state', 'u2')).json()) as {
      connections: unknown[];
    };
    expect(state.connections).toEqual([]);
  });

  const sync = async (over: Partial<Sync> = {}) => {
    const s = {
      id: 's1',
      installationId: INSTALL,
      ownerId: 'u1',
      connectionId: 'c1',
      boardId: 'b1',
      enabled: true,
      webhookToken: 'right-token',
      scope: { project: 'P', types: [], filter: '' },
      ...over,
    } as Sync;
    await store.put('sync', s.id, INSTALL, s);
    await store.put('connection', 'c1', INSTALL, {
      id: 'c1',
      installationId: INSTALL,
      ownerId: 'u1',
      provider: 'azure',
      baseUrl: 'https://dev.azure.com/o',
      auth: sealer.seal(JSON.stringify({ kind: 'pat', token: 'x' })),
    } as Connection);
    return s;
  };

  it('turns a webhook into a look at that item, only with the right address', async () => {
    await sync();
    const body = JSON.stringify({ resource: { workItemId: 7 } });
    expect((await app.request('/webhooks/s1/wrong', { method: 'POST', body })).status).toBe(404);
    expect(requested).toEqual([]);
    expect((await app.request('/webhooks/s1/right-token', { method: 'POST', body })).status).toBe(
      200,
    );
    expect(requested).toEqual([{ id: 's1', hint: { extIds: ['7'] } }]);
  });

  it('turns a card event into a look at that card on the right board', async () => {
    await sync();
    const event = (boardId: string) => ({
      id: 'e',
      type: 'board.card.changed',
      installationId: INSTALL,
      occurredAt: new Date().toISOString(),
      data: { cardId: 'card1', boardId, change: 'updated' },
    });
    await crewhallSigned('/events', event('other'));
    expect(requested).toEqual([]);
    await crewhallSigned('/events', event('b1'));
    expect(requested).toEqual([{ id: 's1', hint: { cardIds: ['card1'] } }]);
  });

  it('never exposes the webhook token and lets only the owner run a sync', async () => {
    await sync();
    const state = await (await page('GET', '/api/state', 'u1')).text();
    expect(state).not.toContain('right-token');
    expect((await page('POST', '/api/syncs/s1/run', 'u2')).status).toBe(404);
    expect((await page('POST', '/api/syncs/s1/run', 'u1')).status).toBe(200);
  });

  it('checks the board with the person’s own rights', async () => {
    azureOk();
    const conn = (await (
      await page('POST', '/api/connections', 'u1', {
        provider: 'azure',
        name: 'O',
        baseUrl: 'https://dev.azure.com/o',
        token: 'token-value-x',
      })
    ).json()) as { id: string };
    let auth = '';
    remote = (url, init) => {
      if (url.pathname.includes('/api/v1/boards/')) {
        auth = (init?.headers as Record<string, string>).Authorization ?? '';
        return Response.json({ board: { id: 'b', name: 'B', myRole: 'viewer' }, columns: [] });
      }
      return new Response('{}', { status: 404 });
    };
    const res = await page('POST', '/api/syncs', 'u1', {
      connectionId: conn.id,
      boardId: '11111111-1111-4111-8111-111111111111',
      project: 'P',
      columnMap: {},
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'board_read_only' });
    expect(auth).toMatch(/^Bearer /);
  });

  it('starts Entra with PKCE and refuses a callback it did not begin', async () => {
    const res = await page('POST', '/api/oauth/entra', 'u1', {
      name: 'Org',
      baseUrl: 'https://dev.azure.com/o',
      tenant: 'contoso.onmicrosoft.com',
      clientId: 'client-id-value',
    });
    const { url, id } = (await res.json()) as { url: string; id: string };
    const u = new URL(url);
    expect(u.hostname).toBe('login.microsoftonline.com');
    expect(u.pathname).toBe('/contoso.onmicrosoft.com/oauth2/v2.0/authorize');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('scope')).toContain('499b84ac-1321-427f-aa17-267ca6975798/.default');
    expect(u.searchParams.get('redirect_uri')).toBe('https://plugin.test/oauth/entra/callback');
    expect((await app.request('/oauth/entra/callback?state=nope&code=c')).status).toBe(400);
    expect(await (await page('GET', `/api/oauth/${id}`, 'u2')).json()).toMatchObject({
      error: 'not_found',
    });
  });

  it('completes Entra sign-in and saves the connection for the person who began it', async () => {
    const start = (await (
      await page('POST', '/api/oauth/entra', 'u1', {
        name: 'Org',
        baseUrl: 'https://dev.azure.com/o',
        clientId: 'client-id-value',
      })
    ).json()) as { id: string };
    let form = '';
    remote = (url, init) => {
      if (url.hostname === 'login.microsoftonline.com') {
        form = String(init?.body);
        return Response.json({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 });
      }
      return Response.json({ authenticatedUser: { providerDisplayName: 'Ali' } });
    };
    const res = await app.request(`/oauth/entra/callback?state=${start.id}&code=the-code`);
    expect(res.status).toBe(200);
    expect(form).toContain('code_verifier=');
    const [conn] = await store.all<Connection>('connection');
    expect(conn).toMatchObject({
      ownerId: 'u1',
      authKind: 'entra',
      provider: 'azure',
      account: 'Ali',
    });
    expect(JSON.stringify(conn)).not.toContain('"rt"');
    expect(await (await page('GET', `/api/oauth/${start.id}`, 'u1')).json()).toEqual({
      result: 'ok',
    });
    // A code cannot be replayed.
    expect(
      (await app.request(`/oauth/entra/callback?state=${start.id}&code=the-code`)).status,
    ).toBe(400);
  });

  it('removes everything on uninstall', async () => {
    await sync();
    remote = () => new Response('{}', { status: 200 });
    const res = await crewhallSigned('/crewhall/lifecycle', {
      type: 'uninstall',
      installationId: INSTALL,
    });
    expect(res.status).toBe(200);
    expect(await store.get('installation', INSTALL)).toBeNull();
    expect(await store.all('sync')).toEqual([]);
    expect(await store.all('connection')).toEqual([]);
  });

  describe('Azure pipelines and library', () => {
    const jira = async () => {
      await store.put('connection', 'j1', INSTALL, {
        id: 'j1',
        installationId: INSTALL,
        ownerId: 'u1',
        provider: 'jira',
        baseUrl: 'https://acme.atlassian.net',
        auth: sealer.seal(JSON.stringify({ kind: 'pat', token: 'x', email: 'a@x.dev' })),
      } as Connection);
    };

    const groupAnswer = {
      id: 7,
      name: 'prod',
      type: 'Vsts',
      variables: {
        URL: { value: 'https://x', isSecret: false },
        KEY: { value: null, isSecret: true },
      },
    };

    it('keeps one person out of another’s Azure connection', async () => {
      await sync();
      const paths = [
        ['GET', '/api/azure/c1/pipelines?project=Web'],
        ['GET', '/api/azure/c1/library?project=Web'],
        ['POST', '/api/azure/c1/pipelines/1/runs'],
        ['PUT', '/api/azure/c1/library/7/variables'],
      ] as const;
      const asked: string[] = [];
      remote = (url) => {
        asked.push(url.pathname);
        return Response.json({ value: [] });
      };
      for (const [method, path] of paths) {
        const body = method === 'GET' ? undefined : { project: 'Web', name: 'A', value: 'b' };
        expect((await page(method, path, 'u2', body)).status).toBe(404);
      }
      expect(asked).toEqual([]);
      expect((await page('GET', '/api/azure/c1/pipelines?project=Web', null)).status).toBe(401);
    });

    it('answers azure_only for a Jira connection', async () => {
      await jira();
      const res = await page('GET', '/api/azure/j1/pipelines?project=Web', 'u1');
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'azure_only' });
    });

    it('shows pipelines even where the approvals preview API is missing', async () => {
      await sync();
      remote = (url) =>
        url.pathname.endsWith('/approvals')
          ? new Response('{}', { status: 404 })
          : Response.json({ value: [] });
      const res = await page('GET', '/api/azure/c1/pipelines?project=Web', 'u1');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ pipelines: [], active: [], approvals: [] });
    });

    it('records who changed a variable without ever storing its value', async () => {
      await sync();
      let sent = '';
      remote = (_url, init) => {
        if (init?.method === 'PUT') {
          sent = String(init.body);
          return new Response(init.body as string, { status: 200 });
        }
        return Response.json(groupAnswer);
      };
      const res = await page('PUT', '/api/azure/c1/library/7/variables', 'u1', {
        project: 'Web',
        name: 'TOKEN',
        value: 'cok-gizli-deger',
        secret: true,
      });
      expect(res.status).toBe(200);
      expect(sent).toContain('cok-gizli-deger');
      expect(await res.text()).not.toContain('cok-gizli-deger');
      const activity = await (await page('GET', '/api/activity', 'u1')).text();
      expect(activity).toContain('prod · TOKEN');
      expect(activity).toContain('set_secret');
      expect(activity).not.toContain('cok-gizli-deger');
      expect(JSON.stringify(await store.all('log'))).not.toContain('cok-gizli-deger');
    });

    it('turns a Library refusal into its error code', async () => {
      await sync();
      remote = () => Response.json({ ...groupAnswer, type: 'AzureKeyVault' });
      const res = await page('DELETE', '/api/azure/c1/library/7/variables/URL?project=Web', 'u1');
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'library_read_only' });
      expect(await (await page('GET', '/api/activity', 'u1')).json()).toEqual({ items: [] });
    });

    it('refuses a variable name Azure could not hold', async () => {
      await sync();
      const res = await page('PUT', '/api/azure/c1/library/7/variables', 'u1', {
        project: 'Web',
        name: 'bad name',
        value: 'x',
      });
      expect(await res.json()).toEqual({ error: 'validation_failed' });
    });

    it('needs a project', async () => {
      await sync();
      const res = await page('GET', '/api/azure/c1/pipelines', 'u1');
      expect(await res.json()).toEqual({ error: 'validation_failed' });
    });

    it('starts a run and writes that down', async () => {
      await sync();
      let body = '';
      remote = (_url, init) => {
        body = String(init?.body);
        return Response.json({
          id: 3,
          buildNumber: '1',
          status: 'notStarted',
          sourceBranch: 'refs/heads/dev',
          definition: { id: 9, name: 'CI' },
        });
      };
      const res = await page('POST', '/api/azure/c1/pipelines/9/runs', 'u1', {
        project: 'Web',
        name: 'CI',
        branch: 'dev',
      });
      expect(res.status).toBe(201);
      expect(JSON.parse(body)).toEqual({ definition: { id: 9 }, sourceBranch: 'refs/heads/dev' });
      const { items } = (await (await page('GET', '/api/activity', 'u1')).json()) as {
        items: { action: string; target: string; project: string }[];
      };
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ action: 'run', target: 'CI · dev', project: 'Web' });
    });

    it('keeps activity inside its own installation', async () => {
      await store.put('log', 'ops:other:1', 'ops:other', { at: 'x', user: 'b', action: 'run' });
      expect(await (await page('GET', '/api/activity', 'u1')).json()).toEqual({ items: [] });
    });

    it('serves the brand font', async () => {
      const res = await app.request('/nunito-latin-ext.woff2');
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('font/woff2');
      expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(1000);
    });
  });

  describe('two products from one server', () => {
    const jiraConnection = {
      provider: 'jira',
      name: 'Jira',
      baseUrl: 'https://acme.atlassian.net',
      token: 'token-value-x',
      email: 'a@x.dev',
    };
    const azureConnection = {
      provider: 'azure',
      name: 'Azure',
      baseUrl: 'https://dev.azure.com/org',
      token: 'token-value-x',
    };
    const jiraOk = () => {
      remote = (url) =>
        url.pathname.endsWith('/myself')
          ? Response.json({ displayName: 'Ali', emailAddress: 'ali@x.dev', accountId: 'a' })
          : new Response('{}', { status: 404 });
    };
    const command = async (name: string, args: string) =>
      crewhallSigned(`/commands/${name}`, {
        installationId: INSTALL,
        command: name,
        args,
        conversationId: 'c',
        user: { id: 'u1', name: 'N' },
        token: await token('u1'),
        locale: 'tr',
      });

    it.each(['azure', 'jira'] as const)(
      'answers every entry point of the %s manifest',
      async (p) => {
        await start(p);
        const m = await loadManifest('https://plugin.test', p);
        for (const e of [...m.entryPoints.tabs, ...m.entryPoints.cards]) {
          expect((await app.request(e.url)).status, e.url).toBe(200);
        }
        // An unsigned call reaches the handler and is turned away; a missing route would be a 404.
        for (const e of [
          ...m.entryPoints.commands,
          ...m.entryPoints.tools,
          ...m.entryPoints.events,
        ]) {
          expect((await app.request(e.url, { method: 'POST', body: '{}' })).status, e.url).toBe(
            401,
          );
        }
      },
    );

    it.each([
      ['azure', 'com.milvasoft.workitems', 'Azure DevOps', 'https://azuredevops.crewhall.app'],
      ['jira', 'com.milvasoft.jira', 'Jira', 'https://jira.crewhall.app'],
    ] as const)('serves the %s manifest from both addresses', async (p, id, name, origin) => {
      expect(await loadManifest(undefined, p)).toMatchObject({ id, name: { tr: name }, origin });
      await start(p);
      for (const path of ['/manifest.json', '/.well-known/crewhall-plugin.json']) {
        expect(await (await app.request(path)).json()).toMatchObject({
          id,
          name: { tr: name, en: name },
          origin: 'https://plugin.test',
        });
      }
    });

    it('keeps the Azure identity and gives Pipeline and Library their own rail items', async () => {
      const m = await loadManifest();
      expect(m.id).toBe('com.milvasoft.workitems');
      expect(m.version).toBe('0.3.1');
      expect(m.entryPoints.tabs.map((x) => [x.id, x.url, x.placement])).toEqual([
        ['main', '/tab', 'rail'],
        ['pipelines', '/pipelines', 'rail'],
        ['library', '/library', 'rail'],
      ]);
      for (const section of ['pipelines', 'library']) {
        const html = await (await app.request(`/${section}`)).text();
        expect(html).toContain(`data-placement="${section}"`);
      }
    });

    it('gives Jira nothing of Azure', async () => {
      const m = await loadManifest(undefined, 'jira');
      expect(m.version).toBe('0.1.0');
      expect(m.entryPoints.tabs.map((x) => x.id)).toEqual(['main']);
      expect(m.entryPoints.commands.map((x) => x.name)).toEqual(['jira']);
      const words = JSON.stringify(m).toLowerCase();
      for (const word of ['azure', 'pipeline', 'library', 'entra']) {
        expect(words).not.toContain(word);
      }
      await start('jira');
      expect(await (await app.request('/tab')).text()).toContain('data-product="jira"');
      for (const path of ['/pipelines', '/library', '/oauth/entra/callback']) {
        expect((await app.request(path)).status, path).toBe(404);
      }
      for (const path of ['/api/oauth/entra', '/api/azure/c1/projects', '/commands/pipeline']) {
        expect((await page('POST', path, 'u1', {})).status, path).toBe(404);
      }
    });

    it('takes a new connection only for its own service', async () => {
      jiraOk();
      expect((await page('POST', '/api/connections', 'u1', jiraConnection)).status).toBe(400);
      expect(await store.all('connection')).toEqual([]);

      await start('jira');
      jiraOk();
      expect((await page('POST', '/api/connections', 'u1', azureConnection)).status).toBe(400);
      expect((await page('POST', '/api/connections', 'u1', jiraConnection)).status).toBe(201);
    });

    it('keeps a Jira connection saved before the split working on Azure', async () => {
      await store.put('connection', 'old', INSTALL, {
        id: 'old',
        installationId: INSTALL,
        ownerId: 'u1',
        provider: 'jira',
        name: 'Eski Jira',
        baseUrl: 'https://acme.atlassian.net',
        account: 'a@x.dev',
        authKind: 'pat',
        auth: sealer.seal(JSON.stringify({ kind: 'pat', token: 'x', email: 'a@x.dev' })),
        createdAt: new Date().toISOString(),
      } as Connection);
      remote = (url) =>
        url.pathname.includes('/project')
          ? Response.json({ values: [{ key: 'ABC', name: 'Proje' }], isLast: true })
          : new Response('{}', { status: 404 });
      const state = (await (await page('GET', '/api/state', 'u1')).json()) as {
        connections: { id: string; provider: string }[];
      };
      expect(state.connections).toMatchObject([{ id: 'old', provider: 'jira' }]);
      const res = await page('GET', '/api/connections/old/projects', 'u1');
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ items: [{ key: 'ABC' }] });
    });

    it('names its own command in the usage note', async () => {
      expect(await (await command('is', '')).json()).toMatchObject({
        reply: expect.stringContaining('/is 123') as string,
      });
      await start('jira');
      expect(await (await command('jira', '')).json()).toMatchObject({
        reply: expect.stringContaining('/jira ABC-12') as string,
      });
    });

    it('draws its own icon', async () => {
      const azure = await (await app.request('/icon.svg')).text();
      await start('jira');
      const jira = await (await app.request('/icon.svg')).text();
      expect(azure).toContain('<svg');
      expect(jira).not.toBe(azure);
    });

    it('refuses an unknown product', () => {
      expect(productFrom(undefined)).toBe('azure');
      expect(productFrom('jira')).toBe('jira');
      expect(() => productFrom('trello')).toThrow();
    });
  });
});
