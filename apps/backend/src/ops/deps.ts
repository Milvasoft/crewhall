import { migrationsFolder } from '@crewhall/db';
import { z } from 'zod';
import type { Env } from '../env';
import { PACKAGE_VERSION } from '../version';
import type { OpsDeps } from './backup';
import { s3ObjectStore } from './objects';
import { dockerPgTools, localPgTools } from './pg';
import { Repo } from './repo';

const OpsEnv = z.object({
  DATABASE_URL: z.string().min(1),
  CREWHALL_BACKUP_DIR: z.string().default('/backups'),
  CREWHALL_VERSION: z.string().default('dev'),
  /** `docker` runs pg_dump from the postgres image (hosts without the client). */
  CREWHALL_PG_TOOLS: z.enum(['local', 'docker']).default('local'),
  MIGRATIONS_DIR: z.string().optional(),
  S3_ENDPOINT: z.string().optional(),
  S3_BUCKET: z.string().default('crewhall'),
  S3_REGION: z.string().default('us-east-1'),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
});

export function opsDepsFromEnv(source: Record<string, string | undefined> = process.env): OpsDeps {
  const env = OpsEnv.parse(
    Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v !== '')),
  );
  return {
    databaseUrl: env.DATABASE_URL,
    store:
      env.S3_ENDPOINT && env.S3_ACCESS_KEY && env.S3_SECRET_KEY
        ? s3ObjectStore({
            endpoint: env.S3_ENDPOINT,
            region: env.S3_REGION,
            bucket: env.S3_BUCKET,
            accessKeyId: env.S3_ACCESS_KEY,
            secretAccessKey: env.S3_SECRET_KEY,
          })
        : null,
    pg: env.CREWHALL_PG_TOOLS === 'docker' ? dockerPgTools() : localPgTools(),
    repo: new Repo(env.CREWHALL_BACKUP_DIR),
    version: env.CREWHALL_VERSION,
    migrationsDir: env.MIGRATIONS_DIR ?? migrationsFolder,
    log: (m) => process.stderr.write(`crewhall: ${m}\n`),
  };
}

/** The same from the app's parsed env (worker jobs, admin endpoints). */
export function opsDepsFromAppEnv(env: Env, log: (m: string) => void = () => undefined): OpsDeps {
  const deps = opsDepsFromEnv({
    DATABASE_URL: env.DATABASE_URL,
    CREWHALL_BACKUP_DIR: env.CREWHALL_BACKUP_DIR,
    CREWHALL_PG_TOOLS: env.CREWHALL_PG_TOOLS,
    CREWHALL_VERSION: env.APP_VERSION ?? PACKAGE_VERSION,
    MIGRATIONS_DIR: env.MIGRATIONS_DIR,
    S3_ENDPOINT: env.S3_ENDPOINT,
    S3_BUCKET: env.S3_BUCKET,
    S3_REGION: env.S3_REGION,
    S3_ACCESS_KEY: env.S3_ACCESS_KEY,
    S3_SECRET_KEY: env.S3_SECRET_KEY,
  });
  return { ...deps, log };
}
