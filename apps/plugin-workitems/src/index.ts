import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { createServerClient, pluginTabUrl } from '@crewhall/plugin-sdk/server';
import { build } from 'esbuild';
import { offlinePorts } from './crewhall';
import { Engine } from './engine';
import { providerFor } from './providers';
import { guardedFetch } from './providers/http';
import { createPlugin, loadManifest, productFrom } from './server';
import { memoryStore, postgresStore, sealer as makeSealer, type Store } from './store';
import type { Installation, Sync } from './types';

/**
 * Environment:
 * - PORT (4341), PLUGIN_ORIGIN: the public https origin Crewhall frames and calls.
 * - PLUGIN_PRODUCT (azure): which plugin this copy serves, azure or jira.
 * - PLUGIN_SECRET: encrypts tokens at rest; 32+ characters. Losing it means reconnecting.
 * - DATABASE_URL: PostgreSQL. Without it state lives in memory (development only).
 * - POLL_SECONDS (120): the safety net behind webhooks.
 * - ALLOW_PRIVATE_HOSTS: only for a copy that must reach an on-premises Jira or Azure DevOps.
 * - ENTRA_CLIENT_ID, ENTRA_CLIENT_SECRET, ENTRA_TENANT: optional app for "Sign in with Entra ID".
 */
const port = Number(process.env.PORT ?? 4341);
const product = productFrom(process.env.PLUGIN_PRODUCT);
const manifest = await loadManifest(
  process.env.PLUGIN_ORIGIN ?? `http://localhost:${port}`,
  product,
);
const secret = process.env.PLUGIN_SECRET;
if (!secret) throw new Error('PLUGIN_SECRET is required');
const sealer = makeSealer(secret);
const allowPrivateHosts = process.env.ALLOW_PRIVATE_HOSTS === 'true';
const store: Store = process.env.DATABASE_URL
  ? await postgresStore(process.env.DATABASE_URL)
  : memoryStore();
const doFetch = guardedFetch(allowPrivateHosts);

const engine = new Engine({
  store,
  providerFor: (conn) => providerFor(conn, { sealer, fetch: doFetch, store }),
  crewhall: offlinePorts({ sealer }),
  onError: (err, syncId) => console.error('sync failed', syncId, err),
  async notify(installation: Installation, sync: Sync, code: string) {
    if (!installation.permissions.includes('notifications:write')) return;
    const client = createServerClient({
      apiUrl: installation.apiUrl,
      installationId: installation.id,
      secret: sealer.open(installation.secret),
    });
    await client.notify({
      userId: sync.ownerId,
      title: `${sync.boardName}: eşitleme durdu`,
      body:
        code === 'auth_failed'
          ? "Bağlantının token'ı artık geçmiyor. Bağlantıyı yenile."
          : 'Eklentinin arka plan izni kapalı. Eklenti sekmesinden yeniden izin ver.',
      url: pluginTabUrl({ installationId: installation.id, tab: 'main', placement: 'rail' }),
      threadKey: `sync-${sync.id}`,
    });
  },
});

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('./client.ts', import.meta.url))],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: true,
  write: false,
});

const entraClient = process.env.ENTRA_CLIENT_ID;
const { app } = createPlugin({
  product,
  manifest,
  store,
  sealer,
  fetch: doFetch,
  engine,
  allowPrivateHosts,
  clientJs: bundle.outputFiles[0]!.text,
  ...(entraClient
    ? {
        entraDefaults: {
          clientId: entraClient,
          tenant: process.env.ENTRA_TENANT || 'organizations',
          ...(process.env.ENTRA_CLIENT_SECRET
            ? { clientSecret: process.env.ENTRA_CLIENT_SECRET }
            : {}),
        },
      }
    : {}),
});

const pollMs = Math.max(30, Number(process.env.POLL_SECONDS ?? 120)) * 1000;
let polling = false;
setInterval(() => {
  if (polling) return;
  polling = true;
  void (async () => {
    try {
      for (const sync of await store.all<Sync>('sync')) {
        if (sync.enabled) await engine.request(sync.id, { full: true });
      }
    } catch (err) {
      console.error('poll failed', err);
    } finally {
      polling = false;
    }
  })();
}, pollMs);

serve({ fetch: app.fetch, port }, () => {
  console.log(`${product} plugin on ${manifest.origin} (port ${port})`);
});
