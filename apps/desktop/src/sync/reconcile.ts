import { depth, isWithin } from './names';
import {
  localFingerprint,
  remoteFingerprint,
  type BaseEntry,
  type EntryKind,
  type LocalEntry,
  type RemoteEntry,
  type Snapshot,
  type SyncAction,
} from './types';

export interface ReconcileInput {
  base: Snapshot<BaseEntry>;
  local: Snapshot<LocalEntry>;
  remote: Snapshot<RemoteEntry>;
  /** Local folders that could not be read: nothing at or under them is touched this pass. */
  frozen?: readonly string[];
  /** Local renames found by `planMoves`; `base` and `remote` already show them done. */
  moves?: readonly MoveAction[];
}

export type MoveAction = Extract<SyncAction, { type: 'moveRemote' }>;

export interface PlannedMoves {
  moves: MoveAction[];
  /** The base and the server as they will be once the moves are done. */
  base: Snapshot<BaseEntry>;
  remote: Snapshot<RemoteEntry>;
}

/** Moves the entries at or under `from` to `to` in a snapshot. */
export function rewritePaths<T>(snapshot: Snapshot<T>, from: string, to: string): void {
  for (const [path, value] of [...snapshot]) {
    if (!isWithin(path, from)) continue;
    snapshot.delete(path);
    snapshot.set(to + path.slice(from.length), value);
  }
}

/** A node the server moved: the same id at a new path, so the local copy follows it. */
export interface LocalMove {
  /** Its path in the base. */
  from: string;
  /** Where it is on this computer: `from`, or the name the person gave it here. */
  source: string;
  to: string;
  kind: EntryKind;
}

function relocate<T>(snapshot: Snapshot<T>, from: string, to: string, kind: EntryKind): void {
  if (kind === 'folder') return rewritePaths(snapshot, from, to);
  const entry = snapshot.get(from);
  if (entry === undefined) return;
  snapshot.delete(from);
  snapshot.set(to, entry);
}

/** The base and the local snapshot as they are once this move has been made. */
export function applyLocalMove(
  base: Snapshot<BaseEntry>,
  local: Snapshot<LocalEntry>,
  move: LocalMove,
): void {
  relocate(base, move.from, move.to, move.kind);
  if (move.source !== move.to) relocate(local, move.source, move.to, move.kind);
}

/**
 * Server renames and moves: a node of the base that now sits at another path. Without this they
 * look like a delete and a new file, so the copy here would be thrown away and downloaded again,
 * and an edit made here would no longer reach the same node.
 *
 * Runs in the returned order, each move seeing the ones before it. The comparison then runs on the
 * new paths, so an edit on either side is handled as usual.
 *
 * Not moved, so the normal comparison decides: an item deleted here (the server's copy comes back)
 * and a target that stays taken here, as with two names swapped on the server (both download).
 * Renamed differently on both sides: the server's name wins, and no copy is made.
 */
export function planLocalMoves({
  base,
  local,
  remote,
  frozen = [],
}: Omit<ReconcileInput, 'moves'>): LocalMove[] {
  const nextBase = new Map(base);
  const nextLocal = new Map(local);
  const isFrozen = (path: string) => frozen.some((f) => isWithin(path, f));

  const nodePaths = new Map<string, string>();
  const renamedHere = new Map<string, string>();
  const index = () => {
    nodePaths.clear();
    renamedHere.clear();
    for (const [path, b] of nextBase) nodePaths.set(b.nodeId, path);
    for (const [path, l] of nextLocal) if (l.id && !nextBase.has(path)) renamedHere.set(l.id, path);
  };
  index();

  const moves: LocalMove[] = [];
  // Shallow first: once a folder has moved, the items under it are where they should be.
  let waiting = [...remote]
    .filter(([to, r]) => nodePaths.has(r.nodeId) && nodePaths.get(r.nodeId) !== to)
    .sort(([a], [b]) => depth(a) - depth(b));
  // A chain frees its targets as it goes (a → b, b → c), so go round until nothing moves.
  for (let moved = true; moved;) {
    moved = false;
    const taken: typeof waiting = [];
    for (const item of waiting) {
      const [to, r] = item;
      const from = nodePaths.get(r.nodeId);
      if (from === undefined || from === to) continue;
      const b = nextBase.get(from)!;
      const source = nextLocal.has(from) ? from : b.localId && renamedHere.get(b.localId);
      if (!source || b.kind !== r.kind || nextLocal.get(source)!.kind !== r.kind) continue;
      if (isWithin(to, from) || [from, source, to].some(isFrozen)) continue;
      if (source !== to && nextLocal.has(to)) {
        taken.push(item);
        continue;
      }
      const move: LocalMove = { from, source, to, kind: r.kind };
      moves.push(move);
      applyLocalMove(nextBase, nextLocal, move);
      index();
      moved = true;
    }
    waiting = taken;
  }
  return moves;
}

/**
 * Local renames and moves: a path that is gone and a new path that is the same file. Without this
 * they look like a delete and a new file, which loses the node's versions and shares.
 *
 * The file's identity on disk decides, so a rename with an edit is found too. Where a side has no
 * identity (a base from an older version, a disk without file ids) only an exact match of size
 * and mtime counts, and only when it is the one candidate.
 *
 * A node that also changed on the server still moves: the normal comparison then runs on the new
 * path, so a remote edit downloads and edits on both sides are a conflict.
 */
export function planMoves({
  base,
  local,
  remote,
  frozen = [],
}: Omit<ReconcileInput, 'moves'>): PlannedMoves {
  const nextBase = new Map(base);
  const nextRemote = new Map(remote);
  const moves: MoveAction[] = [];
  const isFrozen = (path: string) => frozen.some((f) => isWithin(path, f));

  // Shallow first: once a folder has moved, the items under it are where they should be.
  const fresh = [...local.keys()].sort((a, b) => depth(a) - depth(b));
  for (const to of fresh) {
    if (nextBase.has(to) || nextRemote.has(to) || isFrozen(to)) continue;
    const entry = local.get(to)!;
    const from = findSource(entry, nextBase, local, nextRemote, isFrozen);
    if (!from) continue;
    const source = nextBase.get(from)!;
    moves.push({ type: 'moveRemote', path: to, from, nodeId: source.nodeId, kind: entry.kind });
    rewritePaths(nextBase, from, to);
    rewritePaths(nextRemote, from, to);
  }
  return { moves, base: nextBase, remote: nextRemote };
}

function findSource(
  entry: LocalEntry,
  base: Snapshot<BaseEntry>,
  local: Snapshot<LocalEntry>,
  remote: Snapshot<RemoteEntry>,
  isFrozen: (path: string) => boolean,
): string | null {
  const byFingerprint: string[] = [];
  for (const [path, b] of base) {
    if (b.kind !== entry.kind || local.has(path) || isFrozen(path)) continue;
    // Gone from the server too: nothing to keep, the file is simply new there.
    if (remote.get(path)?.nodeId !== b.nodeId) continue;
    if (entry.id && b.localId) {
      if (entry.id === b.localId) return path;
      continue;
    }
    if (entry.kind === 'file' && entry.size > 0 && b.local === localFingerprint(entry)) {
      byFingerprint.push(path);
    }
  }
  if (byFingerprint.length !== 1) return null;
  // The same match seen from the other side: another new file like it makes it a guess.
  const source = base.get(byFingerprint[0]!)!;
  const twins = [...local].filter(
    ([p, l]) =>
      !base.has(p) && !remote.has(p) && l.kind === 'file' && localFingerprint(l) === source.local,
  );
  return twins.length === 1 ? byFingerprint[0]! : null;
}

/**
 * Three-way comparison of the last synced state with both sides; returns what to do, in the
 * order the executor runs it. Pure: no I/O, so every rule is unit tested.
 *
 * - Changed on one side only: the change is copied to the other side (deletes included).
 * - Changed on both: deleted on both → forget; deleted on one → the other side wins; two
 *   folders → nothing to do; two files of equal size → compare contents; otherwise a
 *   conflict (both copies are kept, the server's under the original name).
 * - A folder is deleted on the other side only when nothing under it changed there.
 */
export function reconcile({
  base,
  local,
  remote,
  frozen = [],
  moves = [],
}: ReconcileInput): SyncAction[] {
  const paths = new Set<string>([...base.keys(), ...local.keys(), ...remote.keys()]);
  const byPath = new Map<string, SyncAction[]>();

  for (const path of paths) {
    if (frozen.some((f) => isWithin(path, f))) continue;
    const actions = decide(path, base.get(path), local.get(path), remote.get(path));
    if (actions.length > 0) byPath.set(path, actions);
  }

  // A conflict moves the local item aside; whatever was planned under it waits for the next pass.
  for (const [path, actions] of byPath) {
    if (actions[0]?.type !== 'conflict') continue;
    for (const other of byPath.keys()) {
      if (other !== path && isWithin(other, path)) byPath.delete(other);
    }
  }

  // Folder deletes: keep the folder when something under it must survive, else delete it
  // whole (one trash call) and drop the per-item deletes beneath it.
  const folderDeletes = [...byPath.values()]
    .flat()
    .filter(
      (a): a is Extract<SyncAction, { type: 'deleteLocal' | 'deleteRemote' }> =>
        (a.type === 'deleteLocal' || a.type === 'deleteRemote') && a.kind === 'folder',
    )
    .sort((a, b) => depth(b.path) - depth(a.path));
  for (const del of folderDeletes) {
    if (!byPath.has(del.path)) continue;
    // Something under it was not looked at this pass: the folder waits, it may hold that item.
    if (frozen.some((f) => f !== del.path && isWithin(f, del.path))) {
      byPath.delete(del.path);
      continue;
    }
    const beneath = [...byPath.entries()].filter(([p]) => p !== del.path && isWithin(p, del.path));
    const survives = beneath.some(([, acts]) =>
      acts.some((a) => a.type !== del.type && a.type !== 'forget'),
    );
    if (survives) {
      const keep: SyncAction =
        del.type === 'deleteRemote'
          ? { type: 'mkdirLocal', path: del.path, nodeId: del.nodeId }
          : { type: 'mkdirRemote', path: del.path };
      byPath.set(del.path, [keep]);
    } else {
      for (const [p] of beneath) byPath.delete(p);
    }
  }

  return [...byPath.values(), moves].flat().sort(compareActions);
}

function decide(
  path: string,
  b: BaseEntry | undefined,
  l: LocalEntry | undefined,
  r: RemoteEntry | undefined,
): SyncAction[] {
  const lc = !b ? l !== undefined : !l || l.kind !== b.kind || localFingerprint(l) !== b.local;
  const rc = !b ? r !== undefined : !r || r.kind !== b.kind || remoteFingerprint(r) !== b.remote;

  if (!lc && !rc) return [];

  // Different kinds at one path (a file became a folder or the other way round): keep both.
  if (l && r && l.kind !== r.kind) {
    return [{ type: 'conflict', path, nodeId: r.nodeId, remoteKind: r.kind }];
  }

  if (lc && !rc) {
    if (!l)
      return r ? [{ type: 'deleteRemote', path, nodeId: r.nodeId, kind: r.kind }] : [forget(path)];
    if (r) return l.kind === 'file' ? [{ type: 'upload', path, nodeId: r.nodeId }] : [];
    return [create(path, l)];
  }

  if (!lc && rc) {
    if (!r) return l ? [{ type: 'deleteLocal', path, kind: l.kind }] : [forget(path)];
    // A folder re-created under a new id needs only its id recorded.
    if (l) return r.kind === 'file' ? [fetch(path, r)] : [{ type: 'adopt', path }];
    return [fetch(path, r)];
  }

  // Changed on both sides.
  if (!l && !r) return [forget(path)];
  if (!l) return [fetch(path, r!)];
  if (!r) return [create(path, l)];
  if (l.kind === 'folder') return [{ type: 'adopt', path }];
  if (l.size === r.size) return [{ type: 'compare', path, nodeId: r.nodeId }];
  return [{ type: 'conflict', path, nodeId: r.nodeId, remoteKind: r.kind }];
}

function forget(path: string): SyncAction {
  return { type: 'forget', path };
}

function create(path: string, l: LocalEntry): SyncAction {
  return l.kind === 'folder' ? { type: 'mkdirRemote', path } : { type: 'upload', path };
}

function fetch(path: string, r: RemoteEntry): SyncAction {
  return r.kind === 'folder'
    ? { type: 'mkdirLocal', path, nodeId: r.nodeId }
    : { type: 'download', path, nodeId: r.nodeId };
}

/**
 * Executor order: conflicts first (they free their path), then folders top-down, then file
 * transfers, then deletes bottom-up, then bookkeeping.
 */
const PHASE: Record<SyncAction['type'], number> = {
  conflict: 0,
  mkdirLocal: 1,
  mkdirRemote: 1,
  moveRemote: 1,
  download: 2,
  upload: 2,
  compare: 2,
  deleteLocal: 3,
  deleteRemote: 3,
  adopt: 4,
  forget: 4,
};

function compareActions(a: SyncAction, b: SyncAction): number {
  const phase = PHASE[a.type] - PHASE[b.type];
  if (phase !== 0) return phase;
  const d = depth(a.path) - depth(b.path);
  if (d !== 0) return PHASE[a.type] === 3 ? -d : d;
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}
