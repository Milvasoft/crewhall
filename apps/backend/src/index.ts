import { serve } from '@hono/node-server';
import { loadEnv } from './env';
import { build } from './server';
import { startDemoClock } from './services/demo';

const env = loadEnv();
const built = await build(env);
const { app, deps } = built;

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  deps.logger.info({ port: info.port, hub: env.HUB_URL }, 'crewhall backend listening');
});
// WebSocket gateway on /ws (doc 17 §6).
built.realtime.attach(server as import('node:http').Server);
// Live demo: hourly reset to the sample data (DEMO_MODE only).
const stopDemo = env.DEMO_MODE ? startDemoClock(deps) : () => undefined;

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  deps.logger.info({ signal }, 'shutting down');
  stopDemo();
  server.close();
  await built.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
