/**
 * Snapshots of the three-way sync. Keys are paths relative to the synced folder with "/"
 * separators ("Sunumlar/2026/plan.pdf"), on every OS.
 */

export type EntryKind = 'file' | 'folder';

export interface LocalEntry {
  kind: EntryKind;
  size: number;
  mtimeMs: number;
  /** The disk's identity of this file; survives a rename. Absent where the disk has none. */
  id?: string;
}

export interface RemoteEntry {
  kind: EntryKind;
  nodeId: string;
  size: number;
  /** Current version number of a file; null for folders. */
  version: number | null;
  updatedAt: string;
}

/** What both sides looked like after the last successful sync of a path. */
export interface BaseEntry {
  kind: EntryKind;
  nodeId: string;
  /** `localFingerprint` of the local copy then. */
  local: string;
  /** `remoteFingerprint` of the node then. */
  remote: string;
  /** `LocalEntry.id` then: finds this file again after a rename. Older bases do not have it. */
  localId?: string;
}

export type Snapshot<T> = Map<string, T>;

/** Size and whole-millisecond mtime: a file whose fingerprint moved has changed. */
export function localFingerprint(e: LocalEntry): string {
  return e.kind === 'folder' ? 'folder' : `${e.size}:${Math.floor(e.mtimeMs)}`;
}

/** Node id plus version: a new version, a replaced node or a re-created folder all change it. */
export function remoteFingerprint(e: RemoteEntry): string {
  return e.kind === 'folder' ? `folder:${e.nodeId}` : `${e.nodeId}:${e.version ?? e.updatedAt}`;
}

export type SyncAction =
  | { type: 'mkdirLocal'; path: string; nodeId: string }
  | { type: 'mkdirRemote'; path: string }
  | { type: 'download'; path: string; nodeId: string }
  /** `nodeId`: upload a new version of this file instead of a new file. */
  | { type: 'upload'; path: string; nodeId?: string }
  /** Renamed or moved here locally: the node follows, keeping its versions and shares. */
  | { type: 'moveRemote'; path: string; from: string; nodeId: string; kind: EntryKind }
  | { type: 'deleteLocal'; path: string; kind: EntryKind }
  | { type: 'deleteRemote'; path: string; nodeId: string; kind: EntryKind }
  /**
   * Both sides changed: the local item moves aside under a conflict name (it is uploaded as a
   * new item on the next pass) and the server's version takes the path.
   */
  | { type: 'conflict'; path: string; nodeId: string; remoteKind: EntryKind }
  /** Both sides created a file of the same size: download and compare before calling it a conflict. */
  | { type: 'compare'; path: string; nodeId: string }
  /** Both sides already agree (e.g. the same folder created on both): just record it. */
  | { type: 'adopt'; path: string }
  /** Gone on both sides: drop it from the base. */
  | { type: 'forget'; path: string };

export type SyncActionType = SyncAction['type'];

export interface SkippedItem {
  path: string;
  side: 'local' | 'remote';
  reason: string;
}
