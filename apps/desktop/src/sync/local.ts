import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { lstat, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { isIgnored, joinPath, remoteNameProblem } from './names';
import type { LocalEntry, SkippedItem, Snapshot } from './types';

/**
 * File id plus creation time: a disk may hand a deleted file's number to a new file, which then
 * has another creation time. Large numbers are why the stats are read as bigints.
 */
function entryOf(s: BigIntStats): LocalEntry | null {
  const id = s.ino > 0n ? { id: `${s.ino}:${s.birthtimeMs}` } : {};
  if (s.isDirectory()) return { kind: 'folder', size: 0, mtimeMs: 0, ...id };
  if (s.isFile()) return { kind: 'file', size: Number(s.size), mtimeMs: Number(s.mtimeMs), ...id };
  return null;
}

const FILE_ATTRIBUTE_OFFLINE = 0x1000;
const FILE_ATTRIBUTE_RECALL_ON_OPEN = 0x40000;
const FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS = 0x400000;

/** Windows' marks of a file whose content is somewhere else: reading it would bring it here. */
export function isOnlineOnly(attributes: number): boolean {
  const mask =
    FILE_ATTRIBUTE_OFFLINE | FILE_ATTRIBUTE_RECALL_ON_OPEN | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS;
  return (attributes & mask) !== 0;
}

/**
 * A directory listing on Windows calls every reparse point a link, also a cloud file's placeholder
 * (ours, or another provider's such as OneDrive). Only a closer look tells which it really is.
 */
export async function isRealLink(abs: string): Promise<boolean> {
  const s = await lstat(abs).catch(() => null);
  return !s || s.isSymbolicLink();
}

export interface ScanOptions {
  /** This folder is the virtual drive: the placeholders in it are its own. */
  ownPlaceholders?: boolean;
  /** Reads a file's attributes without opening it (Windows, with the add-on). */
  attributes?: (abs: string) => Promise<number>;
}

export interface LocalScan {
  entries: Snapshot<LocalEntry>;
  /** Folders (or files) that could not be read; the pass leaves them alone. */
  frozen: string[];
  skipped: SkippedItem[];
}

/** Walks the synced folder. Links, ignored and un-uploadable names are left out. */
export async function scanLocal(root: string, options: ScanOptions = {}): Promise<LocalScan> {
  const entries: Snapshot<LocalEntry> = new Map();
  const frozen: string[] = [];
  const skipped: SkippedItem[] = [];

  async function walk(rel: string): Promise<void> {
    let dirents;
    try {
      dirents = await readdir(join(root, rel), { withFileTypes: true });
    } catch {
      frozen.push(rel);
      return;
    }
    for (const d of dirents) {
      if (isIgnored(d.name)) continue;
      const path = joinPath(rel, d.name);
      const link = d.isSymbolicLink();
      if (link && (await isRealLink(join(root, path)))) {
        skipped.push({ path, side: 'local', reason: 'symlink' });
        continue;
      }
      if (!options.ownPlaceholders) {
        // Another provider's placeholder (OneDrive): syncing it would pull that person's cloud onto
        // this disk and into Crewhall unasked. Every entry is asked, because the listing does not
        // tell: Electron sees a placeholder as a plain file, Node as a link. Frozen, not just left
        // out: a file synced earlier and then freed up by that provider has not been deleted.
        const attributes = await options.attributes?.(join(root, path)).catch(() => null);
        const unknown = attributes === undefined || attributes === null;
        if (unknown ? link : isOnlineOnly(attributes)) {
          skipped.push({ path, side: 'local', reason: 'online_only' });
          frozen.push(path);
          continue;
        }
      }
      const problem = remoteNameProblem(d.name);
      if (problem) {
        skipped.push({ path, side: 'local', reason: problem });
        continue;
      }
      if (link || d.isDirectory() || d.isFile()) {
        const entry = await statLocal(join(root, path));
        if (!entry) {
          frozen.push(path);
          continue;
        }
        entries.set(path, entry);
        if (entry.kind === 'folder') await walk(path);
      }
    }
  }

  await walk('');
  // The root itself is never an entry.
  return { entries, frozen: frozen.filter((f) => f !== ''), skipped };
}

export async function statLocal(abs: string): Promise<LocalEntry | null> {
  try {
    return entryOf(await stat(abs, { bigint: true }));
  } catch {
    return null;
  }
}

export function hashFile(abs: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(abs)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}
