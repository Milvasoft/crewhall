import type { PairStatus } from '../sync/engine';

/** Tells the app to take the virtual drive off this computer and exit: the uninstaller runs it. */
export const REMOVE_DRIVE_FLAG = '--remove-virtual-drive';

/** What the server must offer: the tree of the drive is kept from its change feed. */
export const DRIVE_CAPABILITY = 'drive.changes';

/** Smaller downloads are over before a progress line could be read. */
export const SHOW_FETCH_FROM_BYTES = 20 * 1024 * 1024;

export type DriveProblem = 'overlap' | 'notEmpty' | 'failed';

export interface DriveFetchView {
  path: string;
  done: number;
  total: number;
}

export interface DriveSpaceView {
  id: string;
  name: string;
  status: PairStatus | null;
}

export interface VirtualDriveView {
  enabled: boolean;
  root: string;
  state: 'off' | 'starting' | 'running' | 'error';
  /** Why it could not start; a key under desktop.sync.errors. */
  error: { code: 'signed_out' | 'failed'; details: Record<string, string> } | null;
  spaces: DriveSpaceView[];
  /** Large files coming down right now. */
  fetches: DriveFetchView[];
}

/** Is `a` the same folder as `b` or inside it (case-insensitive where the disk is)? */
export function isSameOrInside(a: string, b: string, platform: string): boolean {
  const norm = (p: string) => {
    const path = p.replace(/\\/g, '/').replace(/\/+$/, '');
    return platform === 'linux' ? path : path.toLowerCase();
  };
  const [child, parent] = [norm(a), norm(b)];
  return child === parent || child.startsWith(`${parent}/`);
}

/** Either folder holding the other: they must not share files, or two syncs fight over them. */
export function foldersOverlap(a: string, b: string, platform: string): boolean {
  return isSameOrInside(a, b, platform) || isSameOrInside(b, a, platform);
}

/** The worst state of the spaces, for one badge. */
export function overallState(statuses: readonly PairStatus[]): PairStatus['state'] {
  for (const state of ['error', 'confirm', 'syncing'] as const) {
    if (statuses.some((s) => s.state === state)) return state;
  }
  return 'idle';
}

/** Identifies the sync root for this server, in the characters Windows allows in its id. */
export function driveAccount(hash: (text: string) => string, origin: string): string {
  return hash(origin).slice(0, 16);
}
