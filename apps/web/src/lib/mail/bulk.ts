import {
  MAIL_BULK_CHUNK,
  type MailBulkAction,
  type MailBulkJob,
  type MailFolder,
  type MailMessage,
  type MailMessageSummary,
} from '@crewhall/shared';
import { type InfiniteData, type QueryClient, type QueryKey } from '@tanstack/react-query';
import { api, idempotencyKey } from '@/lib/api';
import { mailKeys, type MailListFilter } from './queries';

/**
 * Bulk changes in the mail list (selection bar, "mark all as read"). The UI changes first: the
 * cached rows and folder counters are updated at once and put back if the server says no.
 */

type ListPage = { items: MailMessageSummary[]; nextCursor: string | null };
type ListData = InfiniteData<ListPage, string | null>;
type FoldersData = { items: MailFolder[] };

export type Target = { kind: 'uids'; uids: number[] } | { kind: 'folder' };

export interface Snapshot {
  lists: [QueryKey, ListData | undefined][];
  folders: FoldersData | undefined;
}

const listFolder = (key: QueryKey) => (key[2] as MailListFilter | undefined)?.folder;

/** Copies the cached lists of a folder and the folder counters, to roll back with `restore`. */
export function snapshot(qc: QueryClient, folder: string): Snapshot {
  return {
    lists: qc
      .getQueriesData<ListData>({ queryKey: mailKeys.lists })
      .filter(([key]) => listFolder(key) === folder),
    folders: qc.getQueryData<FoldersData>(mailKeys.folders),
  };
}

export function restore(qc: QueryClient, s: Snapshot) {
  for (const [key, data] of s.lists) qc.setQueryData(key, data);
  qc.setQueryData(mailKeys.folders, s.folders);
}

const hits = (target: Target, uid: number) => target.kind === 'folder' || target.uids.includes(uid);

/** Applies the action to the cached rows and counters of `folder` (optimistic update). */
export function applyLocally(
  qc: QueryClient,
  folder: string,
  action: MailBulkAction,
  target: Target,
  moveTo?: string,
) {
  let unreadDelta = 0;
  let removed = 0;
  let removedUnread = 0;
  for (const [key, data] of qc.getQueriesData<ListData>({ queryKey: mailKeys.lists })) {
    if (!data || listFolder(key) !== folder) continue;
    const filter = key[2] as MailListFilter;
    const pages = data.pages.map((page) => {
      const items: MailMessageSummary[] = [];
      for (const m of page.items) {
        if (!hits(target, m.uid)) {
          items.push(m);
          continue;
        }
        // Count once, on the unfiltered list (the same message can sit in several caches).
        const tally = filter.filter === 'all' && !filter.q;
        if (action === 'seen' || action === 'unseen') {
          const seen = action === 'seen';
          if (tally && m.seen !== seen) unreadDelta += seen ? -1 : 1;
          // A read message leaves the "unread" filter.
          if (filter.filter === 'unread' && seen) continue;
          items.push({ ...m, seen });
        } else if (tally) {
          removed += 1;
          if (!m.seen) removedUnread += 1;
        }
      }
      return { ...page, items };
    });
    qc.setQueryData<ListData>(key, { ...data, pages });
  }
  const folders = qc.getQueryData<FoldersData>(mailKeys.folders);
  if (!folders) return;
  qc.setQueryData<FoldersData>(mailKeys.folders, {
    items: folders.items.map((f) => {
      if (f.path === folder) {
        if (target.kind === 'folder') {
          if (action === 'seen') return { ...f, unread: 0 };
          if (action === 'unseen') return { ...f, unread: f.total };
          return { ...f, unread: 0, total: 0 };
        }
        if (action === 'seen' || action === 'unseen') {
          return { ...f, unread: Math.max(0, Math.min(f.total, f.unread + unreadDelta)) };
        }
        return {
          ...f,
          total: Math.max(0, f.total - removed),
          unread: Math.max(0, f.unread - removedUnread),
        };
      }
      if (action === 'move' && f.path === moveTo && target.kind === 'uids') {
        return { ...f, total: f.total + removed, unread: f.unread + removedUnread };
      }
      return f;
    }),
  });
}

/** Sends a selection in requests of at most 500 UIDs (the contract's limit). */
export async function runOnUids(
  folder: string,
  uids: number[],
  action: MailBulkAction,
  moveTo?: string,
) {
  for (let i = 0; i < uids.length; i += MAIL_BULK_CHUNK) {
    const part = uids.slice(i, i + MAIL_BULK_CHUNK);
    if (action === 'seen' || action === 'unseen') {
      await api.call('mailUpdateFlags', {
        body: { folder, uids: part, seen: action === 'seen' },
        idempotencyKey: idempotencyKey(),
      });
    } else if (action === 'move') {
      await api.call('mailMoveMessages', {
        body: { folder, uids: part, target: moveTo! },
        idempotencyKey: idempotencyKey(),
      });
    } else {
      await api.call('mailDeleteMessages', {
        body: { folder, uids: part },
        idempotencyKey: idempotencyKey(),
      });
    }
  }
}

const POLL_MS = 700;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Starts the folder-wide job and follows it until it ends. `onProgress` gets every state the
 * server reports; the promise resolves with the last one (done or failed).
 */
export async function runFolderJob(
  folder: string,
  action: MailBulkAction,
  onProgress: (job: MailBulkJob) => void,
  moveTo?: string,
): Promise<MailBulkJob> {
  let job = await api.call('mailStartBulk', {
    body: { folder, action, ...(moveTo ? { target: moveTo } : {}) },
    idempotencyKey: idempotencyKey(),
  });
  onProgress(job);
  while (job.status === 'queued' || job.status === 'running') {
    await sleep(POLL_MS);
    job = await api.call('mailBulkJob', { params: { jobId: job.id } });
    onProgress(job);
  }
  return job;
}

type ThreadData = { items: MailMessage[] };

/** Changes the cached conversations of one message (every remote-images variant); returns undo. */
export function patchThread(
  qc: QueryClient,
  folder: string,
  uid: number,
  fn: (m: MailMessage) => MailMessage,
) {
  const key = ['mail', 'thread', folder, uid];
  const before = qc.getQueriesData<ThreadData>({ queryKey: key });
  qc.setQueriesData<ThreadData>({ queryKey: key }, (d) => (d ? { items: d.items.map(fn) } : d));
  return () => {
    for (const [k, d] of before) qc.setQueryData(k, d);
  };
}

/** Sets fields of cached list rows of a folder; returns undo. */
export function patchLists(
  qc: QueryClient,
  folder: string,
  uids: number[],
  set: Partial<Pick<MailMessageSummary, 'seen' | 'flagged'>>,
) {
  const before = qc
    .getQueriesData<ListData>({ queryKey: mailKeys.lists })
    .filter(([key]) => listFolder(key) === folder);
  for (const [key, data] of before) {
    if (!data) continue;
    qc.setQueryData<ListData>(key, {
      ...data,
      pages: data.pages.map((p) => ({
        ...p,
        items: p.items.map((m) => (uids.includes(m.uid) ? { ...m, ...set } : m)),
      })),
    });
  }
  return () => {
    for (const [k, d] of before) qc.setQueryData(k, d);
  };
}
