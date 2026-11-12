import { and, count, desc, eq, inArray, lt, or, sql, type SQL } from 'drizzle-orm';
import type { FetchMessageObject, MessageAddressObject } from 'imapflow';
import { mailFolderState, mailHeaders, type DbOrTx } from '@crewhall/db';
import type { MailAddress, MailMessageSummary } from '@crewhall/shared';
import { hasFiles, partsOf } from './structure';
import { timed } from './timing';

/**
 * The header cache (mail_headers): one row per message of a synced folder. Rows are written
 * by the sync (sync.ts) and kept right by every change Crewhall makes itself (flags, moves,
 * deletes), so lists, conversations and filters are database reads.
 */

export type HeaderRow = typeof mailHeaders.$inferSelect;
export type FolderStateRow = typeof mailFolderState.$inferSelect;
export interface CacheOwner {
  orgId: string;
  accountId: string;
}

const MESSAGE_ID = /<[^<>\s]+>/g;

export function messageIds(raw: string | string[] | undefined | null): string[] {
  if (!raw) return [];
  const text = Array.isArray(raw) ? raw.join(' ') : raw;
  return (text.match(MESSAGE_ID) ?? []).map((id) => id.toLowerCase());
}

/** First Message-ID of References, then In-Reply-To, then the message's own (MailMessageSummary). */
export function threadKey(input: {
  references: string[];
  inReplyTo: string | null;
  messageId: string | null;
  fallback: string;
}): string {
  return input.references[0] ?? input.inReplyTo ?? input.messageId ?? input.fallback;
}

export function referencesHeader(headers: Buffer | undefined): string[] {
  if (!headers) return [];
  // Unfold the header block, then read the References line.
  const text = headers.toString('utf8').replace(/\r?\n[ \t]+/g, ' ');
  const line = /^references:(.*)$/im.exec(text);
  return messageIds(line?.[1]);
}

const address = (a: MessageAddressObject): MailAddress => ({
  name: a.name || null,
  address: a.address ?? '',
});

const when = (d: Date | string | undefined) => {
  if (!d) return null;
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.getTime()) ? null : date;
};

/** A FETCH (UID FLAGS ENVELOPE BODYSTRUCTURE RFC822.SIZE INTERNALDATE References) as a row. */
export function rowOf(owner: CacheOwner, folder: string, m: FetchMessageObject): HeaderRow {
  const env = m.envelope;
  const messageId = messageIds(env?.messageId)[0] ?? null;
  const inReplyTo = messageIds(env?.inReplyTo)[0] ?? null;
  const references = referencesHeader(m.headers);
  const parts = partsOf(m.bodyStructure);
  const from = env?.from?.[0];
  return {
    orgId: owner.orgId,
    accountId: owner.accountId,
    folder,
    uid: m.uid,
    messageId,
    threadId: threadKey({ references, inReplyTo, messageId, fallback: `${folder}:${m.uid}` }),
    subject: env?.subject ?? '',
    fromName: from?.name || null,
    fromAddress: from ? (from.address ?? '') : null,
    to: (env?.to ?? []).map(address),
    cc: (env?.cc ?? []).map(address),
    bcc: (env?.bcc ?? []).map(address),
    replyTo: (env?.replyTo ?? []).map(address),
    inReplyTo,
    references,
    date: when(env?.date) ?? when(m.internalDate),
    seen: m.flags?.has('\\Seen') ?? false,
    flagged: m.flags?.has('\\Flagged') ?? false,
    answered: m.flags?.has('\\Answered') ?? false,
    hasAttachments: hasFiles(parts),
    size: m.size ?? 0,
    parts,
  };
}

export function summaryOf(r: HeaderRow): MailMessageSummary {
  return {
    folder: r.folder,
    uid: r.uid,
    messageId: r.messageId,
    threadId: r.threadId,
    subject: r.subject,
    from: r.fromAddress !== null ? { name: r.fromName, address: r.fromAddress } : null,
    to: r.to,
    date: r.date?.toISOString() ?? null,
    seen: r.seen,
    flagged: r.flagged,
    answered: r.answered,
    hasAttachments: r.hasAttachments,
    size: r.size,
  };
}

const ofFolder = (o: CacheOwner, folder: string) =>
  and(eq(mailHeaders.accountId, o.accountId), eq(mailHeaders.folder, folder))!;

export async function upsertRows(db: DbOrTx, rows: HeaderRow[]) {
  for (let i = 0; i < rows.length; i += 500) {
    const part = rows.slice(i, i + 500);
    await db
      .insert(mailHeaders)
      .values(part)
      .onConflictDoUpdate({
        target: [mailHeaders.accountId, mailHeaders.folder, mailHeaders.uid],
        set: {
          seen: sql`excluded.seen`,
          flagged: sql`excluded.flagged`,
          answered: sql`excluded.answered`,
        },
      });
  }
}

export async function loadState(db: DbOrTx, o: CacheOwner, folder: string) {
  const [row] = await timed('db', () =>
    db
      .select()
      .from(mailFolderState)
      .where(and(eq(mailFolderState.accountId, o.accountId), eq(mailFolderState.folder, folder))),
  );
  return row ?? null;
}

export async function saveState(
  db: DbOrTx,
  o: CacheOwner,
  folder: string,
  set: Omit<FolderStateRow, 'orgId' | 'accountId' | 'folder'>,
) {
  await db
    .insert(mailFolderState)
    .values({ orgId: o.orgId, accountId: o.accountId, folder, ...set })
    .onConflictDoUpdate({ target: [mailFolderState.accountId, mailFolderState.folder], set });
}

/** Forgets a folder (UIDVALIDITY changed, or the folder is gone). */
export async function clearFolder(db: DbOrTx, o: CacheOwner, folder: string) {
  await db.delete(mailHeaders).where(ofFolder(o, folder));
  await db
    .delete(mailFolderState)
    .where(and(eq(mailFolderState.accountId, o.accountId), eq(mailFolderState.folder, folder)));
}

export async function countRows(db: DbOrTx, o: CacheOwner, folder: string) {
  const [row] = await timed('db', () =>
    db.select({ n: count() }).from(mailHeaders).where(ofFolder(o, folder)),
  );
  return row?.n ?? 0;
}

export interface PageFilter {
  unread?: boolean | undefined;
  flagged?: boolean | undefined;
  /** UIDs found by IMAP SEARCH (a text search). */
  uids?: number[] | undefined;
}

/** Newest first, `cursor` = the smallest UID of the previous page (MailMessagesQuery). */
export async function pageOf(
  db: DbOrTx,
  o: CacheOwner,
  folder: string,
  filter: PageFilter,
  limit: number,
  cursor: number | undefined,
) {
  const where: SQL[] = [ofFolder(o, folder)];
  if (filter.unread) where.push(eq(mailHeaders.seen, false));
  if (filter.flagged) where.push(eq(mailHeaders.flagged, true));
  if (filter.uids)
    where.push(filter.uids.length ? inArray(mailHeaders.uid, filter.uids) : sql`false`);
  if (cursor !== undefined) where.push(lt(mailHeaders.uid, cursor));
  const rows = await timed('db', () =>
    db
      .select()
      .from(mailHeaders)
      .where(and(...where))
      .orderBy(desc(mailHeaders.uid))
      .limit(limit + 1),
  );
  const page = rows.slice(0, limit);
  return {
    items: page.map(summaryOf),
    nextCursor: rows.length > limit ? String(page[page.length - 1]!.uid) : null,
  };
}

export async function rowsByUids(db: DbOrTx, o: CacheOwner, folder: string, uids: number[]) {
  if (uids.length === 0) return [];
  return timed('db', () =>
    db
      .select()
      .from(mailHeaders)
      .where(and(ofFolder(o, folder), inArray(mailHeaders.uid, uids))),
  );
}

/** Messages of a conversation in the given folders (the asked folder and Sent). */
export async function threadRows(
  db: DbOrTx,
  o: CacheOwner,
  threadId: string,
  folders: string[],
  limit: number,
) {
  return timed('db', () =>
    db
      .select()
      .from(mailHeaders)
      .where(
        and(
          eq(mailHeaders.accountId, o.accountId),
          eq(mailHeaders.threadId, threadId),
          inArray(mailHeaders.folder, folders),
        ),
      )
      .orderBy(desc(mailHeaders.date), desc(mailHeaders.uid))
      .limit(limit),
  );
}

/** Keeps the cache right after Crewhall changed flags itself (`all` = the whole folder). */
export async function setFlags(
  db: DbOrTx,
  o: CacheOwner,
  folder: string,
  uids: number[] | 'all',
  change: { seen?: boolean | undefined; flagged?: boolean | undefined; answered?: boolean },
) {
  const set: Partial<HeaderRow> = {};
  if (change.seen !== undefined) set.seen = change.seen;
  if (change.flagged !== undefined) set.flagged = change.flagged;
  if (change.answered !== undefined) set.answered = change.answered;
  if (Object.keys(set).length === 0 || (uids !== 'all' && uids.length === 0)) return;
  await db
    .update(mailHeaders)
    .set(set)
    .where(
      uids === 'all'
        ? ofFolder(o, folder)
        : and(ofFolder(o, folder), inArray(mailHeaders.uid, uids)),
    );
}

/** Rows that left the folder (moved, deleted, expunged elsewhere). */
export async function dropRows(db: DbOrTx, o: CacheOwner, folder: string, uids: number[] | 'all') {
  if (uids !== 'all' && uids.length === 0) return;
  await db
    .delete(mailHeaders)
    .where(
      uids === 'all'
        ? ofFolder(o, folder)
        : and(ofFolder(o, folder), inArray(mailHeaders.uid, uids)),
    );
}

/** Local header match for search (subject, sender, recipients): instant, no IMAP. */
export async function headerSearch(db: DbOrTx, o: CacheOwner, folder: string, q: string) {
  const term = `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
  const rows = await db
    .select({ uid: mailHeaders.uid })
    .from(mailHeaders)
    .where(
      and(
        ofFolder(o, folder),
        or(
          sql`${mailHeaders.subject} ilike ${term}`,
          sql`${mailHeaders.fromName} ilike ${term}`,
          sql`${mailHeaders.fromAddress} ilike ${term}`,
          sql`${mailHeaders.to}::text ilike ${term}`,
        ),
      ),
    );
  return rows.map((r) => r.uid);
}

export async function cachedUids(db: DbOrTx, o: CacheOwner, folder: string) {
  const rows = await db
    .select({ uid: mailHeaders.uid })
    .from(mailHeaders)
    .where(ofFolder(o, folder));
  return rows.map((r) => r.uid);
}

/** Flags of cached rows as a "seen flagged answered" key ("101"), for diffing a sync. */
export async function cachedFlags(db: DbOrTx, o: CacheOwner, folder: string, uids: number[]) {
  const out = new Map<number, string>();
  for (let i = 0; i < uids.length; i += 2000) {
    const found = await db
      .select({
        uid: mailHeaders.uid,
        seen: mailHeaders.seen,
        flagged: mailHeaders.flagged,
        answered: mailHeaders.answered,
      })
      .from(mailHeaders)
      .where(and(ofFolder(o, folder), inArray(mailHeaders.uid, uids.slice(i, i + 2000))));
    for (const f of found) out.set(f.uid, `${+f.seen}${+f.flagged}${+f.answered}`);
  }
  return out;
}

/**
 * Counters of the folders whose cache is complete (the header cache is kept right by every
 * change, so these are current while the server's folder list is being asked again).
 */
export async function cachedCounts(db: DbOrTx, o: CacheOwner) {
  return timed('db', async () => {
    const complete = await db
      .select({ folder: mailFolderState.folder })
      .from(mailFolderState)
      .where(and(eq(mailFolderState.accountId, o.accountId), eq(mailFolderState.complete, true)));
    const out = new Map<string, { total: number; unread: number }>();
    if (complete.length === 0) return out;
    for (const { folder } of complete) out.set(folder, { total: 0, unread: 0 });
    const rows = await db
      .select({
        folder: mailHeaders.folder,
        total: count(),
        unread: sql<number>`count(*) filter (where not ${mailHeaders.seen})`.mapWith(Number),
      })
      .from(mailHeaders)
      .where(
        and(
          eq(mailHeaders.accountId, o.accountId),
          inArray(
            mailHeaders.folder,
            complete.map((c) => c.folder),
          ),
        ),
      )
      .groupBy(mailHeaders.folder);
    for (const r of rows) out.set(r.folder, { total: r.total, unread: r.unread });
    return out;
  });
}
