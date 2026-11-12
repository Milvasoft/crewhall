import { createDb } from '@crewhall/db';
import { loadEnv } from '../env';
import { createBoss, pgBossJobs } from '../jobs/queue';
import { createLogger } from '../logger';
import { collabConfig } from '../services/wiki/config';
import { createCollabServer } from './server';

/**
 * Collab process (doc 17 §3): Hocuspocus for page, card and drawing documents on COLLAB_PORT (default 3001).
 * Long-lived WebSocket connections stay off the api. The api applies migrations; compose
 * starts this after the api is healthy. Jobs it queues (page.snapshot) run in the worker.
 */
const env = loadEnv();
const logger = createLogger(env.LOG_LEVEL, env.NODE_ENV === 'development').child({
  service: 'collab',
});
const config = collabConfig(env);
const handle = createDb(env.DATABASE_URL, { max: 10 });
const boss = await createBoss(env.DATABASE_URL);
boss.on('error', (err) => logger.error({ err }, 'pg-boss error'));
const jobs = pgBossJobs(boss);

const collab = createCollabServer({ db: handle.db, env, logger, jobs }, { port: config.port });
await collab.listen();

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, 'collab shutting down');
  await collab.close();
  await jobs.stop();
  await handle.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
