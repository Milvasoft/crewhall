import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Hono, type Context } from 'hono';
import type { JWTVerifyGetKey } from 'jose';
import { createApiClient } from '@crewhall/api-client';
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
  type ToolResponse,
} from '@crewhall/plugin-sdk/server';

/**
 * The sample plugin's own server (docs/contracts/eklentiler.md › Örnek eklenti). Everything a
 * real plugin needs is here, small: keep the installation secret from the install request,
 * check the signature on every request from Crewhall, trust a person only through a session
 * token from that installation, and call Crewhall back with that token.
 */

export interface Installation {
  id: string;
  apiUrl: string;
  orgName: string;
  secret: string;
  permissions: string[];
}

/** Where installations live. A real plugin keeps them in its database (the secret encrypted). */
export interface InstallationStore {
  get(id: string): Installation | undefined;
  set(i: Installation): void;
  delete(id: string): void;
}

export function memoryStore(): InstallationStore {
  const map = new Map<string, Installation>();
  return {
    get: (id) => map.get(id),
    set: (i) => void map.set(i.id, i),
    delete: (id) => void map.delete(id),
  };
}

const manifestPath = fileURLToPath(new URL('../manifest.json', import.meta.url));

export async function loadManifest(origin?: string): Promise<Manifest> {
  const raw = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
  return PluginManifest.parse(origin ? { ...raw, origin } : raw);
}

export function createHelloPlugin(opts: {
  manifest: Manifest;
  store?: InstallationStore;
  /** The browser script for /tab and /card (bundled at start; tests pass a stub). */
  clientJs: string;
  /** Tests: a local key set instead of the installation's JWKS. */
  jwks?: JWTVerifyGetKey;
  /** Counts of what arrived, for the tab and for tests. */
  events?: { count: number };
}) {
  const { manifest } = opts;
  const store = opts.store ?? memoryStore();
  const events = opts.events ?? { count: 0 };
  const app = new Hono();

  /** A request from an installation we know, signed with its secret; else null. */
  async function signed(c: Context) {
    const body = await c.req.text();
    const inst = store.get(c.req.header(INSTALLATION_HEADER) ?? '');
    if (!inst) return null;
    const ok = await verifyRequest({
      secret: inst.secret,
      body,
      signature: c.req.header(SIGNATURE_HEADER),
    });
    return ok ? { inst, json: JSON.parse(body) as unknown } : null;
  }

  const verifyToken = (inst: Installation, token: string) =>
    verifySessionToken(token, {
      issuer: inst.apiUrl,
      audience: manifest.id,
      ...(opts.jwks ? { jwks: opts.jwks } : {}),
    });

  app.get('/manifest.json', (c) => c.json(manifest));
  app.get('/icon.svg', (c) =>
    c.body(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#FBC419"/><text x="32" y="42" font-size="30" text-anchor="middle" font-family="sans-serif">👋</text></svg>',
      200,
      { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' },
    ),
  );

  // ---- lifecycle: the secret arrives once, on install ----
  app.post(manifest.lifecycle.url, async (c) => {
    const body = await c.req.text();
    const parsed = LifecycleRequest.safeParse(JSON.parse(body));
    if (!parsed.success) return c.json({ error: 'bad_request' }, 400);
    const req = parsed.data;
    // Install is signed with the secret it carries; later steps with the stored one.
    const secret = req.type === 'install' ? req.secret : store.get(req.installationId)?.secret;
    if (
      !secret ||
      !(await verifyRequest({ secret, body, signature: c.req.header(SIGNATURE_HEADER) }))
    ) {
      return c.json({ error: 'signature' }, 401);
    }
    if (req.type === 'install') {
      store.set({
        id: req.installationId,
        apiUrl: req.apiUrl,
        orgName: req.org.name,
        secret: req.secret,
        permissions: req.permissions,
      });
    } else if (req.type === 'update') {
      const inst = store.get(req.installationId);
      if (inst) store.set({ ...inst, permissions: req.permissions });
    } else {
      store.delete(req.installationId);
    }
    return c.json({ ok: true });
  });

  // ---- pages in Crewhall's iframe ----
  const page = (title: string) => `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>
  :root { color-scheme: light dark; --accent: #FBC419; }
  body { margin: 0; font: 15px/1.5 Nunito, system-ui, sans-serif; padding: 20px; }
  body.dark { background: #141516; color: #f2f2f2; }
  button { background: var(--accent); color: #141516; border: 0; border-radius: 10px; padding: 8px 14px; font-weight: 700; cursor: pointer; }
  pre { background: rgba(127,127,127,.12); border-radius: 10px; padding: 12px; overflow: auto; }
</style>
</head>
<body>
<h1 id="hello">…</h1>
<p id="where"></p>
<button id="whoami" hidden>Sunucuya kim olduğumu doğrulat</button>
<pre id="out" hidden></pre>
<script type="module" src="/client.js"></script>
</body>
</html>`;
  app.get('/tab', (c) => c.html(page('Merhaba')));
  app.get('/card', (c) => c.html(page('Bugün')));
  app.get('/client.js', (c) =>
    c.body(opts.clientJs, 200, { 'Content-Type': 'text/javascript; charset=utf-8' }),
  );

  /** The page sends its session token; we verify it and call Crewhall back as the person. */
  app.post('/api/whoami', async (c) => {
    const token = /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') ?? '')?.[1] ?? '';
    const inst = store.get(c.req.header(INSTALLATION_HEADER) ?? '');
    if (!inst || !token) return c.json({ error: 'unauthenticated' }, 401);
    try {
      const who = await verifyToken(inst, token);
      const api = createApiClient({ baseUrl: inst.apiUrl, getToken: () => token });
      const spaces = await api.call('listSpaces');
      return c.json({
        name: who.name,
        org: inst.orgName,
        scopes: who.scopes,
        spaces: spaces.items.length,
      });
    } catch {
      return c.json({ error: 'unauthenticated' }, 401);
    }
  });

  // ---- /hello in a chat ----
  app.post('/commands/hello', async (c) => {
    const s = await signed(c);
    if (!s) return c.json({ error: 'signature' }, 401);
    const req = CommandRequest.parse(s.json);
    await verifyToken(s.inst, req.token);
    const who = req.args.trim() || req.user.name;
    const res: CommandResponse = req.args.trim()
      ? { reply: `Merhaba ${req.user.name}, ${who} için selam yazdım.`, post: `👋 Merhaba ${who}!` }
      : { reply: `Merhaba ${req.user.name}! /hello <ad> yazarsan sohbete selam bırakırım.` };
    return c.json(res);
  });

  // ---- assistant tool ----
  app.post('/tools/greet', async (c) => {
    const s = await signed(c);
    if (!s) return c.json({ error: 'signature' }, 401);
    const req = ToolRequest.parse(s.json);
    const name = typeof req.input.name === 'string' ? req.input.name : req.user.name;
    const res: ToolResponse = { content: { greeting: `Merhaba ${name}` }, summary: name };
    return c.json(res);
  });

  // ---- events: ids only; count them ----
  app.post('/events', async (c) => {
    const s = await signed(c);
    if (!s) return c.json({ error: 'signature' }, 401);
    EventRequest.parse(s.json);
    events.count++;
    return c.json({});
  });

  return { app, store, events };
}
