import { randomBytes } from 'node:crypto';
import { createDb, runMigrations, type DbHandle } from '@crewhall/db';
import { createApp } from './app';
import { createAuth } from './auth/auth';
import type { BaseDeps, Deps } from './deps';
import type { Env } from './env';
import { setDemoMode } from './services/demo-flag';
import { createLogger, type Logger } from './logger';
import { createDisabledMailer, createSmtpMailer, type Mailer } from './mail/mailer';
import { createDeliveryMailer } from './services/delivery/mailer';
import { configureOutbound, outboundPolicy } from './net/outbound';
import { runJob, type JobDeps } from './jobs/handlers';
import { createBoss, inlineJobs, pgBossJobs, type Jobs } from './jobs/queue';
import { primaryOrg } from './services/brand';
import { createStorage } from './storage/s3';
import { startWorker, type WorkerHandle } from './worker/run';
import { createRealtime, type Realtime } from './realtime';
import { gatewayHooks } from './services/chat/gateway-hooks';
import { flushActivity } from './services/stats/activity';
import { closeAllMailConnections } from './services/mail/imap';

export interface Built {
  deps: Deps;
  app: ReturnType<typeof createApp>;
  handle: DbHandle;
  /** WebSocket gateway, bus and presence; index.ts attaches it to the http server. */
  realtime: Realtime;
  /** Stops the job queue (and in-process worker) and closes the pool. */
  close(): Promise<void>;
}

export interface BuildOptions {
  logger?: Logger;
  mailer?: Mailer;
  /** 'inline' runs jobs right away in this process (tests); default is pg-boss. */
  jobs?: 'inline' | 'queue';
}

/** Wires env → db, mailer, auth and the Hono app. Shared by the server, seed and tests. */
export async function build(env: Env, options: BuildOptions = {}): Promise<Built> {
  const logger = options.logger ?? createLogger(env.LOG_LEVEL, env.NODE_ENV === 'development');
  setDemoMode(env.DEMO_MODE);
  configureOutbound(outboundPolicy(env));
  if (env.MIGRATE_ON_START) {
    await runMigrations(env.DATABASE_URL, { folder: env.MIGRATIONS_DIR });
    logger.info('migrations applied');
  }
  const handle = createDb(env.DATABASE_URL);
  // An idle connection dropped by Postgres (restart, failover) must not crash the process;
  // the pool reconnects on the next query.
  handle.pool.on('error', (err) => logger.warn({ err }, 'postgres connection lost'));
  // Each org may send through its own SMTP or Notifike (services/delivery); the server's SMTP
  // is the default.
  const mailer = createDeliveryMailer({
    base:
      options.mailer ??
      (env.SMTP_URL
        ? createSmtpMailer(env.SMTP_URL, env.MAIL_FROM, logger)
        : createDisabledMailer(logger)),
    db: handle.db,
    env,
    logger,
  });

  let setupToken: string | null = env.SETUP_TOKEN ?? null;
  if (!setupToken && env.NODE_ENV === 'production') setupToken = randomBytes(12).toString('hex');

  const storage = createStorage(env);
  if (storage) {
    await storage.ensureBucket().catch((err) => logger.warn({ err }, 'S3 bucket check failed'));
  } else {
    logger.warn('S3 is not configured; Drive uploads and downloads are unavailable');
  }

  // Jobs: inline in tests; otherwise pg-boss, with the handlers also running here when
  // WORKER_IN_PROCESS is on (default in development, where no separate worker runs).
  let jobs: Jobs;
  let boss: Awaited<ReturnType<typeof createBoss>> | null = null;
  let worker: WorkerHandle | null = null;
  const lazy: { deps?: Deps } = {};
  if ((options.jobs ?? (env.NODE_ENV === 'test' ? 'inline' : 'queue')) === 'inline') {
    jobs = inlineJobs(
      (name, data) => runJob(jobDeps(lazy), name, data),
      (err, name) => logger.error({ err, job: name }, 'inline job failed'),
    );
  } else {
    boss = await createBoss(env.DATABASE_URL);
    // pg-boss re-emits pool errors; unhandled they would end the process.
    boss.on('error', (err) => logger.error({ err }, 'pg-boss error'));
    jobs = pgBossJobs(boss);
  }

  const realtime = await createRealtime({
    handle,
    logger,
    hooks: gatewayHooks(handle.db),
    // A separate worker process publishes through NOTIFY (doc 17 §6).
    listen: env.NODE_ENV !== 'test',
  });
  const base: BaseDeps = {
    env,
    db: handle.db,
    logger,
    mailer,
    setupToken,
    storage,
    jobs,
    bus: realtime.bus,
    presence: realtime.presence,
  };
  const deps: Deps = { ...base, auth: createAuth(base) };
  lazy.deps = deps;
  if (boss && (env.WORKER_IN_PROCESS ?? env.NODE_ENV === 'development')) {
    worker = await startWorker(boss, jobDeps(lazy));
    logger.info('job worker running in the api process');
  }

  if (!(await primaryOrg(handle.db))) {
    if (setupToken) {
      // The wizard asks for this (design 1.10); only the server operator can read it.
      logger.warn({ setupToken }, `setup required: open ${env.HUB_URL} and enter the setup token`);
    } else {
      logger.warn('setup required; no setup token needed in development');
    }
  }
  return {
    deps,
    app: createApp(deps),
    handle,
    realtime,
    async close() {
      // Mail watchers write to the database from IDLE events: stop them before the pool ends.
      await closeAllMailConnections();
      await realtime.close();
      await worker?.stop();
      await jobs.stop();
      await flushActivity(handle.db);
      await handle.close();
    },
  };
}

function jobDeps(lazy: { deps?: Deps }): JobDeps {
  const deps = lazy.deps;
  if (!deps) throw new Error('jobs used before the server was built');
  return {
    db: deps.db,
    storage: deps.storage,
    logger: deps.logger,
    jobs: deps.jobs,
    env: deps.env,
    mailer: deps.mailer,
    bus: deps.bus,
  };
}
