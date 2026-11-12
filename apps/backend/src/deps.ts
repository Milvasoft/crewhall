import type { Db } from '@crewhall/db';
import type { Auth } from './auth/auth';
import type { Env } from './env';
import type { Logger } from './logger';
import type { Jobs } from './jobs/queue';
import type { Mailer } from './mail/mailer';
import type { Bus } from './realtime/bus';
import type { PresenceTracker } from './realtime/presence';
import type { Storage } from './storage/s3';

/** Everything a request handler or service needs; built once in index.ts (or per test). */
export interface Deps {
  env: Env;
  db: Db;
  logger: Logger;
  mailer: Mailer;
  auth: Auth;
  /** Token the setup wizard must present; null when not required (dev without SETUP_TOKEN). */
  setupToken: string | null;
  /** S3 store; null when S3_* is not configured (Drive endpoints then fail). */
  storage: Storage | null;
  /** Background jobs: pg-boss in production, inline in tests. */
  jobs: Jobs;
  /** Events to WebSocket clients (doc 17 §6). */
  bus: Bus;
  /** Who is connected, for presence, @here and push decisions. */
  presence: PresenceTracker;
}

export type BaseDeps = Omit<Deps, 'auth'>;
