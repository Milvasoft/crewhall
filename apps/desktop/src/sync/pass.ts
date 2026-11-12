import { randomBytes } from 'node:crypto';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { hashFile, isRealLink, scanLocal, statLocal } from './local';
import {
  PARTIAL_PREFIX,
  baseName,
  conflictName,
  isCaseInsensitive,
  isWithin,
  joinPath,
  parentOf,
  type SyncPlatform,
} from './names';
import {
  applyLocalMove,
  planLocalMoves,
  planMoves,
  reconcile,
  rewritePaths,
  type LocalMove,
} from './reconcile';
import { scanRemote, type RemoteDrive, type RemoteNode } from './remote';
import {
  localFingerprint,
  remoteFingerprint,
  type BaseEntry,
  type LocalEntry,
  type RemoteEntry,
  type SkippedItem,
  type Snapshot,
  type SyncAction,
} from './types';

/** Stops a pass before it changes anything; `code` is an i18n key under web.desktop.sync.errors. */
export class SyncError extends Error {
  constructor(
    readonly code: 'local_root_missing' | 'remote_root_missing' | 'mass_delete',
    readonly details: Record<string, number | string> = {},
  ) {
    super(code);
    this.name = 'SyncError';
  }
}

/**
 * How server items reach the disk when they are not downloaded copies: the virtual drive, where a
 * file shows up without its bytes and comes down when something reads it.
 */
export interface Materializer {
  placeFile(abs: string, r: RemoteEntry): Promise<void>;
  placeFolder(abs: string, r: RemoteEntry): Promise<void>;
  /** The server has a new version of what is here: the bytes go, the next read gets the new ones. */
  replaceFile(abs: string, r: RemoteEntry): Promise<void>;
  /** What is on disk now matches this node: an upload finished, or both sides were the same. */
  settle(abs: string, nodeId: string): Promise<void>;
  /** Was this placed for that node and left unchanged? Reading it must not download anything. */
  isCurrent(abs: string, nodeId: string): Promise<boolean>;
}

export interface PassOptions {
  /** Absolute path of the local folder. */
  root: string;
  spaceId: string;
  /** Synced Drive folder; null for the whole space. */
  folderId: string | null;
  drive: RemoteDrive;
  base: Snapshot<BaseEntry>;
  platform: SyncPlatform;
  /** Computer name in conflict copies. */
  device: string;
  /** Translated "conflicted copy". */
  conflictLabel: string;
  /** Moves a local file or folder to the OS trash (tests: deletes it). */
  trash: (abs: string) => Promise<void>;
  /** Allow a pass that deletes many items (the person confirmed it). */
  allowMassDelete?: boolean;
  materializer?: Materializer;
  /** Tells another provider's online-only files; without it every placeholder is left alone. */
  attributes?: (abs: string) => Promise<number>;
  /** Where the tree of the server is read from, when not by listing every folder on the server. */
  listing?: Pick<RemoteDrive, 'list'>;
  now?: () => Date;
  onProgress?: (done: number, total: number) => void;
}

export interface PassStats {
  uploaded: number;
  /** Local renames and moves carried to the server. */
  moved: number;
  /** Server renames and moves carried to this computer. */
  movedLocal: number;
  downloaded: number;
  deletedLocal: number;
  deletedRemote: number;
  conflicts: number;
}

export interface PassResult {
  base: Snapshot<BaseEntry>;
  stats: PassStats;
  skipped: SkippedItem[];
  errors: Array<{ path: string; action: SyncAction['type'] | 'moveLocal'; message: string }>;
  /** Conflict copies were made or a file changed meanwhile: run another pass to settle. */
  again: boolean;
}

/** Deletes beyond this many items (and this share of what is synced) need a confirmation. */
export const MASS_DELETE_MIN = 50;
export const MASS_DELETE_SHARE = 0.3;

/** One sync pass of a folder pair: scan both sides, reconcile with the base, apply. */
export async function runPass(o: PassOptions): Promise<PassResult> {
  const now = o.now ?? (() => new Date());
  if (!(await statLocal(o.root))?.kind) throw new SyncError('local_root_missing');
  if (o.folderId) {
    const root = await o.drive.getNode(o.folderId);
    if (!root || root.trashed || root.kind !== 'folder') throw new SyncError('remote_root_missing');
  }

  const remoteScan = await scanRemote(o.listing ?? o.drive, o.spaceId, o.folderId, o.platform);
  const localScan = await scanLocal(
    o.root,
    o.materializer ? { ownPlaceholders: true } : { attributes: o.attributes },
  );
  const scanned = isCaseInsensitive(o.platform)
    ? alignCase(localScan.entries, remoteScan.entries)
    : localScan.entries;
  const known = new Map(o.base);
  // Bases written before file ids, and items recorded without one, learn theirs here.
  for (const [path, b] of known) {
    const l = scanned.get(path);
    if (l?.id && b.localId !== l.id && localFingerprint(l) === b.local) {
      known.set(path, { ...b, localId: l.id });
    }
  }
  const abs = (path: string) => join(o.root, ...path.split('/'));
  const frozen = [...localScan.frozen];
  const errors: PassResult['errors'] = [];
  const { materializer } = o;

  /**
   * What is on disk now stands for this node, and a rename or an upload may have left it unmarked.
   * Should this fail, what stays is an ordinary file with the right content, which the next new
   * version turns back into a placeholder: no reason to fail the work that was done.
   */
  const settle = async (path: string, nodeId: string): Promise<void> => {
    await materializer?.settle(abs(path), nodeId).catch(() => undefined);
  };

  // Before anything is compared: what the server moved is then already where it belongs.
  const applied: LocalMove[] = [];
  let movedLocal = 0;
  for (const move of planLocalMoves({
    base: known,
    local: scanned,
    remote: remoteScan.entries,
    frozen,
  })) {
    try {
      if (frozen.some((f) => [move.from, move.source, move.to].some((p) => isWithin(p, f)))) {
        throw new Error('held back by an earlier move');
      }
      if (move.source !== move.to) {
        if (await statLocal(abs(move.to))) throw new Error('target already exists');
        await mkdir(dirname(abs(move.to)), { recursive: true });
        await rename(abs(move.source), abs(move.to));
        movedLocal++;
        await settle(move.to, remoteScan.entries.get(move.to)!.nodeId);
      } else if (
        !localScan.entries.has(move.to) &&
        move.from.toLowerCase() === move.to.toLowerCase()
      ) {
        // Only the case changed: the scan already reads it under the server's spelling.
        await rename(abs(move.from), abs(move.to));
        movedLocal++;
        await settle(move.to, remoteScan.entries.get(move.to)!.nodeId);
      }
      applied.push(move);
    } catch (err) {
      // Nothing here has moved: neither end may read as deleted until the next pass tries again.
      frozen.push(move.from, move.source, move.to);
      errors.push({
        path: move.to,
        action: 'moveLocal',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const settledBase = new Map(known);
  const local = new Map(scanned);
  for (const move of applied) applyLocalMove(settledBase, local, move);

  // The last synced state is gone, but the placeholders say what they are. Unknown, they would read
  // as created on both sides, and comparing them would download the whole drive.
  if (materializer) {
    for (const [path, l] of local) {
      const r = remoteScan.entries.get(path);
      if (settledBase.has(path) || !r || r.kind !== l.kind) continue;
      if (!(await materializer.isCurrent(abs(path), r.nodeId))) continue;
      const unchanged =
        r.kind === 'folder' ||
        (l.size === r.size && Math.floor(l.mtimeMs) === Date.parse(r.updatedAt));
      settledBase.set(path, {
        kind: l.kind,
        nodeId: r.nodeId,
        local: localFingerprint(l),
        remote: unchanged ? remoteFingerprint(r) : '',
        ...(l.id ? { localId: l.id } : {}),
      });
    }
  }

  const planned = planMoves({
    base: settledBase,
    local,
    remote: remoteScan.entries,
    frozen,
  });
  const { remote } = planned;
  const base = new Map(planned.base);

  const actions = reconcile({
    base,
    local,
    remote,
    frozen,
    moves: planned.moves,
  });

  const deletes = countDeletes(actions, base);
  if (!o.allowMassDelete && deletes >= MASS_DELETE_MIN && deletes > base.size * MASS_DELETE_SHARE) {
    throw new SyncError('mass_delete', { count: deletes });
  }

  /** Path → Drive folder id, for parents of new items. */
  const folderIds = new Map<string, string | null>([['', o.folderId]]);
  for (const [path, e] of remote) if (e.kind === 'folder') folderIds.set(path, e.nodeId);
  const parentIdOf = (path: string): string | null => {
    const parent = parentOf(path);
    const id = folderIds.get(parent);
    if (id === undefined) throw new Error(`parent folder missing: ${parent}`);
    return id;
  };

  const stats: PassStats = {
    uploaded: 0,
    moved: 0,
    movedLocal,
    downloaded: 0,
    deletedLocal: 0,
    deletedRemote: 0,
    conflicts: 0,
  };
  let again = false;

  const record = (path: string, l: LocalEntry, r: RemoteEntry | RemoteNode) => {
    const entry: RemoteEntry =
      'nodeId' in r
        ? r
        : {
            kind: r.kind === 'folder' ? 'folder' : 'file',
            nodeId: r.id,
            size: r.size,
            version: r.version,
            updatedAt: r.updatedAt,
          };
    base.set(path, {
      kind: l.kind,
      nodeId: entry.nodeId,
      local: localFingerprint(l),
      remote: remoteFingerprint(entry),
      ...(l.id ? { localId: l.id } : {}),
    });
  };
  const forgetWithin = (path: string) => {
    for (const p of [...base.keys()]) if (isWithin(p, path)) base.delete(p);
  };

  /** Downloads into a hidden temp file next to the target; returns its path. */
  const downloadTemp = async (path: string, nodeId: string): Promise<string> => {
    const tmp = join(dirname(abs(path)), `${PARTIAL_PREFIX}${randomBytes(6).toString('hex')}.part`);
    try {
      await o.drive.download(nodeId, tmp);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
    return tmp;
  };

  /** Renames the local item aside under a free conflict name. */
  const moveAside = async (path: string): Promise<void> => {
    const dir = dirname(abs(path));
    const names = new Set((await readdir(dir)).map((n) => n.toLowerCase()));
    const parent = parentOf(path);
    const target = conflictName(
      baseName(path),
      o.conflictLabel,
      o.device,
      now(),
      (n) => names.has(n.toLowerCase()) || remote.has(joinPath(parent, n)),
    );
    await rename(abs(path), join(dir, target));
    stats.conflicts++;
    again = true;
  };

  /** A folder's entry with its identity on disk, so a rename right after the sync is found. */
  const madeFolder = async (path: string): Promise<LocalEntry> =>
    (await statLocal(abs(path))) ?? { kind: 'folder', size: 0, mtimeMs: 0 };

  const makeFolder = async (path: string, r: RemoteEntry): Promise<void> => {
    if (materializer) await materializer.placeFolder(abs(path), r);
    else await mkdir(abs(path), { recursive: true });
    folderIds.set(path, r.nodeId);
    record(path, await madeFolder(path), r);
  };

  /** Without its bytes: nothing is downloaded until something reads the file. */
  const placeWithout = async (m: Materializer, path: string, r: RemoteEntry): Promise<void> => {
    const before = local.get(path);
    const current = await statLocal(abs(path));
    if (current && (!before || localFingerprint(current) !== localFingerprint(before))) {
      again = true;
      return;
    }
    if (current) await m.replaceFile(abs(path), r);
    else await m.placeFile(abs(path), r);
    const placed = await statLocal(abs(path));
    if (placed) record(path, placed, r);
    stats.downloaded++;
  };

  const fetchRemote = async (path: string, r: RemoteEntry): Promise<void> => {
    if (r.kind === 'folder') {
      await makeFolder(path, r);
      return;
    }
    if (materializer) {
      await placeWithout(materializer, path, r);
      return;
    }
    const tmp = await downloadTemp(path, r.nodeId);
    await placeDownload(path, tmp, r);
  };

  const placeDownload = async (path: string, tmp: string, r: RemoteEntry): Promise<void> => {
    // The local file changed while downloading: keep it; the next pass sees a conflict.
    const before = local.get(path);
    const current = await statLocal(abs(path));
    if (current && (!before || localFingerprint(current) !== localFingerprint(before))) {
      await rm(tmp, { force: true });
      again = true;
      return;
    }
    await rename(tmp, abs(path));
    await settle(path, r.nodeId);
    const placed = await statLocal(abs(path));
    if (placed) record(path, placed, r);
    stats.downloaded++;
  };

  /** Moves the server refused: what depends on them waits for the next pass. */
  const failedMoves: string[] = [];

  let done = 0;
  for (const action of actions) {
    o.onProgress?.(done, actions.length);
    const { path } = action;
    if (failedMoves.some((f) => isWithin(path, f))) {
      done++;
      continue;
    }
    try {
      switch (action.type) {
        case 'moveRemote': {
          const parent = parentOf(path);
          await o.drive.move(
            action.nodeId,
            parent === parentOf(action.from)
              ? null
              : { spaceId: o.spaceId, parentId: parentIdOf(path) },
            baseName(path) === baseName(action.from) ? null : baseName(path),
          );
          await settle(path, action.nodeId);
          stats.moved++;
          break;
        }
        case 'conflict': {
          await moveAside(path);
          forgetWithin(path);
          await fetchRemote(path, remote.get(path)!);
          break;
        }
        case 'mkdirLocal': {
          await makeFolder(path, remote.get(path)!);
          break;
        }
        case 'mkdirRemote': {
          const node = await o.drive.createFolder(o.spaceId, parentIdOf(path), baseName(path));
          folderIds.set(path, node.id);
          await settle(path, node.id);
          record(path, await madeFolder(path), node);
          break;
        }
        case 'download': {
          await fetchRemote(path, remote.get(path)!);
          break;
        }
        case 'upload': {
          const before = await statLocal(abs(path));
          if (!before || before.kind !== 'file') break;
          const node = await o.drive.upload(
            o.spaceId,
            parentIdOf(path),
            baseName(path),
            { path: abs(path), size: before.size },
            action.nodeId,
          );
          await settle(path, node.id);
          record(path, before, node);
          stats.uploaded++;
          break;
        }
        case 'compare': {
          const r = remote.get(path)!;
          const tmp = await downloadTemp(path, action.nodeId);
          if ((await hashFile(tmp)) === (await hashFile(abs(path)))) {
            await rm(tmp, { force: true });
            await settle(path, r.nodeId);
            record(path, local.get(path)!, r);
          } else {
            await moveAside(path);
            await placeDownload(path, tmp, r);
          }
          break;
        }
        case 'deleteLocal': {
          if (await statLocal(abs(path))) await o.trash(abs(path));
          forgetWithin(path);
          stats.deletedLocal++;
          break;
        }
        case 'deleteRemote': {
          await o.drive.trash(action.nodeId);
          forgetWithin(path);
          stats.deletedRemote++;
          break;
        }
        case 'adopt': {
          const l = local.get(path);
          const r = remote.get(path);
          if (l && r) {
            await settle(path, r.nodeId);
            record(path, l, r);
          }
          if (r?.kind === 'folder') folderIds.set(path, r.nodeId);
          break;
        }
        case 'forget': {
          forgetWithin(path);
          break;
        }
      }
    } catch (err) {
      // The node is still where it was: the base must say so, or the next pass would read the
      // new path as deleted on the server and remove the person's file.
      if (action.type === 'moveRemote') {
        rewritePaths(base, path, action.from);
        failedMoves.push(path);
      }
      errors.push({
        path,
        action: action.type,
        message: err instanceof Error ? err.message : String(err),
      });
    }
    done++;
  }
  o.onProgress?.(done, actions.length);

  await cleanPartials(o.root, !!o.materializer);
  return {
    base,
    stats,
    skipped: [...remoteScan.skipped, ...localScan.skipped],
    errors,
    again,
  };
}

/**
 * On case-insensitive disks "docs/Rapor.pdf" and "Docs/rapor.pdf" are the same file: use the
 * server's spelling for local paths so they pair up instead of looking like two new files.
 */
export function alignCase(
  local: Snapshot<LocalEntry>,
  remote: Snapshot<RemoteEntry>,
): Snapshot<LocalEntry> {
  const byLower = new Map<string, string>();
  for (const path of remote.keys()) byLower.set(path.toLowerCase(), path);
  const canonical = new Map<string, string>([['', '']]);
  const out: Snapshot<LocalEntry> = new Map();
  // Parents first, so a child is joined to its parent's server spelling.
  const paths = [...local.keys()].sort((a, b) => a.split('/').length - b.split('/').length);
  for (const path of paths) {
    const parent = canonical.get(parentOf(path)) ?? parentOf(path);
    const joined = joinPath(parent, baseName(path));
    const match = remote.has(joined) ? joined : (byLower.get(joined.toLowerCase()) ?? joined);
    canonical.set(path, match);
    out.set(match, local.get(path)!);
  }
  return out;
}

/** Items a pass would delete, counting what goes with a deleted folder. */
export function countDeletes(actions: SyncAction[], base: Snapshot<BaseEntry>): number {
  let count = 0;
  for (const a of actions) {
    if (a.type !== 'deleteLocal' && a.type !== 'deleteRemote') continue;
    if (a.kind === 'file') count++;
    else for (const p of base.keys()) if (isWithin(p, a.path)) count++;
  }
  return count;
}

/** Leftovers of interrupted downloads. */
async function cleanPartials(root: string, ownPlaceholders: boolean): Promise<void> {
  async function walk(dir: string): Promise<void> {
    let dirents;
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of dirents) {
      const p = join(dir, d.name);
      // Listing another provider's folder could make it fetch that list.
      const placeholder = ownPlaceholders && d.isSymbolicLink() && !(await isRealLink(p));
      if (d.isDirectory() || (placeholder && (await statLocal(p))?.kind === 'folder'))
        await walk(p);
      else if (d.name.startsWith(PARTIAL_PREFIX) && d.name.endsWith('.part')) {
        const s = await stat(p).catch(() => null);
        // Only old ones: a parallel pass of another pair never writes here, but be careful.
        if (s && Date.now() - s.mtimeMs > 60_000) await rm(p, { force: true });
      }
    }
  }
  await walk(root);
}
