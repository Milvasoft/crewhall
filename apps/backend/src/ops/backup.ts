import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { backupObjects, restoreObjects, type ObjectStore } from './objects';
import { checkPgTools, PgVersionMismatchError, schemaLevel, type PgTools } from './pg';
import { Manifest, newSnapshotId, sha256File, type BackupTrigger, type Repo } from './repo';
import { seal, unseal } from './secret';

export interface OpsDeps {
  databaseUrl: string;
  /** null when the install runs without S3 (files are then not part of the backup). */
  store: ObjectStore | null;
  pg: PgTools;
  repo: Repo;
  /** CREWHALL_VERSION of this code. */
  version: string;
  /** Folder with the SQL migrations this code ships (meta/_journal.json). */
  migrationsDir: string;
  log: (message: string) => void;
}

export interface BackupOptions {
  trigger: BackupTrigger;
  note?: string | null;
  /** The install's .env; stored only encrypted with `passphrase`. */
  configFile?: string | null;
  passphrase?: string | null;
}

/** Database dump, then the bucket, then the manifest; nothing is visible until complete. */
export async function createBackup(deps: OpsDeps, options: BackupOptions): Promise<Manifest> {
  const { repo, log } = deps;
  if (options.configFile && !options.passphrase) {
    throw new Error('the config is stored only encrypted: set CREWHALL_BACKUP_PASSPHRASE');
  }
  const unlock = await repo.lock();
  const started = Date.now();
  const id = newSnapshotId(new Date(started));
  const tmp = join(repo.snapshotsDir, `.tmp-${id}`);
  try {
    // Before anything is written: an older pg_dump than the server fails every dump.
    const tools = await checkPgTools(deps.pg, deps.databaseUrl);
    if (!tools.compatible) throw new PgVersionMismatchError(tools.client, tools.server);
    await mkdir(tmp, { recursive: true });
    log(`database dump (${id})`);
    const dump = join(tmp, 'db.dump');
    await deps.pg.dump(deps.databaseUrl, dump);
    const schema = await schemaLevel(deps.databaseUrl);

    let items: Manifest['objects']['items'] = [];
    if (deps.store) {
      log(`objects from bucket ${deps.store.bucket}`);
      const previous = (await repo.list())[0] ?? null;
      items = await backupObjects(deps.store, repo, previous);
    }
    if (options.configFile) {
      const plain = await readFile(options.configFile);
      await writeFile(join(tmp, 'config.enc'), seal(plain, options.passphrase!));
    }
    const manifest: Manifest = {
      format: 1,
      id,
      createdAt: new Date(started).toISOString(),
      trigger: options.trigger,
      note: options.note ?? null,
      version: deps.version,
      schema,
      database: { bytes: (await stat(dump)).size, sha256: await sha256File(dump) },
      objects: {
        bucket: deps.store?.bucket ?? null,
        count: items.length,
        bytes: items.reduce((n, o) => n + o.size, 0),
        items,
      },
      config: Boolean(options.configFile),
      durationMs: Date.now() - started,
    };
    await repo.commit(tmp, manifest);
    log(`backup ${id}: ${items.length} objects, ${manifest.durationMs} ms`);
    return manifest;
  } catch (e) {
    await rm(tmp, { recursive: true, force: true });
    throw e;
  } finally {
    await unlock();
  }
}

/** Migrations this code knows; a backup taken by a newer version is refused. */
export async function codeSchemaLevel(migrationsDir: string) {
  const journal = JSON.parse(
    await readFile(join(migrationsDir, 'meta', '_journal.json'), 'utf8'),
  ) as {
    entries: { when: number }[];
  };
  return {
    migrations: journal.entries.length,
    lastWhen: journal.entries.at(-1)?.when ?? null,
  };
}

/**
 * Puts the database and the bucket back to the snapshot. The app services must be stopped
 * (the `crewhall` script does that); the backup is checked before anything is touched.
 */
export async function restoreBackup(deps: OpsDeps, id: string, options: { force?: boolean } = {}) {
  const { repo, log } = deps;
  const manifest = await repo.readManifest(id);
  const code = await codeSchemaLevel(deps.migrationsDir);
  if (!options.force && manifest.schema.migrations > code.migrations) {
    throw new Error(
      `snapshot ${id} comes from a newer version (${manifest.version}, ${manifest.schema.migrations} migrations; this code knows ${code.migrations}). Restore it with that version.`,
    );
  }
  const dump = join(repo.snapshotDir(id), 'db.dump');
  if ((await sha256File(dump)) !== manifest.database.sha256) {
    throw new Error(`db.dump of ${id} is damaged (checksum mismatch)`);
  }
  for (const o of manifest.objects.items) {
    if (!(await repo.hasObject(o.sha256)))
      throw new Error(`object missing from the backup: ${o.key}`);
  }
  if (manifest.objects.items.length && !deps.store) {
    throw new Error('the snapshot has files but S3 is not configured');
  }

  const unlock = await repo.lock();
  try {
    log(`database restore (${id})`);
    await deps.pg.restore(deps.databaseUrl, dump);
    if (deps.store) {
      log(`objects into bucket ${deps.store.bucket}`);
      const r = await restoreObjects(deps.store, repo, manifest);
      log(`objects: ${r.uploaded} uploaded, ${r.deleted} removed`);
    }
    log(`restored ${id}`);
    return manifest;
  } finally {
    await unlock();
  }
}

/** The .env stored with a snapshot, decrypted. */
export async function readConfig(repo: Repo, id: string, passphrase: string) {
  const manifest = await repo.readManifest(id);
  if (!manifest.config) throw new Error(`snapshot ${id} has no config`);
  return unseal(await readFile(join(repo.snapshotDir(id), 'config.enc'), 'utf8'), passphrase);
}

/** Runs tar inside `cwd`: no drive letters in its arguments (GNU tar reads "C:" as a host). */
function tar(
  cwd: string,
  args: string[],
  io: { stdin?: NodeJS.ReadableStream; stdout?: NodeJS.WritableStream },
) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn('tar', args, {
      cwd,
      stdio: [io.stdin ? 'pipe' : 'ignore', io.stdout ? 'pipe' : 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-4000);
    });
    if (io.stdin && child.stdin) {
      // tar may stop reading early (bad archive); its exit code reports that.
      child.stdin.on('error', () => undefined);
      io.stdin.pipe(child.stdin);
    }
    if (io.stdout && child.stdout) child.stdout.pipe(io.stdout, { end: false });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`tar exited with ${code}: ${stderr.trim()}`)),
    );
  });
}

/** One snapshot with the objects it needs as a tar stream (moving to another server). */
export async function exportSnapshot(repo: Repo, id: string, out: NodeJS.WritableStream) {
  const manifest = await repo.readManifest(id);
  const shas = [...new Set(manifest.objects.items.map((o) => o.sha256))];
  const listName = `.export-${id}.txt`;
  const list = join(repo.root, listName);
  const lines = [`snapshots/${id}`, ...shas.map((sha) => `objects/${sha.slice(0, 2)}/${sha}`)];
  await writeFile(list, lines.join('\n') + '\n');
  try {
    await tar(repo.root, ['-cf', '-', '-T', listName], { stdout: out });
  } finally {
    await rm(list, { force: true });
  }
}

/** Unpacks an exported tar into the repository; returns the snapshots it brought. */
export async function importArchive(repo: Repo, input: NodeJS.ReadableStream) {
  await repo.init();
  const before = new Set((await repo.list()).map((m) => m.id));
  await tar(repo.root, ['-xf', '-'], { stdin: input });
  return (await repo.list()).filter((m) => !before.has(m.id)).map((m) => Manifest.parse(m));
}
