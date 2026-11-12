import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { TestProject } from 'vitest/node';
import { runMigrations } from '@crewhall/db';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
    s3Endpoint: string;
  }
}

let postgres: StartedPostgreSqlContainer | undefined;
let seaweed: StartedTestContainer | undefined;

/**
 * One real Postgres 17 and one SeaweedFS S3 for the run (design doc 17 §3 "Test"),
 * migrated with the production migration files. TEST_DATABASE_URL / TEST_S3_ENDPOINT
 * skip the containers (e.g. CI services).
 */
export default async function setup(project: TestProject) {
  const [db, s3] = await Promise.all([
    process.env.TEST_DATABASE_URL
      ? Promise.resolve(process.env.TEST_DATABASE_URL)
      : new PostgreSqlContainer('postgres:17')
          .withDatabase('crewhall_test')
          .withUsername('crewhall')
          .withPassword('crewhall')
          // Test data lives in RAM: nothing piles up on Docker's virtual disk (the image's
          // VOLUME would leave an anonymous volume per run), and without fsync it is faster.
          // Never use these settings outside tests.
          .withTmpFs({ '/var/lib/postgresql/data': 'rw,size=2g' })
          .withCommand([
            'postgres',
            '-c',
            'fsync=off',
            '-c',
            'full_page_writes=off',
            '-c',
            'synchronous_commit=off',
          ])
          .start()
          .then((c) => {
            postgres = c;
            return c.getConnectionUri();
          }),
    process.env.TEST_S3_ENDPOINT
      ? Promise.resolve(process.env.TEST_S3_ENDPOINT)
      : new GenericContainer('chrislusf/seaweedfs:4.48')
          // Every test app writes to a bucket of its own, and SeaweedFS gives each bucket
          // (collection) its own volumes on the first write: 7 by default. With the slots it
          // derived from free space (16 GB / 64 MB = 256) writes failed with InternalError
          // ("topo failed to pick 1 from 0 node candidates") from about the 38th bucket on,
          // so whichever files ran late in a full run failed. One volume per bucket and a
          // fixed ceiling far above the ~120 test apps of a run keep every write possible;
          // volumes are sparse, so this costs no space.
          .withEnvironment({ WEED_MASTER_VOLUME_GROWTH_COPY_1: '1' })
          // No s3.config: the gateway accepts any credentials, enough for tests.
          .withCommand([
            'server',
            '-dir=/data',
            '-ip.bind=0.0.0.0',
            '-volume.max=1000',
            '-master.volumeSizeLimitMB=64',
            '-s3',
            '-s3.port=8333',
          ])
          // A size ceiling only: tmpfs uses RAM for written data.
          .withTmpFs({ '/data': 'rw,size=16g' })
          .withExposedPorts(8333)
          .withWaitStrategy(Wait.forListeningPorts())
          .withStartupTimeout(120_000)
          .start()
          .then((c) => {
            seaweed = c;
            return `http://${c.getHost()}:${c.getMappedPort(8333)}`;
          }),
  ]);
  await runMigrations(db);
  await waitForS3(s3);
  project.provide('databaseUrl', db);
  project.provide('s3Endpoint', s3);
  return async () => {
    await Promise.all([postgres?.stop(), seaweed?.stop()]);
  };
}

async function waitForS3(endpoint: string) {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(endpoint, { signal: AbortSignal.timeout(2000) });
      if (res.status < 500) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`S3 at ${endpoint} did not come up`);
}
