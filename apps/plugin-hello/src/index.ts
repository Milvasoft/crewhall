import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { build } from 'esbuild';
import { createHelloPlugin, loadManifest } from './server';

/**
 * Runs the sample plugin: PORT (4331) and PLUGIN_ORIGIN, the public origin Crewhall frames and
 * calls (must match the manifest the marketplace signed).
 */
const port = Number(process.env.PORT ?? 4331);
const manifest = await loadManifest(process.env.PLUGIN_ORIGIN ?? `http://localhost:${port}`);
const bundle = await build({
  entryPoints: [fileURLToPath(new URL('./client.ts', import.meta.url))],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: true,
  write: false,
});
const { app } = createHelloPlugin({ manifest, clientJs: bundle.outputFiles[0]!.text });
serve({ fetch: app.fetch, port }, () => {
  console.log(`hello plugin on ${manifest.origin} (port ${port})`);
});
