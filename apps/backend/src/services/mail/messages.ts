import type { ImapFlow, SearchObject, StatusObject } from 'imapflow';
import type {
  MailFolder,
  MailMessage,
  MailMessageQuery,
  MailMessagesQuery,
  MailThreadQuery,
} from '@crewhall/shared';
import { AppError } from '../../http/errors';
import { imapOf, type MailContext, type MailDeps } from './accounts';
import { bodyKey, cachedBody, fetchBodies, type Body } from './body';
import {
  cachedCounts,
  countRows,
  dropRows,
  headerSearch,
  loadState,
  pageOf,
  rowOf,
  rowsByUids,
  setFlags,
  summaryOf,
  threadRows,
  upsertRows,
  type CacheOwner,
  type FolderStateRow,
  type HeaderRow,
} from './cache';
import {
  folderExists,
  forgetFolders,
  isMissingFolder,
  knownFolders,
  knownSpecial,
  lockFolder,
  readFolders,
  saveFolders,
  specialFolder,
} from './folders';
import { announce, inBudget, later, PREFETCH_BODIES, touchLive } from './live';
import { htmlToText, sanitizeHtml } from './sanitize';
import { attachmentsOf, partsOf } from './structure';
import { timedSync } from './timing';
import { FLAGS_EVERY_MS, SUMMARY_QUERY, syncFolder } from './sync';

export { lockFolder, specialFolder } from './folders';
export { messageIds, referencesHeader, threadKey } from './cache';

const ownerOf = (ctx: MailContext): CacheOwner => ({
  orgId: ctx.account.orgId,
  accountId: ctx.account.id,
});

/* ------------------------------------- folders ------------------------------------- */

/**
 * The kept folder list while it is fresh (folders.ts). An old one is asked again, but the
 * request waits for the server only FRESH_BUDGET_MS: past that it answers from the kept list
 * (counters of cached folders from the header cache) and the clients hear the new one as
 * `mail.changed`. Only an account's very first list waits for the server.
 */
export async function listFolders(deps: MailDeps, ctx: MailContext): Promise<MailFolder[]> {
  touchLive(deps, ctx);
  const known = knownFolders(ctx.account);
  if (known && !known.stale) return known.folders;
  const read = imapOf(deps, ctx, async (c) => {
    const folders = await readFolders(c, ctx.account.id);
    await saveFolders(deps.db, ctx.account.id, folders);
    return folders;
  });
  if (!known) return read;
  const got = await inBudget(deps, ctx, read, (folders) => {
    if (JSON.stringify(folders) !== JSON.stringify(known.folders)) announce(deps, ctx, '');
  });
  return got ? got.value : withCachedCounts(deps, ctx, known.folders);
}

/** Counters of cached folders from the header cache (right after Crewhall's own changes). */
async function withCachedCounts(deps: MailDeps, ctx: MailContext, folders: MailFolder[]) {
  const counts = await cachedCounts(deps.db, ownerOf(ctx));
  return folders.map((f) => {
    const c = counts.get(f.path);
    return c ? { ...f, total: c.total, unread: c.unread } : f;
  });
}

/* ------------------------------------- listing ------------------------------------- */

async function status(c: ImapFlow, folder: string): Promise<StatusObject> {
  try {
    const s = await c.status(folder, {
      messages: true,
      uidNext: true,
      uidValidity: true,
      highestModseq: true,
    });
    if (!s) throw new AppError('mail_folder_not_found');
    return s;
  } catch (err) {
    if (isMissingFolder(err)) {
      throw new AppError('mail_folder_not_found');
    }
    throw err;
  }
}

/** The cache differs from what STATUS reports (new, removed or, with CONDSTORE, changed mail). */
async function behind(
  db: MailDeps['db'],
  o: CacheOwner,
  folder: string,
  st: StatusObject,
  state: FolderStateRow,
) {
  if (st.uidValidity !== undefined && Number(st.uidValidity) !== state.uidValidity) return true;
  if (st.uidNext !== undefined && st.uidNext !== state.uidNext) return true;
  if (
    st.highestModseq !== undefined &&
    state.modseq !== null &&
    String(st.highestModseq) !== state.modseq
  ) {
    return true;
  }
  return st.messages !== undefined && st.messages !== (await countRows(db, o, folder));
}

/**
 * Makes the folder's cache current before a read: one STATUS when the cache is complete (and a
 * short incremental sync when the server moved on), the first sync of a small folder right
 * away, of a large one in the background. Returns whether the cache can answer.
 */
async function fresh(
  deps: MailDeps,
  ctx: MailContext,
  c: ImapFlow,
  folder: string,
): Promise<{ cached: boolean; changed: boolean }> {
  const o = ownerOf(ctx);
  const state = await loadState(deps.db, o, folder);
  if (state?.complete) {
    const st = await status(c, folder);
    let changed = false;
    if (await behind(deps.db, o, folder, st, state)) {
      changed = (await syncFolder(deps.db, c, o, folder, { status: st })).changed;
      if (changed) forgetFolders(ctx.account.id);
    } else if (state.modseq === null && flagsStale(state)) {
      // Other devices' flag changes without CONDSTORE: refreshed in the background.
      touchLive(deps, ctx, { sync: folder });
    }
    return { cached: true, changed };
  }
  const result = await syncFolder(deps.db, c, o, folder);
  return { cached: result.complete, changed: result.changed };
}

const flagsStale = (s: FolderStateRow) =>
  !s.flagsSyncedAt || Date.now() - s.flagsSyncedAt.getTime() > FLAGS_EVERY_MS;

export async function listMessages(deps: MailDeps, ctx: MailContext, q: MailMessagesQuery) {
  const cursor = q.cursor ? Number.parseInt(q.cursor, 10) : undefined;
  if (cursor !== undefined && (!Number.isFinite(cursor) || cursor < 1)) {
    throw new AppError('bad_request', { reason: 'invalid_cursor' });
  }
  const o = ownerOf(ctx);
  const state = await loadState(deps.db, o, q.folder);
  if (state?.complete && (!q.q || q.scope === 'headers')) {
    // The server is asked whether it moved on, but waited for only FRESH_BUDGET_MS: a cold
    // connection or a slow server answers from the cache, and the check ends in the background
    // with `mail.changed` when it found something (INBOX hears new mail from IDLE anyway).
    touchLive(deps, ctx);
    if (cursor === undefined) {
      await inBudget(
        deps,
        ctx,
        imapOf(deps, ctx, (c) => fresh(deps, ctx, c, q.folder)),
        (r) => r.changed && announce(deps, ctx, q.folder),
      );
    }
    if (cursor === 1) return { items: [], nextCursor: null };
    const uids = q.q ? await headerSearch(deps.db, o, q.folder, q.q) : undefined;
    const page = await pageOf(
      deps.db,
      o,
      q.folder,
      { unread: q.unread, flagged: q.flagged, uids },
      q.limit,
      cursor,
    );
    if (cursor === undefined && !q.q) prefetch(deps, ctx, q.folder, state.uidValidity, page.items);
    return page;
  }
  touchLive(deps, ctx);
  return imapOf(deps, ctx, async (c) => {
    const { cached } = await fresh(deps, ctx, c, q.folder);
    if (cursor === 1) return { items: [], nextCursor: null };
    if (cached) {
      let uids: number[] | undefined;
      if (q.q && q.scope === 'headers') {
        uids = await headerSearch(deps.db, o, q.folder, q.q);
      } else if (q.q) {
        // Server search covers the bodies; the cache adds header matches without a round trip.
        const lock = await lockFolder(c, q.folder);
        try {
          const found = (await c.search({ text: q.q }, { uid: true })) || [];
          uids = [...new Set([...found, ...(await headerSearch(deps.db, o, q.folder, q.q))])];
        } finally {
          lock.release();
        }
      }
      return pageOf(
        deps.db,
        o,
        q.folder,
        { unread: q.unread, flagged: q.flagged, uids },
        q.limit,
        cursor,
      );
    }
    const page = await livePage(c, o, q, cursor);
    // A large folder's first sync starts after this page went out, not against it.
    touchLive(deps, ctx, { sync: q.folder, opts: { full: true } });
    return page;
  });
}

/** The newest messages of a list get their bodies fetched ahead, so opening one is instant. */
function prefetch(
  deps: MailDeps,
  ctx: MailContext,
  folder: string,
  uidValidity: number,
  items: { uid: number }[],
) {
  const uids = items
    .slice(0, PREFETCH_BODIES)
    .map((m) => m.uid)
    .filter((uid) => !cachedBody(bodyKey(ctx.account.id, folder, uidValidity, uid)));
  if (uids.length) touchLive(deps, ctx, { prefetch: { folder, uidValidity, uids } });
}

/** A page straight from IMAP while a large folder's cache is still being built. */
async function livePage(
  c: ImapFlow,
  o: CacheOwner,
  q: MailMessagesQuery,
  cursor: number | undefined,
) {
  const lock = await lockFolder(c, q.folder);
  try {
    const filtered = Boolean(q.q || q.unread || q.flagged);
    if (!filtered) {
      // Newest by sequence number: no SEARCH over the whole folder.
      const exists = c.mailbox ? c.mailbox.exists : 0;
      let end = exists;
      if (cursor !== undefined) {
        const at = (await c.search({ uid: String(cursor) })) || [];
        end = at.length ? at[0]! - 1 : -1;
      }
      if (end >= 1) {
        const start = Math.max(1, end - q.limit + 1);
        const rows = await c.fetchAll(`${start}:${end}`, SUMMARY_QUERY);
        const items = rows
          .map((m) => summaryOf(rowOf(o, q.folder, m)))
          .sort((a, b) => b.uid - a.uid);
        return {
          items,
          nextCursor: start > 1 && items.length ? String(items[items.length - 1]!.uid) : null,
        };
      }
      if (end === 0 || exists === 0) return { items: [], nextCursor: null };
    }
    const s: SearchObject = {};
    if (q.unread) s.seen = false;
    if (q.flagged) s.flagged = true;
    // TEXT covers every header (subject, sender, recipients) and the body in one key; ORing
    // FROM/TO with free text breaks on some servers (GreenMail refuses "FROM rapor 2").
    if (q.q) s.text = q.q;
    if (cursor !== undefined) s.uid = `1:${Math.max(1, cursor - 1)}`;
    if (Object.keys(s).length === 0) s.all = true;
    const uids = [...((await c.search(s, { uid: true })) || [])].sort((a, b) => b - a);
    const pageUids = uids.slice(0, q.limit);
    if (pageUids.length === 0) return { items: [], nextCursor: null };
    const rows = await c.fetchAll(pageUids, SUMMARY_QUERY, { uid: true });
    const items = rows.map((m) => summaryOf(rowOf(o, q.folder, m))).sort((a, b) => b.uid - a.uid);
    return {
      items,
      nextCursor: uids.length > q.limit ? String(pageUids[pageUids.length - 1]!) : null,
    };
  } finally {
    lock.release();
  }
}

/* -------------------------------------- reading ------------------------------------- */

function remoteAllowed(ctx: MailContext, asked: boolean) {
  if (asked && !ctx.settings.allowRemoteImages) throw new AppError('mail_remote_images_disabled');
  return asked;
}

export function messageOf(
  row: HeaderRow,
  body: Body,
  opts: { remoteImages: boolean },
): MailMessage {
  const html = body.html ? cleanHtml(body, body.html, opts.remoteImages) : null;
  return {
    ...summaryOf(row),
    cc: row.cc,
    bcc: row.bcc,
    replyTo: row.replyTo,
    inReplyTo: row.inReplyTo,
    references: row.references,
    html: html?.html ?? null,
    text: body.text ?? (body.html ? htmlToText(body.html) : null),
    attachments: attachmentsOf(row.parts),
    blockedImages: html?.blockedImages ?? 0,
  };
}

function cleanHtml(body: Body, raw: string, remoteImages: boolean) {
  const k = remoteImages ? 'remote' : 'blocked';
  body.clean ??= {};
  body.clean[k] ??= timedSync('sanitize', () =>
    sanitizeHtml(raw, { remoteImages, inlineImages: body.inline }),
  );
  return body.clean[k];
}

/** Header rows of `uids` in the folder `c` has selected: from the cache, else one FETCH. */
async function rowsOf(
  deps: MailDeps,
  c: ImapFlow,
  o: CacheOwner,
  folder: string,
  uids: number[],
  cached: boolean,
) {
  const rows = cached ? await rowsByUids(deps.db, o, folder, uids) : [];
  const missing = uids.filter((u) => !rows.some((r) => r.uid === u));
  if (missing.length) {
    const fetched = (await c.fetchAll(missing, SUMMARY_QUERY, { uid: true })).map((m) =>
      rowOf(o, folder, m),
    );
    if (cached) await upsertRows(deps.db, fetched);
    rows.push(...fetched);
  }
  return rows;
}

const THREAD_MAX = 25;

/** Live conversation search for a folder whose cache is not ready yet. */
async function searchThread(c: ImapFlow, root: string) {
  const query: SearchObject = {
    or: [
      { header: { 'message-id': root } },
      { header: { references: root } },
      { header: { 'in-reply-to': root } },
    ],
  };
  return ((await c.search(query, { uid: true })) || []).sort((a, b) => b - a).slice(0, THREAD_MAX);
}

/** Bodies of `rows` (one folder, selected on `c`), marking unread ones read when asked. */
async function readRows(
  deps: MailDeps,
  ctx: MailContext,
  c: ImapFlow,
  folder: string,
  rows: HeaderRow[],
  opts: { remoteImages: boolean; markSeen: boolean },
) {
  const uidValidity = c.mailbox ? Number(c.mailbox.uidValidity) : 0;
  const bodies = await fetchBodies(
    c,
    rows.map((row) => ({
      key: bodyKey(ctx.account.id, folder, uidValidity, row.uid),
      uid: row.uid,
      parts: row.parts,
    })),
  );
  const out = rows.map((row) => messageOf(row, bodies.get(row.uid)!, opts));
  if (opts.markSeen) {
    const unseen = out.filter((m) => !m.seen).map((m) => m.uid);
    if (unseen.length) {
      await c.messageFlagsAdd(unseen, ['\\Seen'], { uid: true });
      await setFlags(deps.db, ownerOf(ctx), folder, unseen, { seen: true });
      forgetFolders(ctx.account.id);
      for (const m of out) m.seen = true;
    }
  }
  return out;
}

export async function getMessage(deps: MailDeps, ctx: MailContext, q: MailMessageQuery) {
  const remote = remoteAllowed(ctx, q.remoteImages);
  const o = ownerOf(ctx);
  return imapOf(deps, ctx, async (c) => {
    const cached = Boolean((await loadState(deps.db, o, q.folder))?.complete);
    const lock = await lockFolder(c, q.folder);
    try {
      const [row] = await rowsOf(deps, c, o, q.folder, [q.uid], cached);
      if (!row) throw new AppError('mail_message_not_found');
      const [msg] = await readRows(deps, ctx, c, q.folder, [row], {
        remoteImages: remote,
        markSeen: q.markSeen,
      });
      return msg!;
    } finally {
      lock.release();
    }
  });
}

/**
 * A conversation answered without IMAP: headers from the cache, bodies from memory (opened
 * before, or prefetched by the list). Null when anything is missing; the IMAP path then
 * fetches only what is.
 */
async function threadFromCache(
  deps: MailDeps,
  ctx: MailContext,
  q: MailThreadQuery,
  remote: boolean,
): Promise<MailMessage[] | null> {
  const o = ownerOf(ctx);
  const sent = knownSpecial(ctx.account, 'sent');
  if (sent === undefined) return null;
  const folders = sent && sent !== q.folder ? [q.folder, sent] : [q.folder];
  const states = new Map<string, FolderStateRow>();
  for (const f of folders) {
    const s = await loadState(deps.db, o, f);
    if (!s?.complete) return null;
    states.set(f, s);
  }
  const [first] = await rowsByUids(deps.db, o, q.folder, [q.uid]);
  if (!first) return null;
  const members = first.threadId.startsWith('<')
    ? await threadRows(deps.db, o, first.threadId, folders, THREAD_MAX)
    : [];
  if (!members.some((r) => r.folder === q.folder && r.uid === q.uid)) members.push(first);
  const bodies = new Map<HeaderRow, Body>();
  for (const r of members) {
    const body = cachedBody(
      bodyKey(ctx.account.id, r.folder, states.get(r.folder)!.uidValidity, r.uid),
    );
    if (!body) return null;
    bodies.set(r, body);
  }
  const out = members.map((r) => messageOf(r, bodies.get(r)!, { remoteImages: remote }));
  if (q.markSeen) {
    const unseen = out.filter((m) => m.folder === q.folder && !m.seen).map((m) => m.uid);
    if (unseen.length) {
      await setFlags(deps.db, o, q.folder, unseen, { seen: true });
      forgetFolders(ctx.account.id);
      for (const m of out) if (m.folder === q.folder) m.seen = true;
      later(deps, ctx, async (c) => {
        const lock = await lockFolder(c, q.folder);
        try {
          await c.messageFlagsAdd(unseen, ['\\Seen'], { uid: true });
        } finally {
          lock.release();
        }
      });
    }
  }
  // Replies sent from another program show up once the background saw Sent change.
  touchLive(deps, ctx, sent && sent !== q.folder ? { check: sent } : {});
  return out;
}

/** Oldest first; one copy of a message that sits in both folders (the asked folder's). */
function ordered(out: MailMessage[], folder: string) {
  const time = (m: MailMessage) => (m.date ? Date.parse(m.date) : 0);
  // The same message can sit in both folders (servers that keep a Sent copy themselves).
  const unique = new Map<string, MailMessage>();
  for (const m of out) {
    const k = m.messageId ?? `${m.folder}:${m.uid}`;
    if (!unique.has(k) || m.folder === folder) unique.set(k, m);
  }
  // Date headers have one-second precision; within a tie the longer References chain is later.
  const items = [...unique.values()].sort(
    (a, b) => time(a) - time(b) || a.references.length - b.references.length,
  );
  return { items: items.slice(-THREAD_MAX) };
}

/** The asked message and its conversation in the same folder and in Sent, oldest first. */
export async function getThread(deps: MailDeps, ctx: MailContext, q: MailThreadQuery) {
  const remote = remoteAllowed(ctx, q.remoteImages);
  const o = ownerOf(ctx);
  const hit = await threadFromCache(deps, ctx, q, remote);
  if (hit) return ordered(hit, q.folder);
  touchLive(deps, ctx);
  return imapOf(deps, ctx, async (c) => {
    const cached = Boolean((await loadState(deps.db, o, q.folder))?.complete);
    const sent = await specialFolder(c, 'sent', { create: false, accountId: ctx.account.id });
    const sentCached =
      sent !== null && sent !== q.folder && Boolean((await loadState(deps.db, o, sent))?.complete);
    // Replies sent from another program: the background checks Sent (Crewhall's own replies
    // are in its cache already, send.ts).
    if (sentCached) touchLive(deps, ctx, { check: sent! });

    let first: HeaderRow | undefined;
    let members: HeaderRow[] = [];
    const lock = await lockFolder(c, q.folder);
    try {
      [first] = await rowsOf(deps, c, o, q.folder, [q.uid], cached);
      if (!first) throw new AppError('mail_message_not_found');
      if (first.threadId.startsWith('<')) {
        if (cached) {
          const folders = sentCached ? [q.folder, sent!] : [q.folder];
          members = await threadRows(deps.db, o, first.threadId, folders, THREAD_MAX);
        } else {
          const uids = await searchThread(c, first.threadId);
          members = (await rowsOf(deps, c, o, q.folder, uids, false)).filter(
            (r) => r.threadId === first!.threadId,
          );
        }
      }
    } finally {
      lock.release();
    }
    if (!members.some((r) => r.folder === q.folder && r.uid === q.uid)) members.push(first);
    // Sent without a cache yet: search it live, and let the background build its cache.
    if (sent && sent !== q.folder && !sentCached && first.threadId.startsWith('<')) {
      touchLive(deps, ctx, { sync: sent, opts: { full: true } });
      const sentLock = await lockFolder(c, sent);
      try {
        const uids = await searchThread(c, first.threadId);
        const rows = await rowsOf(deps, c, o, sent, uids, false);
        members.push(...rows.filter((r) => r.threadId === first!.threadId));
      } finally {
        sentLock.release();
      }
    }

    const out: MailMessage[] = [];
    for (const folder of [
      q.folder,
      ...new Set(members.map((m) => m.folder).filter((f) => f !== q.folder)),
    ]) {
      const rows = members.filter((m) => m.folder === folder);
      if (rows.length === 0) continue;
      const fl = await lockFolder(c, folder);
      try {
        out.push(
          ...(await readRows(deps, ctx, c, folder, rows, {
            remoteImages: remote,
            markSeen: q.markSeen && folder === q.folder,
          })),
        );
      } finally {
        fl.release();
      }
    }

    return ordered(out, q.folder);
  });
}

/* ------------------------------------ changing ------------------------------------- */

export async function updateFlags(
  deps: MailDeps,
  ctx: MailContext,
  input: {
    folder: string;
    uids: number[];
    seen?: boolean | undefined;
    flagged?: boolean | undefined;
  },
) {
  await imapOf(deps, ctx, async (c) => {
    const lock = await lockFolder(c, input.folder);
    try {
      const change = async (flag: string, on: boolean | undefined) => {
        if (on === undefined) return;
        if (on) await c.messageFlagsAdd(input.uids, [flag], { uid: true });
        else await c.messageFlagsRemove(input.uids, [flag], { uid: true });
      };
      await change('\\Seen', input.seen);
      await change('\\Flagged', input.flagged);
    } finally {
      lock.release();
    }
  });
  await setFlags(deps.db, ownerOf(ctx), input.folder, input.uids, {
    seen: input.seen,
    flagged: input.flagged,
  });
  forgetFolders(ctx.account.id);
}

export async function moveMessages(
  deps: MailDeps,
  ctx: MailContext,
  input: { folder: string; uids: number[]; target: string },
) {
  await imapOf(deps, ctx, async (c) => {
    if (!(await folderExists(c, ctx.account.id, input.target))) {
      throw new AppError('mail_folder_not_found');
    }
    const lock = await lockFolder(c, input.folder);
    try {
      await c.messageMove(input.uids, input.target, { uid: true });
    } finally {
      lock.release();
    }
  });
  await dropRows(deps.db, ownerOf(ctx), input.folder, input.uids);
  forgetFolders(ctx.account.id);
}

export async function deleteMessages(
  deps: MailDeps,
  ctx: MailContext,
  input: { folder: string; uids: number[] },
) {
  const result = await imapOf(deps, ctx, async (c) => {
    const trash = await specialFolder(c, 'trash', { create: true, accountId: ctx.account.id });
    const lock = await lockFolder(c, input.folder);
    try {
      if (!trash || trash === input.folder) {
        await c.messageDelete(input.uids, { uid: true });
        return { permanent: true };
      }
      await c.messageMove(input.uids, trash, { uid: true });
      return { permanent: false };
    } finally {
      lock.release();
    }
  });
  await dropRows(deps.db, ownerOf(ctx), input.folder, input.uids);
  forgetFolders(ctx.account.id);
  return result;
}

/** Raw bytes of one MIME part (decoded), for downloads, forwarding and saving to Drive. */
export async function readPart(
  c: ImapFlow,
  folder: string,
  uid: number,
  part: string,
): Promise<{ content: Buffer; filename: string; contentType: string }> {
  const lock = await lockFolder(c, folder);
  try {
    const m = await c.fetchOne(String(uid), { uid: true, bodyStructure: true }, { uid: true });
    if (!m) throw new AppError('mail_message_not_found');
    const info = partsOf(m.bodyStructure).find((p) => p.part === part);
    if (!info) throw new AppError('mail_attachment_not_found');
    const download = await c.download(String(uid), part, { uid: true });
    if (!('content' in download) || !download.content)
      throw new AppError('mail_attachment_not_found');
    const chunks: Buffer[] = [];
    for await (const chunk of download.content as AsyncIterable<Buffer>) chunks.push(chunk);
    return {
      content: Buffer.concat(chunks),
      filename: info.filename || download.meta.filename || `attachment-${part}`,
      contentType: info.type || download.meta.contentType || 'application/octet-stream',
    };
  } finally {
    lock.release();
  }
}

export async function messageHeaders(c: ImapFlow, folder: string, uid: number) {
  const lock = await lockFolder(c, folder);
  try {
    const m = await c.fetchOne(String(uid), SUMMARY_QUERY, { uid: true });
    if (!m) throw new AppError('mail_message_not_found');
    const row = rowOf({ orgId: '', accountId: '' }, folder, m);
    return { ...summaryOf(row), references: row.references };
  } finally {
    lock.release();
  }
}
