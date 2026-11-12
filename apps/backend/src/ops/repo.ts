import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * Backup repository on disk (CREWHALL_BACKUP_DIR, /backups in the image):
 *
 *   snapshots/<id>/manifest.json   what the snapshot holds (written last)
 *   snapshots/<id>/db.dump         pg_dump custom format
 *   snapshots/<id>/config.enc      optional: the install's .env, encrypted (secret.ts)
 *   objects/<aa>/<sha256>          S3 object contents, shared by every snapshot
 *
 * Objects are stored once by content, so nightly snapshots only add what changed. A
 * snapshot is built in snapshots/.tmp-<id> and renamed when complete.
 */

export const BackupTrigger = z.enum(['manual', 'nightly', 'update']);
export type BackupTrigger = z.infer<typeof BackupTrigger>;

export const ObjectEntry = z.object({
  key: z.string(),
  size: z.number().int(),
  etag: z.string().nullable(),
  contentType: z.string().nullable(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type ObjectEntry = z.infer<typeof ObjectEntry>;

export const Manifest = z.object({
  format: z.literal(1),
  id: z.string(),
  createdAt: z.string(),
  trigger: BackupTrigger,
  note: z.string().nullable(),
  /** CREWHALL_VERSION of the install that took it. */
  version: z.string(),
  /** Applied migrations: a backup from a newer schema is not restored by older code. */
  schema: z.object({ migrations: z.number().int(), lastWhen: z.number().nullable() }),
  database: z.object({ bytes: z.number().int(), sha256: z.string() }),
  objects: z.object({
    bucket: z.string().nullable(),
    count: z.number().int(),
    bytes: z.number(),
    items: z.array(ObjectEntry),
  }),
  config: z.boolean(),
  durationMs: z.number().int(),
});
export type Manifest = z.infer<typeof Manifest>;

/** Snapshot ids sort by time: 2026-10-22T03-00-00-123Z. */
export const newSnapshotId = (now = new Date()) => now.toISOString().replace(/[:.]/g, '-');

const SNAPSHOT_ID = /^[0-9TZ-]+$/;
const LOCK_STALE_MS = 6 * 60 * 60 * 1000;

export class BackupBusyError extends Error {
  constructor() {
    super('another backup or restore is running');
  }
}

export class Repo {
  constructor(readonly root: string) {}

  get snapshotsDir() {
    return join(this.root, 'snapshots');
  }

  snapshotDir(id: string) {
    if (!SNAPSHOT_ID.test(id)) throw new Error(`invalid snapshot id: ${id}`);
    return join(this.snapshotsDir, id);
  }

  objectPath(sha256: string) {
    return join(this.root, 'objects', sha256.slice(0, 2), sha256);
  }

  async init() {
    await mkdir(this.snapshotsDir, { recursive: true });
    await mkdir(join(this.root, 'objects', '.tmp'), { recursive: true });
  }

  async hasObject(sha256: string) {
    return stat(this.objectPath(sha256)).then(
      () => true,
      () => false,
    );
  }

  /** Moves a fully written temp file into the pool under its hash. */
  async adoptObject(tmpFile: string, sha256: string) {
    const target = this.objectPath(sha256);
    if (await this.hasObject(sha256)) {
      await rm(tmpFile, { force: true });
      return;
    }
    await mkdir(join(this.root, 'objects', sha256.slice(0, 2)), { recursive: true });
    await rename(tmpFile, target);
  }

  tmpObjectPath(name: string) {
    return join(this.root, 'objects', '.tmp', name);
  }

  async readManifest(id: string): Promise<Manifest> {
    const raw = await readFile(join(this.snapshotDir(id), 'manifest.json'), 'utf8').catch(() => {
      throw new Error(`snapshot not found: ${id}`);
    });
    return Manifest.parse(JSON.parse(raw));
  }

  /** Complete snapshots, newest first. */
  async list(): Promise<Manifest[]> {
    const names = await readdir(this.snapshotsDir).catch(() => [] as string[]);
    const out: Manifest[] = [];
    for (const name of names) {
      if (!SNAPSHOT_ID.test(name)) continue;
      try {
        out.push(await this.readManifest(name));
      } catch {
        // A folder without a valid manifest is not a snapshot.
      }
    }
    return out.sort((a, b) => b.id.localeCompare(a.id));
  }

  /** Writes the manifest into the temp folder and publishes the snapshot. */
  async commit(tmpDir: string, manifest: Manifest) {
    await writeFile(join(tmpDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    await rename(tmpDir, this.snapshotDir(manifest.id));
  }

  /** One backup or restore at a time per repository; a lock older than 6 hours is stale. */
  async lock(): Promise<() => Promise<void>> {
    await this.init();
    const file = join(this.root, '.lock');
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const handle = await open(file, 'wx');
        await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
        await handle.close();
        return () => rm(file, { force: true });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        const info = await stat(file).catch(() => null);
        if (info && Date.now() - info.mtimeMs < LOCK_STALE_MS) throw new BackupBusyError();
        await rm(file, { force: true });
      }
    }
    throw new BackupBusyError();
  }

  /**
   * Deletes snapshots beyond the newest `keep` among `triggers` (update backups are kept
   * unless named), then objects no snapshot refers to and abandoned temp files.
   */
  async prune(keep: number, triggers: BackupTrigger[] = ['manual', 'nightly']) {
    const all = await this.list();
    const doomed = all.filter((m) => triggers.includes(m.trigger)).slice(keep);
    for (const m of doomed) await rm(this.snapshotDir(m.id), { recursive: true, force: true });
    const removedObjects = await this.collectGarbage();
    return { snapshots: doomed.map((m) => m.id), objects: removedObjects };
  }

  async collectGarbage() {
    const live = new Set<string>();
    for (const m of await this.list()) for (const o of m.objects.items) live.add(o.sha256);
    let removed = 0;
    const objectsDir = join(this.root, 'objects');
    const day = Date.now() - 86_400_000;
    for (const prefix of await readdir(objectsDir).catch(() => [] as string[])) {
      const dir = join(objectsDir, prefix);
      if (prefix === '.tmp') {
        // Left by a crash; anything older than a day is not in use.
        for (const f of await readdir(dir)) {
          const s = await stat(join(dir, f)).catch(() => null);
          if (s && s.mtimeMs < day) await rm(join(dir, f), { force: true });
        }
        continue;
      }
      for (const sha of await readdir(dir).catch(() => [] as string[])) {
        if (!live.has(sha)) {
          await rm(join(dir, sha), { force: true });
          removed++;
        }
      }
    }
    for (const name of await readdir(this.snapshotsDir).catch(() => [] as string[])) {
      if (!name.startsWith('.tmp-')) continue;
      const s = await stat(join(this.snapshotsDir, name)).catch(() => null);
      if (s && s.mtimeMs < day)
        await rm(join(this.snapshotsDir, name), { recursive: true, force: true });
    }
    return removed;
  }
}

export async function sha256File(file: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}
