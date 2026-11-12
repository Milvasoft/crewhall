import { ImapFlow } from 'imapflow';
import type { Logger } from '../../logger';
import { userTopic, type Bus } from '../../realtime/bus';
import type { DbOrTx } from '@crewhall/db';
import type { MailContext } from './accounts';
import { bodyKey, fetchBodies } from './body';
import { rowsByUids, setFlags, type CacheOwner } from './cache';
import { forgetFolders, lockFolder } from './folders';
import { imapAddress, imapOptions, isAuthError, onCloseAll, withImap } from './imap';
import { syncFolder, type SyncOptions } from './sync';

/**
 * The background side of a mailbox while its owner uses it: a second IMAP connection that sits
 * in IDLE on INBOX (new mail and other devices' changes arrive at once) and runs the syncs the
 * request path should not wait for: a large folder's first sync, flag refreshes, freshness
 * checks a request gave up waiting for (`inBudget`), and the bodies of the newest messages a
 * list shows (prefetched, so opening one needs no IMAP). Changes go to the user's WebSocket as
 * `mail.changed`. It closes LIVE_IDLE_MS after the last request.
 */

export interface LiveDeps {
  db: DbOrTx;
  logger: Logger;
  bus?: Bus | undefined;
  /**
   * A shared inbox: who hears about a change (its space's members, conversations rebuilt)
   * instead of the account owner's `mail.changed`.
   */
  onChanged?: ((folder: string) => Promise<void>) | undefined;
}

const LIVE_IDLE_MS = 5 * 60_000;
const DEBOUNCE_MS = 300;
/** A folder read from the cache is checked against the server at most this often. */
const CHECK_EVERY_MS = 5_000;
/** Newest messages of a list whose bodies are fetched ahead. */
export const PREFETCH_BODIES = 10;
/**
 * Longest a read waits for the mail server before it answers from Crewhall's cache (a cold
 * connection, a slow server); what it waited for finishes in the background.
 */
export const FRESH_BUDGET_MS = 150;

/** Background work a request asks for (all optional). */
export interface LiveWork {
  /** Sync this folder (`opts`: first sync of any size, all flags). */
  sync?: string;
  opts?: SyncOptions;
  /** The folder was answered from the cache: see whether the server moved on. */
  check?: string;
  /** Fetch these bodies ahead (their headers are cached). */
  prefetch?: { folder: string; uidValidity: number; uids: number[] };
}

interface Live {
  owner: CacheOwner;
  userId: string;
  ctx: MailContext;
  deps: LiveDeps;
  client: ImapFlow | null;
  connecting: Promise<ImapFlow | null> | null;
  lastUsed: number;
  queue: Map<string, SyncOptions>;
  /** Last freshness check per folder. */
  checked: Map<string, number>;
  prefetch: Map<string, { uidValidity: number; uids: Set<number> }>;
  draining: Promise<void> | null;
  timer: NodeJS.Timeout | null;
  closed: boolean;
  /** Aborts a running sync when the watcher stops (shutdown, account removed). */
  abort: AbortController;
  /** Database writes started by IDLE events; awaited before the watcher counts as stopped. */
  writes: Set<Promise<unknown>>;
}

const lives = new Map<string, Live>();

const sweeper = setInterval(() => {
  for (const live of lives.values()) {
    if (Date.now() - live.lastUsed > LIVE_IDLE_MS) void stop(live);
  }
}, 30_000);
sweeper.unref();

/** Longest a stop waits for a running sync or write before it gives up on them. */
const STOP_WAIT_MS = 5_000;

const settled = (promises: Iterable<Promise<unknown> | null>, ms: number) =>
  Promise.race([
    Promise.allSettled([...promises].filter(Boolean)),
    new Promise((r) => setTimeout(r, ms).unref()),
  ]);

/**
 * Stops one watcher for good: no new work is taken, a running sync is aborted, the connection
 * closes, and what was already writing to the database finishes before this resolves. After
 * it, the watcher never touches the database again (safe to end the pool).
 */
async function stop(live: Live) {
  live.closed = true;
  if (live.timer) clearTimeout(live.timer);
  live.timer = null;
  live.queue.clear();
  live.prefetch.clear();
  live.abort.abort();
  if (lives.get(live.owner.accountId) === live) lives.delete(live.owner.accountId);
  const c = live.client;
  live.client = null;
  // Closing the socket ends a FETCH in flight at once; the sync then stops at its next step.
  c?.close();
  await settled([live.connecting, live.draining, ...live.writes], STOP_WAIT_MS);
}

export async function stopAllLive() {
  await Promise.all([...lives.values()].map(stop));
}
onCloseAll(async (accountId) => {
  if (accountId === undefined) return stopAllLive();
  const live = lives.get(accountId);
  if (live) await stop(live);
});

/** Tests: watchers still running. */
export const liveCount = () => lives.size;

/** Runs an IDLE-triggered write unless the watcher stopped; stop() waits for it. */
function write(live: Live, fn: () => Promise<unknown>) {
  if (live.closed) return;
  const p = fn()
    .catch((err: unknown) => live.deps.logger.debug({ err }, 'mail live write failed'))
    .finally(() => live.writes.delete(p));
  live.writes.add(p);
}

/** Tells the user's clients; `folder` '' = only the folder list changed. */
function publish(live: Live, folder: string) {
  if (folder) forgetFolders(live.owner.accountId);
  const onChanged = live.deps.onChanged;
  if (onChanged) write(live, () => onChanged(folder));
  else live.deps.bus?.publish(userTopic(live.userId), { type: 'mail.changed', folder });
}

/**
 * IMAP work a request does not wait for (marking a message read that was answered from the
 * cache), on the pooled connection; stop() waits for it like for the watcher's own writes.
 */
export function later(deps: LiveDeps, ctx: MailContext, fn: (c: ImapFlow) => Promise<unknown>) {
  const live = touchLive(deps, ctx);
  write(live, () => withImap(deps.db, deps.logger, ctx.imap, fn));
}

/** `mail.changed` for a change a request found (`folder` '' = only the folder list). */
export function announce(deps: LiveDeps, ctx: MailContext, folder: string) {
  publish(touchLive(deps, ctx), folder);
}

/**
 * Waits for `work` at most FRESH_BUDGET_MS: its value when it came in time, null otherwise.
 * Late work goes on in the background like the watcher's own (stop() waits for it, errors are
 * logged) and hands its value to `then`. An error in time reaches the caller.
 */
export async function inBudget<T>(
  deps: LiveDeps,
  ctx: MailContext,
  work: Promise<T>,
  then?: (value: T) => unknown,
): Promise<{ value: T } | null> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), FRESH_BUDGET_MS);
  });
  const won = await Promise.race([work.then((value) => ({ value })), late]);
  clearTimeout(timer);
  if (won) return won;
  const live = touchLive(deps, ctx);
  write(live, () =>
    work.then(async (value) => {
      if (!live.closed) await then?.(value);
    }),
  );
  // A watcher that already stopped (shutdown) takes no work: nobody waits for this one.
  if (live.closed) work.catch(() => undefined);
  return null;
}

async function connect(live: Live): Promise<ImapFlow | null> {
  if (live.client?.usable) return live.client;
  if (live.connecting) return live.connecting;
  live.connecting = (async () => {
    try {
      const auth = await live.ctx.auth();
      // IDLE starts by itself after a moment without commands, on the selected folder.
      const c = new ImapFlow({
        ...imapOptions(imapAddress(live.ctx.settings), auth),
        disableAutoIdle: false,
        // Background work comes in bursts; IDLE soon after, and renewed before the socket's
        // inactivity limit (some servers also drop IDLE after 30 minutes).
        autoIdleDelay: 1000,
        maxIdleTime: 60_000,
      });
      c.on('error', (err: unknown) =>
        live.deps.logger.debug({ err }, 'mail live connection error'),
      );
      c.on('close', () => {
        if (live.client === c) live.client = null;
      });
      c.on('exists', (e) => {
        if (e.count > e.prevCount) schedule(live, e.path, {});
      });
      c.on('expunge', (e) => schedule(live, e.path, {}));
      c.on('flags', (e) => {
        if (e.uid === undefined) {
          schedule(live, e.path, { allFlags: true });
          return;
        }
        const uid = e.uid;
        write(live, async () => {
          await setFlags(live.deps.db, live.owner, e.path, [uid], {
            seen: e.flags.has('\\Seen'),
            flagged: e.flags.has('\\Flagged'),
            answered: e.flags.has('\\Answered'),
          });
          if (!live.closed) publish(live, e.path);
        });
      });
      await c.connect();
      if (live.closed) {
        c.close();
        return null;
      }
      live.client = c;
      await watchInbox(c);
      return c;
    } catch (err) {
      if (isAuthError(err)) stop(live);
      live.deps.logger.debug({ err }, 'mail live connect failed');
      return null;
    } finally {
      live.connecting = null;
    }
  })();
  return live.connecting;
}

/** Leaves INBOX selected so IDLE reports on it. */
async function watchInbox(c: ImapFlow) {
  const lock = await lockFolder(c, 'INBOX');
  lock.release();
}

function schedule(live: Live, folder: string, opts: SyncOptions) {
  if (live.closed) return;
  const prev = live.queue.get(folder) ?? {};
  live.queue.set(folder, {
    full: prev.full || opts.full,
    allFlags: prev.allFlags || opts.allFlags,
  });
  wake(live);
}

function wake(live: Live) {
  if (live.closed || live.timer) return;
  live.timer = setTimeout(() => {
    live.timer = null;
    void drain(live);
  }, DEBOUNCE_MS);
  live.timer.unref();
}

const pending = (live: Live) => live.queue.size > 0 || live.prefetch.size > 0;

async function drain(live: Live) {
  if (live.draining) return live.draining;
  live.draining = (async () => {
    try {
      const c = await connect(live);
      if (!c) return;
      // Syncs first, then bodies; work that arrives meanwhile is taken in the same round.
      while (pending(live) && !live.closed) {
        for (
          let next = live.queue.entries().next();
          !next.done;
          next = live.queue.entries().next()
        ) {
          if (live.closed) return;
          const [folder, opts] = next.value;
          live.queue.delete(folder);
          try {
            const result = await syncFolder(live.deps.db, c, live.owner, folder, {
              ...opts,
              signal: live.abort.signal,
            });
            if (result.changed && !live.closed) publish(live, folder);
          } catch (err) {
            live.deps.logger.debug({ err, folder }, 'mail background sync failed');
          }
        }
        for (const [folder, job] of [...live.prefetch]) {
          if (live.closed) return;
          live.prefetch.delete(folder);
          await prefetchBodies(live, c, folder, job.uidValidity, [...job.uids]);
        }
      }
      if (c.usable && !live.closed) await watchInbox(c);
    } catch (err) {
      // Nobody waits for a drain the timer started. The next request connects again.
      live.deps.logger.debug({ err }, 'mail background drain failed');
    } finally {
      live.draining = null;
    }
  })();
  return live.draining;
}

async function prefetchBodies(
  live: Live,
  c: ImapFlow,
  folder: string,
  uidValidity: number,
  uids: number[],
) {
  try {
    const rows = await rowsByUids(live.deps.db, live.owner, folder, uids);
    if (rows.length === 0 || live.closed) return;
    const lock = await lockFolder(c, folder);
    try {
      // A folder that started over since the list was read: its bodies would go under old keys.
      if (c.mailbox && Number(c.mailbox.uidValidity) !== uidValidity) return;
      await fetchBodies(
        c,
        rows.map((r) => ({
          key: bodyKey(live.owner.accountId, folder, uidValidity, r.uid),
          uid: r.uid,
          parts: r.parts,
        })),
      );
    } finally {
      lock.release();
    }
  } catch (err) {
    live.deps.logger.debug({ err, folder }, 'mail body prefetch failed');
  }
}

/**
 * Called by every mailbox request: keeps the background connection alive and queues a sync
 * the request did not do itself.
 */
export function touchLive(deps: LiveDeps, ctx: MailContext, work: LiveWork = {}): Live {
  const accountId = ctx.account.id;
  let live = lives.get(accountId);
  if (!live || live.closed) {
    live = {
      owner: { orgId: ctx.account.orgId, accountId },
      userId: ctx.account.userId,
      ctx,
      deps,
      client: null,
      connecting: null,
      lastUsed: Date.now(),
      queue: new Map(),
      checked: new Map(),
      prefetch: new Map(),
      draining: null,
      timer: null,
      closed: false,
      abort: new AbortController(),
      writes: new Set(),
    };
    lives.set(accountId, live);
  }
  live.ctx = ctx;
  live.deps = deps;
  live.lastUsed = Date.now();
  let queued = false;
  if (work.sync) {
    schedule(live, work.sync, work.opts ?? {});
    queued = true;
  }
  if (work.check) {
    const last = live.checked.get(work.check) ?? 0;
    if (Date.now() - last > CHECK_EVERY_MS) {
      live.checked.set(work.check, Date.now());
      schedule(live, work.check, {});
      queued = true;
    }
  }
  if (work.prefetch?.uids.length && !live.closed) {
    const { folder, uidValidity, uids } = work.prefetch;
    const job = live.prefetch.get(folder);
    if (job && job.uidValidity === uidValidity) for (const u of uids) job.uids.add(u);
    else live.prefetch.set(folder, { uidValidity, uids: new Set(uids) });
    wake(live);
    queued = true;
  }
  if (!queued && !live.client && !live.connecting) void connect(live);
  return live;
}

/** Tests: wait until queued background syncs finished. */
export async function settleLive() {
  for (const live of lives.values()) {
    while (live.timer || live.draining || live.writes.size) {
      if (live.timer) {
        clearTimeout(live.timer);
        live.timer = null;
        await drain(live);
      }
      await live.draining;
      await Promise.allSettled([...live.writes]);
    }
  }
}
