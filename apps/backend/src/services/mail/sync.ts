import type { FetchQueryObject, ImapFlow, StatusObject } from 'imapflow';
import type { DbOrTx } from '@crewhall/db';
import { AppError } from '../../http/errors';
import {
  cachedFlags,
  cachedUids,
  clearFolder,
  countRows,
  dropRows,
  loadState,
  rowOf,
  saveState,
  setFlags,
  upsertRows,
  type CacheOwner,
  type FolderStateRow,
} from './cache';
import { isMissingFolder, lockFolder } from './folders';

/**
 * Folder sync (doc: kararlar.md "Posta önbelleği"). The cache follows the server by
 * UIDVALIDITY (start over when it changes), UIDNEXT (fetch only new messages) and, when the
 * server has CONDSTORE, HIGHESTMODSEQ (fetch only changed flags). Without CONDSTORE the flags
 * of old messages are re-read at most every FLAGS_EVERY_MS. Messages that vanished elsewhere
 * are noticed from the message count.
 */

export const SUMMARY_QUERY: FetchQueryObject = {
  uid: true,
  flags: true,
  envelope: true,
  bodyStructure: true,
  size: true,
  internalDate: true,
  headers: ['references'],
};

/** A folder this big or smaller is synced in the request that first needs it. */
export const INITIAL_SYNC_MAX = 2000;
const CHUNK = 500;
export const FLAGS_EVERY_MS = 60_000;

const running = new Map<string, Promise<unknown>>();

/** One sync per account and folder at a time (the request path and the background share it). */
export function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = running.get(key) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  running.set(key, next);
  // The caller gets the rejection; this copy only cleans up.
  next
    .finally(() => {
      if (running.get(key) === next) running.delete(key);
    })
    .catch(() => undefined);
  return next;
}

export interface SyncResult {
  /** The cache holds the whole folder now. */
  complete: boolean;
  /** Something changed (new, changed or vanished messages). */
  changed: boolean;
}

export interface SyncOptions {
  /** Sync a first-time folder of any size (background); otherwise only up to INITIAL_SYNC_MAX. */
  full?: boolean;
  /** Re-read every flag now (background refresh without CONDSTORE). */
  allFlags?: boolean;
  /** STATUS the caller already has (saves the round trip). */
  status?: StatusObject;
  /** Stops a long first sync between chunks (shutdown). */
  signal?: AbortSignal;
}

const STATUS_QUERY = { messages: true, uidNext: true, uidValidity: true, highestModseq: true };

interface Counts {
  uidValidity: number;
  uidNext: number;
  messages: number;
  modseq: bigint | null;
}

/**
 * STATUS rather than the SELECT response: a folder that stays selected on a pooled connection
 * keeps its old UIDNEXT in imapflow, while STATUS always asks the server.
 */
async function counts(c: ImapFlow, folder: string, given?: StatusObject): Promise<Counts> {
  let st: StatusObject | false | undefined = given;
  if (!st) {
    try {
      st = await c.status(folder, STATUS_QUERY);
    } catch (err) {
      if (isMissingFolder(err)) {
        throw new AppError('mail_folder_not_found');
      }
      throw err;
    }
  }
  if (!st) throw new AppError('mail_folder_not_found');
  return {
    uidValidity: Number(st.uidValidity ?? 0),
    uidNext: st.uidNext ?? 1,
    messages: st.messages ?? 0,
    modseq: st.highestModseq ?? null,
  };
}

/** Syncs `folder` on connection `c` (it selects the folder). */
export function syncFolder(
  db: DbOrTx,
  c: ImapFlow,
  owner: CacheOwner,
  folder: string,
  opts: SyncOptions = {},
): Promise<SyncResult> {
  return serialized(`${owner.accountId}\n${folder}`, () => run(db, c, owner, folder, opts));
}

async function run(
  db: DbOrTx,
  c: ImapFlow,
  owner: CacheOwner,
  folder: string,
  opts: SyncOptions,
): Promise<SyncResult> {
  const mb = await counts(c, folder, opts.status);
  const lock = await lockFolder(c, folder);
  try {
    const uidValidity = mb.uidValidity;
    const modseq = mb.modseq !== null ? String(mb.modseq) : null;
    let state = await loadState(db, owner, folder);
    if (state && state.uidValidity !== uidValidity) {
      await clearFolder(db, owner, folder);
      state = null;
    }
    if (!state || !state.complete) {
      if (mb.messages > INITIAL_SYNC_MAX && !opts.full) return { complete: false, changed: false };
      await initial(db, c, owner, folder, mb.messages, opts.signal);
      await saveState(db, owner, folder, {
        uidValidity,
        uidNext: mb.uidNext,
        modseq,
        complete: true,
        flagsSyncedAt: new Date(),
        syncedAt: new Date(),
      });
      return { complete: true, changed: true };
    }
    return { complete: true, changed: await incremental(db, c, owner, folder, state, mb, opts) };
  } finally {
    lock.release();
  }
}

/** Whole folder, newest messages first, 500 at a time (by sequence number). */
async function initial(
  db: DbOrTx,
  c: ImapFlow,
  owner: CacheOwner,
  folder: string,
  exists: number,
  signal?: AbortSignal,
) {
  for (let end = exists; end >= 1; end -= CHUNK) {
    signal?.throwIfAborted();
    const start = Math.max(1, end - CHUNK + 1);
    const rows = await c.fetchAll(`${start}:${end}`, SUMMARY_QUERY);
    await upsertRows(
      db,
      rows.map((m) => rowOf(owner, folder, m)),
    );
  }
}

async function incremental(
  db: DbOrTx,
  c: ImapFlow,
  owner: CacheOwner,
  folder: string,
  state: FolderStateRow,
  mb: Counts,
  opts: SyncOptions,
) {
  let changed = false;
  const known = state.uidNext;
  let uidNext = Math.max(mb.uidNext, known);

  // New messages: everything from the old UIDNEXT on ("*" may answer with an older message).
  if (mb.uidNext > known && mb.messages > 0) {
    const fresh = (await c.fetchAll(`${known}:*`, SUMMARY_QUERY, { uid: true })).filter(
      (m) => m.uid >= known,
    );
    if (fresh.length) {
      uidNext = Math.max(uidNext, ...fresh.map((m) => m.uid + 1));
      await upsertRows(
        db,
        fresh.map((m) => rowOf(owner, folder, m)),
      );
      changed = true;
    }
  }

  // Changed flags of old messages.
  const now = new Date();
  let flagsSyncedAt = state.flagsSyncedAt;
  let seenUids: Set<number> | null = null;
  if (known > 1) {
    const condstore = state.modseq !== null && mb.modseq !== null;
    if (condstore && BigInt(state.modseq!) < mb.modseq!) {
      const rows = await c.fetchAll(
        `1:${known - 1}`,
        { uid: true, flags: true },
        { uid: true, changedSince: BigInt(state.modseq!) },
      );
      changed = (await applyFlags(db, owner, folder, rows)) || changed;
    } else if (
      !condstore &&
      (opts.allFlags || !flagsSyncedAt || now.getTime() - flagsSyncedAt.getTime() > FLAGS_EVERY_MS)
    ) {
      const rows = await c.fetchAll(`1:${known - 1}`, { uid: true, flags: true }, { uid: true });
      changed = (await applyFlags(db, owner, folder, rows)) || changed;
      seenUids = new Set(rows.map((r) => r.uid));
      flagsSyncedAt = now;
    }
  }

  // Messages removed elsewhere: the count no longer matches.
  if ((await countRows(db, owner, folder)) !== mb.messages) {
    const present = seenUids ?? new Set((await c.fetchAll('1:*', { uid: true })).map((m) => m.uid));
    const cached = await cachedUids(db, owner, folder);
    const gone = cached.filter((uid) => !present.has(uid));
    if (gone.length) {
      await dropRows(db, owner, folder, gone);
      changed = true;
    }
  }

  await saveState(db, owner, folder, {
    uidValidity: state.uidValidity,
    uidNext,
    modseq: mb.modseq !== null ? String(mb.modseq) : null,
    complete: true,
    flagsSyncedAt,
    syncedAt: now,
  });
  return changed;
}

/** Writes flags that differ from the cache, grouped by their new value. */
async function applyFlags(
  db: DbOrTx,
  owner: CacheOwner,
  folder: string,
  rows: { uid: number; flags?: Set<string> | undefined }[],
) {
  if (rows.length === 0) return false;
  const cached = await cachedFlags(
    db,
    owner,
    folder,
    rows.map((r) => r.uid),
  );
  const groups = new Map<string, number[]>();
  for (const r of rows) {
    const flags = r.flags ?? new Set<string>();
    const key = `${+flags.has('\\Seen')}${+flags.has('\\Flagged')}${+flags.has('\\Answered')}`;
    const was = cached.get(r.uid);
    if (was === undefined || was === key) continue;
    groups.set(key, [...(groups.get(key) ?? []), r.uid]);
  }
  for (const [key, uids] of groups) {
    await setFlags(db, owner, folder, uids, {
      seen: key[0] === '1',
      flagged: key[1] === '1',
      answered: key[2] === '1',
    });
  }
  return groups.size > 0;
}
