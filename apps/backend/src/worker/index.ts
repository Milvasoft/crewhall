import { createDb } from '@crewhall/db';
import { loadEnv } from '../env';
import { createBoss, pgBossJobs } from '../jobs/queue';
import { createLogger } from '../logger';
import { createDisabledMailer, createSmtpMailer } from '../mail/mailer';
import { createDeliveryMailer } from '../services/delivery/mailer';
import { configureOutbound, outboundPolicy } from '../net/outbound';
import { notifyBus } from '../realtime/bus';
import { createStorage } from '../storage/s3';
import { pageNotifier, setPageNotifier } from '../services/wiki/notify';
import { startWorker } from './run';

/**
 * Job runner process (doc 17 §3): blob.process, preview, trash.purge, quota.reconcile and
 * the link health loop. The api applies migrations; compose starts this after the api is
 * healthy.
 */
const env = loadEnv();
configureOutbound(outboundPolicy(env));
const logger = createLogger(env.LOG_LEVEL, env.NODE_ENV === 'development');
const handle = createDb(env.DATABASE_URL, { max: 5 });
handle.pool.on('error', (err) => logger.warn({ err }, 'postgres connection lost'));
const storage = createStorage(env);
const boss = await createBoss(env.DATABASE_URL);
boss.on('error', (err) => logger.error({ err }, 'pg-boss error'));
const jobs = pgBossJobs(boss);
const mailer = createDeliveryMailer({
  base: env.SMTP_URL
    ? createSmtpMailer(env.SMTP_URL, env.MAIL_FROM, logger)
    : createDisabledMailer(logger),
  db: handle.db,
  env,
  logger,
});
// Events reach the api's WebSocket clients through Postgres NOTIFY.
const bus = notifyBus(handle.pool, logger);
// Page mentions found by the page.snapshot job go to the notification centre.
setPageNotifier(pageNotifier({ db: handle.db, bus, jobs, logger }));
const worker = await startWorker(boss, {
  db: handle.db,
  storage,
  logger,
  jobs,
  env,
  mailer,
  bus,
});
logger.info('crewhall worker started');

async function shutdown(signal: string) {
  logger.info({ signal }, 'worker shutting down');
  await worker.stop();
  await jobs.stop();
  await handle.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
