import { eq } from 'drizzle-orm';
import type { ImapFlow, ListResponse } from 'imapflow';
import { mailAccounts, type DbOrTx } from '@crewhall/db';
import type { MailFolder, MailSpecialUse } from '@crewhall/shared';
import { AppError } from '../../http/errors';
import { timed } from './timing';

const SPECIAL: Record<string, MailSpecialUse> = {
  '\\Inbox': 'inbox',
  '\\Sent': 'sent',
  '\\Drafts': 'drafts',
  '\\Trash': 'trash',
  '\\Junk': 'junk',
  '\\Archive': 'archive',
};
const SPECIAL_ORDER: MailSpecialUse[] = ['inbox', 'drafts', 'sent', 'archive', 'junk', 'trash'];
/** Names for folders Crewhall creates when the server has none (Sent copies, deleting). */
const CREATE_NAME: Partial<Record<MailSpecialUse, string>> = { sent: 'Sent', trash: 'Trash' };

export const selectable = (f: ListResponse) =>
  !f.flags.has('\\Noselect') && !f.flags.has('\\NonExistent');

export function specialOf(f: Pick<ListResponse, 'path' | 'specialUse'>): MailSpecialUse | null {
  if (f.path.toUpperCase() === 'INBOX') return 'inbox';
  return (f.specialUse && SPECIAL[f.specialUse]) || null;
}

/* --------------------------- folder list (stale while fresh) ------------------------- */

/**
 * LIST with STATUS costs a round trip per folder on servers without LIST-STATUS, and every
 * screen asks for it. The last answer is kept per account, in memory and in
 * `mail_accounts.folders` (it survives a restart), and served at once; when it is older than
 * FOLDERS_TTL_MS, or Crewhall changed something (`forgetFolders`), the background asks the
 * server again and pushes `mail.changed` when the answer differs. Until then the counters of
 * cached folders come from the header cache (messages.ts `withCachedCounts`).
 */
const FOLDERS_TTL_MS = 15_000;
const folderCache = new Map<string, { at: number; folders: MailFolder[] }>();
const staleFolders = new Set<string>();
/** Folders were created or removed at this time: a list kept from before it is not used. */
const droppedAt = new Map<string, number>();
/** Paths and special uses without counters live longer: they change only when folders do. */
const namesCache = new Map<string, { at: number; list: ListResponse[] }>();
const NAMES_TTL_MS = 5 * 60_000;

/**
 * Counters changed: the next folder list is asked again (answered from the kept one when the
 * server is slow). `names`: folders themselves changed, the kept list is not shown again.
 */
export function forgetFolders(accountId: string, opts: { names?: boolean } = {}) {
  staleFolders.add(accountId);
  if (opts.names) {
    namesCache.delete(accountId);
    folderCache.delete(accountId);
    droppedAt.set(accountId, Date.now());
  }
}

/** The last known folder list (memory, else the stored one), or null before the first LIST. */
export function knownFolders(account: {
  id: string;
  folders: MailFolder[] | null;
  foldersAt: Date | null;
}): { folders: MailFolder[]; stale: boolean } | null {
  const stored =
    account.folders &&
    account.foldersAt &&
    account.foldersAt.getTime() > (droppedAt.get(account.id) ?? 0)
      ? { at: account.foldersAt.getTime(), folders: account.folders }
      : null;
  const hit = folderCache.get(account.id) ?? stored;
  if (!hit) return null;
  return {
    folders: hit.folders,
    stale: staleFolders.has(account.id) || Date.now() - hit.at > FOLDERS_TTL_MS,
  };
}

/** Path of a special folder from the last folder list; undefined while there is none. */
export function knownSpecial(
  account: Parameters<typeof knownFolders>[0],
  use: MailSpecialUse,
): string | null | undefined {
  const known = knownFolders(account);
  if (!known) return undefined;
  return known.folders.find((f) => f.specialUse === use)?.path ?? null;
}

/** Asks the server (LIST with STATUS) and keeps the answer. */
export async function readFolders(c: ImapFlow, accountId: string): Promise<MailFolder[]> {
  staleFolders.delete(accountId);
  const list = await c.list({ statusQuery: { messages: true, unseen: true } });
  namesCache.set(accountId, { at: Date.now(), list });
  const folders = list.filter(selectable).map((f): MailFolder => ({
    path: f.path,
    name: f.name,
    parent: f.parentPath || null,
    delimiter: f.delimiter || null,
    specialUse: specialOf(f),
    total: f.status?.messages ?? 0,
    unread: f.status?.unseen ?? 0,
  }));
  const rank = (f: MailFolder) =>
    f.specialUse ? SPECIAL_ORDER.indexOf(f.specialUse) : SPECIAL_ORDER.length;
  folders.sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path));
  folderCache.set(accountId, { at: Date.now(), folders });
  return folders;
}

export async function saveFolders(db: DbOrTx, accountId: string, folders: MailFolder[]) {
  await timed('db', () =>
    db
      .update(mailAccounts)
      .set({ folders, foldersAt: new Date() })
      .where(eq(mailAccounts.id, accountId)),
  );
}

/** Tests: forget every kept folder list (as after a restart). */
export function clearFolderCaches() {
  folderCache.clear();
  namesCache.clear();
  staleFolders.clear();
  droppedAt.clear();
}

async function names(c: ImapFlow, accountId: string) {
  const hit = namesCache.get(accountId);
  if (hit && Date.now() - hit.at < NAMES_TTL_MS) return hit.list;
  const list = await c.list();
  namesCache.set(accountId, { at: Date.now(), list });
  return list;
}

export async function folderExists(c: ImapFlow, accountId: string, path: string) {
  const list = (await names(c, accountId)).filter(selectable);
  if (list.some((f) => f.path === path)) return true;
  namesCache.delete(accountId);
  return (await names(c, accountId)).filter(selectable).some((f) => f.path === path);
}

/** Path of a special folder; created under its English name when missing and `create` is set. */
export async function specialFolder(
  c: ImapFlow,
  use: MailSpecialUse,
  opts: { create: boolean; accountId?: string },
): Promise<string | null> {
  const list = (opts.accountId ? await names(c, opts.accountId) : await c.list()).filter(
    selectable,
  );
  const found = list.find((f) => specialOf(f) === use);
  if (found) return found.path;
  const name = CREATE_NAME[use];
  if (!opts.create || !name) return null;
  const byName = list.find((f) => f.path.toLowerCase() === name.toLowerCase());
  if (byName) return byName.path;
  const created = await c.mailboxCreate(name);
  if (opts.accountId) forgetFolders(opts.accountId, { names: true });
  return created.path;
}

/** The server refused the folder (NO), or imapflow knows it does not exist. */
export function isMissingFolder(err: unknown) {
  const e = err as { responseStatus?: string; code?: string };
  return e.responseStatus === 'NO' || e.code === 'NotFound';
}

/**
 * Opens a folder; 404 mail_folder_not_found when the server refuses SELECT. Always read-write:
 * switching between EXAMINE and SELECT on one connection costs a round trip each time.
 */
export async function lockFolder(c: ImapFlow, path: string) {
  try {
    return await c.getMailboxLock(path);
  } catch (err) {
    if (isMissingFolder(err)) {
      throw new AppError('mail_folder_not_found');
    }
    throw err;
  }
}
