import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { CreateBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { migrationsFolder, runMigrations } from '@crewhall/db';
import {
  createBackup,
  exportSnapshot,
  importArchive,
  readConfig,
  restoreBackup,
  type OpsDeps,
} from '../src/ops/backup';
import { s3ObjectStore, type ObjectStore } from '../src/ops/objects';
import {
  checkPgTools,
  dockerPgTools,
  localPgTools,
  majorOf,
  PgVersionMismatchError,
} from '../src/ops/pg';
import { Repo } from '../src/ops/repo';

/**
 * Backup and restore (roadmap 2) against the run's real Postgres and SeaweedFS: each case
 * works on its own databases and buckets, so the shared test database is untouched.
 */
// pg_dump / pg_restore may run in containers on a loaded machine: generous per-test time.
describe('crewhall backup and restore', { timeout: 300_000 }, () => {
  const baseUrl = inject('databaseUrl');
  const s3Endpoint = inject('s3Endpoint');
  const s3 = new S3Client({
    endpoint: s3Endpoint,
    region: 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    forcePathStyle: true,
  });
  const dbUrl = (name: string) => {
    const u = new URL(baseUrl);
    u.pathname = `/${name}`;
    return u.toString();
  };
  // The image has pg_dump; developer machines and CI may only have Docker.
  const pgTools =
    spawnSync('pg_dump', ['--version']).status === 0 ? localPgTools() : dockerPgTools();
  const dirs: string[] = [];

  async function sql(url: string, text: string, values: unknown[] = []) {
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    try {
      return (await c.query(text, values)).rows as Record<string, unknown>[];
    } finally {
      await c.end();
    }
  }

  async function freshDatabase(name: string) {
    await sql(baseUrl, `drop database if exists ${name} with (force)`);
    await sql(baseUrl, `create database ${name}`);
    return dbUrl(name);
  }

  async function bucket(name: string) {
    await s3.send(new CreateBucketCommand({ Bucket: name })).catch(() => undefined);
    return s3ObjectStore({
      endpoint: s3Endpoint,
      region: 'us-east-1',
      bucket: name,
      accessKeyId: 'test',
      secretAccessKey: 'test',
    });
  }

  const put = (b: string, key: string, body: string) =>
    s3.send(new PutObjectCommand({ Bucket: b, Key: key, Body: body, ContentType: 'text/plain' }));

  async function keys(store: ObjectStore) {
    const out: string[] = [];
    for await (const o of store.list()) out.push(o.key);
    return out.sort();
  }

  async function newRepo() {
    const dir = await mkdtemp(join(tmpdir(), 'crewhall-backup-'));
    dirs.push(dir);
    return new Repo(dir);
  }

  const deps = (url: string, store: ObjectStore, repo: Repo): OpsDeps => ({
    databaseUrl: url,
    store,
    pg: pgTools,
    repo,
    version: '1.4.0',
    migrationsDir: migrationsFolder,
    log: () => undefined,
  });

  let srcUrl: string;
  let src: ObjectStore;

  beforeAll(async () => {
    srcUrl = await freshDatabase('ops_src');
    await runMigrations(srcUrl);
    await sql(
      srcUrl,
      `insert into organizations (id, slug, name, branding, settings)
       values (gen_random_uuid(), 'yedek', 'Yedek AŞ', '{}', '{}')`,
    );
    src = await bucket('ops-src');
    await put('ops-src', 'blobs/aa/one', 'birinci dosya');
    await put('ops-src', 'blobs/bb/two', 'ikinci dosya');
  });
  afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  it('reads the tools version and refuses a pg_dump older than the server', async () => {
    expect(majorOf('pg_dump (PostgreSQL) 18.6')).toBe(18);
    expect(majorOf('pg_dump (PostgreSQL) 17.11 (Debian 17.11-1)')).toBe(17);
    expect(majorOf(null)).toBeNull();
    // The image's tools (18) dump the test server (17) and older ones.
    const real = await checkPgTools(pgTools, srcUrl);
    expect(real.compatible).toBe(true);
    expect(real.client).toBeGreaterThanOrEqual(18);

    const repo = await newRepo();
    const old = { ...pgTools, version: async () => real.server - 1 };
    const err = await createBackup(deps(srcUrl, src, repo), { trigger: 'manual', note: null }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeNull();
    const refused = await createBackup(
      { ...deps(srcUrl, src, repo), pg: old },
      { trigger: 'manual', note: null },
    ).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(PgVersionMismatchError);
    expect((refused as Error).message).toBe(
      `pg_dump ${real.server - 1} is older than the PostgreSQL ${real.server} server: install the ${real.server} client tools`,
    );
    // Nothing half-written: only the first snapshot is there.
    expect(await repo.list()).toHaveLength(1);
  });

  it('backs up the database and files, and reuses unchanged files', async () => {
    const repo = await newRepo();
    const d = deps(srcUrl, src, repo);
    const first = await createBackup(d, { trigger: 'manual', note: 'ilk' });
    expect(first.objects.count).toBe(2);
    expect(first.schema.migrations).toBeGreaterThan(10);
    expect(first.database.bytes).toBeGreaterThan(1000);

    // Second run: nothing changed, so nothing is downloaded again.
    let downloads = 0;
    const counting: ObjectStore = {
      ...src,
      list: () => src.list(),
      get: (key) => {
        downloads++;
        return src.get(key);
      },
    };
    const second = await createBackup({ ...d, store: counting }, { trigger: 'nightly' });
    expect(downloads).toBe(0);
    expect(second.objects.items.map((o) => o.sha256)).toEqual(
      first.objects.items.map((o) => o.sha256),
    );
    expect((await repo.list()).map((m) => m.id)).toEqual([second.id, first.id]);
  });

  it('restores the database and the bucket exactly, dropping what came later', async () => {
    const repo = await newRepo();
    const d = deps(srcUrl, src, repo);
    const snap = await createBackup(d, { trigger: 'update' });

    // After the backup: a new org, a table from a "newer migration", files changed.
    await sql(
      srcUrl,
      `insert into organizations (id, slug, name, branding, settings)
      values (gen_random_uuid(), 'sonra', 'Sonra', '{}', '{}')`,
    );
    await sql(srcUrl, 'create table public.from_newer_version (id int)');
    await put('ops-src', 'blobs/cc/three', 'sonradan');
    await src.delete(['blobs/aa/one']);

    await restoreBackup(d, snap.id);
    expect(
      (await sql(srcUrl, 'select slug from organizations order by slug')).map((r) => r.slug),
    ).toEqual(['yedek']);
    expect(await sql(srcUrl, `select to_regclass('public.from_newer_version') as t`)).toEqual([
      { t: null },
    ]);
    expect(await keys(src)).toEqual(['blobs/aa/one', 'blobs/bb/two']);
    const body = await (await src.get('blobs/aa/one')).body.toArray();
    expect(Buffer.concat(body).toString()).toBe('birinci dosya');
  });

  it('refuses a snapshot from a newer schema or with a damaged dump', async () => {
    const repo = await newRepo();
    const d = deps(srcUrl, src, repo);
    const snap = await createBackup(d, { trigger: 'manual' });
    const manifestFile = join(repo.snapshotDir(snap.id), 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8')) as typeof snap;
    await writeFile(
      manifestFile,
      JSON.stringify({ ...manifest, schema: { ...manifest.schema, migrations: 9999 } }),
    );
    await expect(restoreBackup(d, snap.id)).rejects.toThrow(/newer version/);

    await writeFile(manifestFile, JSON.stringify(manifest));
    await writeFile(join(repo.snapshotDir(snap.id), 'db.dump'), 'bozuk');
    await expect(restoreBackup(d, snap.id)).rejects.toThrow(/damaged/);
  });

  it('keeps the .env only encrypted', async () => {
    const repo = await newRepo();
    const d = deps(srcUrl, src, repo);
    const env = join(repo.root, 'install.env');
    await writeFile(env, 'AUTH_SECRET=gizli-anahtar\nPOSTGRES_PASSWORD=parola\n');
    await expect(createBackup(d, { trigger: 'manual', configFile: env })).rejects.toThrow(
      /PASSPHRASE/,
    );
    await expect(
      createBackup(d, { trigger: 'manual', configFile: env, passphrase: 'kisa' }),
    ).rejects.toThrow(/at least 12/);
    const snap = await createBackup(d, {
      trigger: 'manual',
      configFile: env,
      passphrase: 'uzun-bir-parola-123',
    });
    const sealed = await readFile(join(repo.snapshotDir(snap.id), 'config.enc'), 'utf8');
    expect(sealed).not.toContain('gizli-anahtar');
    expect((await readConfig(repo, snap.id, 'uzun-bir-parola-123')).toString()).toContain(
      'AUTH_SECRET=gizli-anahtar',
    );
    await expect(readConfig(repo, snap.id, 'yanlis-parola-000')).rejects.toThrow(
      /wrong passphrase/,
    );
  });

  it('prunes old snapshots and the files only they used, keeping update backups', async () => {
    const repo = await newRepo();
    const d = deps(srcUrl, src, repo);
    await put('ops-src', 'blobs/dd/temp', 'geçici');
    const oldest = await createBackup(d, { trigger: 'nightly' });
    await src.delete(['blobs/dd/temp']);
    const update = await createBackup(d, { trigger: 'update' });
    const newest = await createBackup(d, { trigger: 'nightly' });
    const temp = oldest.objects.items.find((o) => o.key === 'blobs/dd/temp')!;
    expect(await repo.hasObject(temp.sha256)).toBe(true);

    const r = await repo.prune(1);
    expect(r.snapshots).toEqual([oldest.id]);
    expect((await repo.list()).map((m) => m.id)).toEqual([newest.id, update.id]);
    expect(await repo.hasObject(temp.sha256)).toBe(false);
  });

  it('moves a snapshot to another server with export and import', async () => {
    const repo = await newRepo();
    const snap = await createBackup(deps(srcUrl, src, repo), { trigger: 'manual' });
    const tarFile = join(repo.root, 'tasima.tar');
    const out = new PassThrough();
    const chunks: Buffer[] = [];
    out.on('data', (c: Buffer) => chunks.push(c));
    await exportSnapshot(repo, snap.id, out);
    await writeFile(tarFile, Buffer.concat(chunks));

    // The new server: empty database, empty bucket, empty backup folder.
    const target = await newRepo();
    const input = new PassThrough();
    input.end(await readFile(tarFile));
    expect((await importArchive(target, input)).map((m) => m.id)).toEqual([snap.id]);
    const dstUrl = await freshDatabase('ops_dst');
    const dst = await bucket('ops-dst');
    await restoreBackup(deps(dstUrl, dst, target), snap.id);
    expect((await sql(dstUrl, 'select slug from organizations')).map((r) => r.slug)).toEqual([
      'yedek',
    ]);
    expect(await keys(dst)).toEqual(await keys(src));
  });
});
