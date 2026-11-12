import { and, desc, eq, ilike, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import {
  mailAccounts,
  mailCannedResponses,
  mailConversationNotes,
  mailConversations,
  mailHeaders,
  mailSharedInboxes,
  spaceMembers,
  spaces,
  users,
  type DbOrTx,
} from '@crewhall/db';
import {
  can,
  type CreateMailCannedResponse,
  type CreateMailInbox,
  type MailCannedResponse,
  type MailConversation,
  type MailConversationNote,
  type MailConversationsQuery,
  type MailConversationSummary,
  type MailInbox,
  type MailInboxPerson,
  type MailInboxReply,
  type MailInboxWsEvent,
  type MailSendResult,
  type SpaceAction,
  type SpaceRole,
  type UpdateMailCannedResponse,
  type UpdateMailConversation,
  type UpdateMailInbox,
} from '@crewhall/shared';
import type { Deps } from '../../deps';
import { AppError } from '../../http/errors';
import { publishToUsers } from '../../realtime/bus';
import type { DriveActor } from '../drive/access';
import { spaceRoleOf } from '../drive/access';
import { orgContext } from '../membership';
import { notify } from '../notifications/notify';
import { contextFor, imapOf, type MailAccountRow, type MailContext } from './accounts';
import { loadState } from './cache';
import { sealSecret } from './crypto';
import type { OauthTokens } from './oauth';
import { knownSpecial, readFolders, saveFolders } from './folders';
import { closeAccountConnections, imapAddress, verifyImapLogin } from './imap';
import { inBudget, touchLive, type LiveDeps } from './live';
import { getThread } from './messages';
import { sanitizeHtml } from './sanitize';
import { sendMessage } from './send';
import { requireSettings, type MailSettingsRow } from './settings';
import { syncFolder } from './sync';

/**
 * Shared inbox (sonraki-isler.md "Ortak gelen kutusu", doc: kararlar.md). The address's IMAP
 * side is a `mail_accounts` row of kind `shared`: its INBOX and Sent are cached and watched like
 * a person's mailbox. A conversation is a mail thread of INBOX (with the team's replies in
 * Sent); `mail_conversations` adds status, assignee, tags and the first response time, rebuilt
 * from the header cache after each sync (`refreshConversations`).
 */

export type InboxActor = DriveActor & { userName: string };
type InboxRow = typeof mailSharedInboxes.$inferSelect;
type ConversationRow = typeof mailConversations.$inferSelect;

export type InboxDeps = Pick<Deps, 'db' | 'env' | 'logger' | 'bus' | 'jobs' | 'storage'> &
  Partial<Pick<Deps, 'presence'>>;

const INBOX_FOLDER = 'INBOX';

/* --------------------------------------- access --------------------------------------- */

const canInbox = (a: InboxActor, role: SpaceRole | null, action: SpaceAction) =>
  can(a.actor, action, { type: 'space', org: orgContext(a.org), myRole: role });

/** Others than the space's members do not learn the inbox exists. */
function requireInbox(a: InboxActor, role: SpaceRole | null, action: SpaceAction) {
  if (canInbox(a, role, action)) return;
  throw new AppError(
    role === null || !canInbox(a, role, 'mail.inbox.view') ? 'not_found' : 'forbidden',
  );
}

interface Loaded {
  inbox: InboxRow;
  account: MailAccountRow;
  spaceName: string;
  role: SpaceRole | null;
}

async function loadInbox(db: DbOrTx, a: InboxActor, inboxId: string): Promise<Loaded> {
  const [row] = await db
    .select({ inbox: mailSharedInboxes, account: mailAccounts, space: spaces })
    .from(mailSharedInboxes)
    .innerJoin(mailAccounts, eq(mailAccounts.id, mailSharedInboxes.accountId))
    .innerJoin(spaces, eq(spaces.id, mailSharedInboxes.spaceId))
    .where(and(eq(mailSharedInboxes.id, inboxId), eq(mailSharedInboxes.orgId, a.org.id)));
  if (!row || row.space.deletedAt) throw new AppError('not_found');
  const role = await spaceRoleOf(db, row.space.id, a.userId);
  requireInbox(a, role, 'mail.inbox.view');
  return { inbox: row.inbox, account: row.account, spaceName: row.space.name, role };
}

/** The inbox's mailbox context, with its changes announced to the space's members. */
async function inboxContext(deps: InboxDeps, l: Loaded) {
  const settings = await requireSettings(deps.db, l.inbox.orgId);
  const ctx = contextFor(deps, settings, l.account);
  const live: InboxDeps & LiveDeps = {
    ...deps,
    onChanged: async () => {
      if (await refreshConversations(deps.db, l.inbox, l.account)) {
        await announceInbox(deps, l.inbox, null);
      }
    },
  };
  return { settings, ctx, live };
}

async function memberIds(db: DbOrTx, spaceId: string) {
  const rows = await db
    .select({ userId: spaceMembers.userId })
    .from(spaceMembers)
    .where(eq(spaceMembers.spaceId, spaceId));
  return rows.map((r) => r.userId);
}

async function announce(deps: Pick<Deps, 'db' | 'bus'>, spaceId: string, e: MailInboxWsEvent) {
  publishToUsers(deps.bus, await memberIds(deps.db, spaceId), e);
}

const announceInbox = (
  deps: Pick<Deps, 'db' | 'bus'>,
  inbox: InboxRow,
  conversationId: string | null,
) =>
  announce(deps, inbox.spaceId, { type: 'mail.inbox.changed', inboxId: inbox.id, conversationId });

/* ------------------------------------ conversations ----------------------------------- */

/**
 * Rebuilds the inbox's conversations from the header cache of INBOX and Sent: one per thread
 * with an incoming message. Keeps the team's state; a newer incoming message reopens a pending
 * or resolved conversation. Returns whether anything changed.
 */
export async function refreshConversations(db: DbOrTx, inbox: InboxRow, account: MailAccountRow) {
  const sent = knownSpecial(account, 'sent') ?? '';
  const folders = sent ? [INBOX_FOLDER, sent] : [INBOX_FOLDER];
  // Per thread: the facts of its messages (g), then the team's first reply after the first
  // incoming message (an aggregate over h, which a FILTER of g cannot hold).
  const result = await db.execute(sql`
    with h as (
      select thread_id, folder, uid, subject, from_name, from_address, seen,
        coalesce(date, 'epoch'::timestamptz) as at
      from ${mailHeaders}
      where account_id = ${account.id} and ${inArray(mailHeaders.folder, folders)}
    ), g as (
      select thread_id,
        (array_agg(subject order by at, uid))[1] as subject,
        (array_agg(from_name order by at, uid) filter (where folder = ${INBOX_FOLDER}))[1] as customer_name,
        (array_agg(from_address order by at, uid) filter (where folder = ${INBOX_FOLDER}))[1] as customer_address,
        count(*)::int as message_count,
        (count(*) filter (where folder = ${INBOX_FOLDER}))::int as inbound_count,
        coalesce(bool_or(not seen) filter (where folder = ${INBOX_FOLDER}), false) as unread,
        min(at) as first_message_at,
        min(at) filter (where folder = ${INBOX_FOLDER}) as first_inbound_at,
        max(at) as last_message_at,
        max(at) filter (where folder = ${INBOX_FOLDER}) as last_inbound_at
      from h
      group by thread_id
      having count(*) filter (where folder = ${INBOX_FOLDER}) > 0
    )
    insert into ${mailConversations} as c (
      id, org_id, inbox_id, thread_id, subject, customer_name, customer_address, message_count,
      inbound_count, unread, first_message_at, first_inbound_at, last_message_at, last_inbound_at,
      first_response_at
    )
    select gen_random_uuid(), ${inbox.orgId}, ${inbox.id}, g.thread_id, g.subject,
      g.customer_name, g.customer_address, g.message_count, g.inbound_count, g.unread, g.first_message_at,
      g.first_inbound_at, g.last_message_at, g.last_inbound_at,
      (select min(h.at) from h
        where h.thread_id = g.thread_id and h.folder = ${sent} and h.at >= g.first_inbound_at)
    from g
    on conflict (inbox_id, thread_id) do update set
      message_count = excluded.message_count,
      inbound_count = excluded.inbound_count,
      unread = excluded.unread,
      last_message_at = excluded.last_message_at,
      last_inbound_at = excluded.last_inbound_at,
      first_response_at = coalesce(c.first_response_at, excluded.first_response_at),
      -- A new incoming message (by count, not by its Date header: that is the sender's clock,
      -- to the second) reopens a pending or resolved conversation. 0: counted before this rule.
      status = case
        when c.status <> 'open' and c.inbound_count > 0
          and excluded.inbound_count > c.inbound_count
        then 'open'::mail_conversation_status
        else c.status end,
      status_changed_at = case
        when c.status <> 'open' and c.inbound_count > 0
          and excluded.inbound_count > c.inbound_count
        then now()
        else c.status_changed_at end,
      updated_at = now()
    where c.message_count is distinct from excluded.message_count
      or c.inbound_count is distinct from excluded.inbound_count
      or c.unread is distinct from excluded.unread
      or c.last_message_at is distinct from excluded.last_message_at
      or c.first_response_at is null and excluded.first_response_at is not null
  `);
  return (result.rowCount ?? 0) > 0;
}

/**
 * INBOX and Sent made current for a read, waiting for the server at most FRESH_BUDGET_MS (as
 * personal lists do); the first sync of a large inbox runs in the background.
 */
async function freshInbox(
  deps: InboxDeps,
  l: Loaded,
  ctx: MailContext,
  live: InboxDeps & LiveDeps,
) {
  touchLive(live, ctx);
  const owner = { orgId: l.account.orgId, accountId: l.account.id };
  const sync = async (changed: boolean) =>
    (await refreshConversations(deps.db, l.inbox, l.account)) || changed;
  // Asked before the sync starts: a sync that fails (a refused token) during this query would
  // be a rejection nobody listens to yet.
  const state = await loadState(deps.db, owner, INBOX_FOLDER);
  const work = syncInbox(deps, l, ctx, live);
  // An inbox seen for the first time has nothing to show yet: that read waits.
  if (!state?.complete) {
    await sync(await work);
    return;
  }
  const got = await inBudget(live, ctx, work, async (changed) => {
    if (await sync(changed)) await announceInbox(deps, l.inbox, null);
  });
  await (got ? sync(got.value) : refreshConversations(deps.db, l.inbox, l.account));
}

/** INBOX and Sent synced now (the folder list first while Sent is not known). */
function syncInbox(deps: InboxDeps, l: Loaded, ctx: MailContext, live: InboxDeps & LiveDeps) {
  const owner = { orgId: l.account.orgId, accountId: l.account.id };
  return imapOf(deps, ctx, async (c) => {
    if (knownSpecial(l.account, 'sent') === undefined) {
      const folders = await readFolders(c, l.account.id);
      await saveFolders(deps.db, l.account.id, folders);
      l.account.folders = folders;
      l.account.foldersAt = new Date();
    }
    let changed = false;
    for (const folder of [INBOX_FOLDER, knownSpecial(l.account, 'sent')]) {
      if (!folder) continue;
      const r = await syncFolder(deps.db, c, owner, folder);
      if (!r.complete) touchLive(live, ctx, { sync: folder, opts: { full: true } });
      changed = r.changed || changed;
    }
    return changed;
  });
}

type PersonRow = { id: string; name: string; image: string | null } | null;
const personOf = (u: PersonRow): MailInboxPerson | null =>
  u ? { id: u.id, name: u.name, imageUrl: u.image } : null;

function slaOf(inbox: InboxRow, c: ConversationRow) {
  if (!inbox.slaFirstResponseMinutes || !c.firstInboundAt) return { dueAt: null, breached: false };
  const due = new Date(c.firstInboundAt.getTime() + inbox.slaFirstResponseMinutes * 60_000);
  const breached = c.firstResponseAt
    ? c.firstResponseAt > due
    : c.status !== 'resolved' && Date.now() > due.getTime();
  return { dueAt: due.toISOString(), breached };
}

const noteCount = sql<number>`(select count(*)::int from ${mailConversationNotes} n where n.conversation_id = "mail_conversations"."id")`;

const assignee = {
  id: users.id,
  name: users.name,
  image: users.image,
};

function summaryOf(
  inbox: InboxRow,
  r: {
    c: ConversationRow;
    a: PersonRow;
    notes: number;
  },
): MailConversationSummary {
  const c = r.c;
  return {
    id: c.id,
    inboxId: c.inboxId,
    threadId: c.threadId,
    subject: c.subject,
    customer:
      c.customerAddress !== null ? { name: c.customerName, address: c.customerAddress } : null,
    status: c.status,
    assignee: personOf(r.a),
    tags: c.tags,
    messageCount: c.messageCount,
    unread: c.unread,
    noteCount: r.notes,
    firstMessageAt: c.firstMessageAt.toISOString(),
    lastMessageAt: c.lastMessageAt.toISOString(),
    lastInboundAt: c.lastInboundAt?.toISOString() ?? null,
    firstResponseAt: c.firstResponseAt?.toISOString() ?? null,
    sla: slaOf(inbox, c),
  };
}

function conversationQuery(db: DbOrTx, where: SQL) {
  return db
    .select({ c: mailConversations, a: assignee, notes: noteCount })
    .from(mailConversations)
    .leftJoin(users, eq(users.id, mailConversations.assigneeId))
    .where(where);
}

/* ---------------------------------------- inboxes --------------------------------------- */

async function inboxView(
  db: DbOrTx,
  a: InboxActor,
  l: Pick<Loaded, 'inbox' | 'account' | 'spaceName' | 'role'>,
): Promise<MailInbox> {
  const [counts] = await db
    .select({
      open: sql<number>`count(*) filter (where ${mailConversations.status} = 'open')::int`,
      unassigned: sql<number>`count(*) filter (where ${mailConversations.status} = 'open' and ${mailConversations.assigneeId} is null)::int`,
      mine: sql<number>`count(*) filter (where ${mailConversations.status} <> 'resolved' and ${mailConversations.assigneeId} = ${a.userId})::int`,
    })
    .from(mailConversations)
    .where(eq(mailConversations.inboxId, l.inbox.id));
  return {
    id: l.inbox.id,
    spaceId: l.inbox.spaceId,
    spaceName: l.spaceName,
    name: l.inbox.name,
    email: l.account.email,
    username: l.account.username,
    signatureHtml: l.account.signatureHtml,
    slaFirstResponseMinutes: l.inbox.slaFirstResponseMinutes,
    status: l.account.status === 'auth_failed' ? 'auth_failed' : 'ok',
    authMode: l.account.authMode,
    needsSignIn: needsSignIn(l.account),
    counts: {
      open: counts?.open ?? 0,
      unassigned: counts?.unassigned ?? 0,
      mine: counts?.mine ?? 0,
    },
    canWork: canInbox(a, l.role, 'mail.inbox.work'),
    canManage: canInbox(a, l.role, 'mail.inbox.manage'),
    createdAt: l.inbox.createdAt.toISOString(),
  };
}

/** Inboxes of the spaces the caller is a member of. */
export async function listInboxes(db: DbOrTx, a: InboxActor): Promise<MailInbox[]> {
  const rows = await db
    .select({
      inbox: mailSharedInboxes,
      account: mailAccounts,
      spaceName: spaces.name,
      role: spaceMembers.role,
    })
    .from(mailSharedInboxes)
    .innerJoin(mailAccounts, eq(mailAccounts.id, mailSharedInboxes.accountId))
    .innerJoin(spaces, eq(spaces.id, mailSharedInboxes.spaceId))
    .innerJoin(
      spaceMembers,
      and(eq(spaceMembers.spaceId, spaces.id), eq(spaceMembers.userId, a.userId)),
    )
    .where(and(eq(mailSharedInboxes.orgId, a.org.id), isNull(spaces.deletedAt)))
    .orderBy(mailSharedInboxes.name);
  const out: MailInbox[] = [];
  for (const r of rows) {
    const role = r.role as SpaceRole;
    if (!canInbox(a, role, 'mail.inbox.view')) continue;
    out.push(await inboxView(db, a, { ...r, role }));
  }
  return out;
}

export async function getInbox(deps: InboxDeps, a: InboxActor, inboxId: string) {
  return inboxView(deps.db, a, await loadInbox(deps.db, a, inboxId));
}

export async function createInbox(deps: InboxDeps, a: InboxActor, input: CreateMailInbox) {
  const [space] = await deps.db
    .select()
    .from(spaces)
    .where(and(eq(spaces.id, input.spaceId), eq(spaces.orgId, a.org.id)));
  if (!space || space.deletedAt) throw new AppError('not_found');
  const role = await spaceRoleOf(deps.db, space.id, a.userId);
  requireInbox(a, role, 'mail.inbox.manage');
  const settings = await requireSettings(deps.db, a.org.id);
  const email = input.email.toLowerCase();
  const [taken] = await deps.db
    .select({ id: mailAccounts.id })
    .from(mailAccounts)
    .where(
      and(
        eq(mailAccounts.orgId, a.org.id),
        eq(mailAccounts.kind, 'shared'),
        eq(mailAccounts.email, email),
      ),
    );
  if (taken) throw new AppError('mail_inbox_exists');
  // Without a password the inbox signs in through the org's provider afterwards (an admin with
  // access to the mailbox; Microsoft 365: Full Access to the shared mailbox).
  const password = input.password ?? null;
  if (!password && settings.authMode === 'password') {
    throw new AppError('bad_request', { reason: 'password_required' });
  }
  const username = password ? (input.username ?? loginOf(settings, email)) : email;
  if (password) await verifyImapLogin(imapAddress(settings), { user: username, pass: password });
  const { inbox, account } = await deps.db.transaction(async (tx) => {
    const [acc] = await tx
      .insert(mailAccounts)
      .values({
        orgId: a.org.id,
        userId: a.userId,
        kind: 'shared',
        email,
        username,
        displayName: input.name,
        authMode: password ? 'password' : settings.authMode,
        passwordEnc: password ? sealSecret(deps.env.AUTH_SECRET, password) : null,
        signatureHtml: input.signatureHtml
          ? sanitizeHtml(input.signatureHtml, { remoteImages: true }).html
          : '',
        notify: false,
      })
      .returning();
    const [row] = await tx
      .insert(mailSharedInboxes)
      .values({
        orgId: a.org.id,
        spaceId: space.id,
        accountId: acc!.id,
        name: input.name,
        slaFirstResponseMinutes: input.slaFirstResponseMinutes ?? null,
        createdBy: a.userId,
      })
      .returning();
    return { inbox: row!, account: acc! };
  });
  return inboxView(deps.db, a, { inbox, account, spaceName: space.name, role });
}

/** An OAuth inbox without a token yet (or whose token was refused). */
const needsSignIn = (account: MailAccountRow) =>
  account.authMode !== 'password' && (!account.oauthRefreshEnc || account.status === 'auth_failed');

/** Who may start an inbox's OAuth sign-in: its space's admins, in an org that uses OAuth. */
export async function inboxSignInStart(deps: InboxDeps, a: InboxActor, inboxId: string) {
  const l = await loadInbox(deps.db, a, inboxId);
  requireInbox(a, l.role, 'mail.inbox.manage');
  const settings = await requireSettings(deps.db, a.org.id);
  if (settings.authMode === 'password') throw new AppError('mail_auth_mode_mismatch');
  return { settings, inbox: l.inbox };
}

/**
 * Stores the token the admin got for the inbox. The token signs in to the inbox's address
 * (XOAUTH2 user = the inbox, token = the admin's): Microsoft 365 opens a shared mailbox this
 * way when the admin has Full Access to it. IMAP is tried before anything is saved.
 */
export async function inboxSignInFinish(
  deps: InboxDeps,
  a: InboxActor,
  inboxId: string,
  tokens: OauthTokens,
) {
  const { settings } = await inboxSignInStart(deps, a, inboxId);
  const l = await loadInbox(deps.db, a, inboxId);
  if (!tokens.refreshToken) throw new AppError('mail_oauth_failed', { reason: 'no_refresh_token' });
  await verifyImapLogin(imapAddress(settings), {
    user: l.account.email,
    accessToken: tokens.accessToken,
  });
  const [account] = await deps.db
    .update(mailAccounts)
    .set({
      authMode: settings.authMode,
      username: l.account.email,
      passwordEnc: null,
      oauthAccessEnc: sealSecret(deps.env.AUTH_SECRET, tokens.accessToken),
      oauthRefreshEnc: sealSecret(deps.env.AUTH_SECRET, tokens.refreshToken),
      oauthExpiresAt: tokens.expiresAt,
      oauthUser: tokens.email,
      status: 'ok',
      updatedAt: new Date(),
    })
    .where(eq(mailAccounts.id, l.account.id))
    .returning();
  closeAccountConnections(l.account.id);
  return inboxView(deps.db, a, { ...l, account: account! });
}

function loginOf(settings: MailSettingsRow, email: string) {
  return settings.usernameFormat === 'local' ? email.split('@')[0]! : email;
}

export async function updateInbox(
  deps: InboxDeps,
  a: InboxActor,
  inboxId: string,
  input: UpdateMailInbox,
) {
  const l = await loadInbox(deps.db, a, inboxId);
  requireInbox(a, l.role, 'mail.inbox.manage');
  const acc: Partial<MailAccountRow> = {};
  if (input.name !== undefined) acc.displayName = input.name;
  if (input.signatureHtml !== undefined) {
    acc.signatureHtml = sanitizeHtml(input.signatureHtml, { remoteImages: true }).html;
  }
  if (input.password !== undefined) {
    const settings = await requireSettings(deps.db, a.org.id);
    await verifyImapLogin(imapAddress(settings), {
      user: l.account.username,
      pass: input.password,
    });
    acc.passwordEnc = sealSecret(deps.env.AUTH_SECRET, input.password);
    acc.status = 'ok';
  }
  const set: Partial<InboxRow> = {};
  if (input.name !== undefined) set.name = input.name;
  if (input.slaFirstResponseMinutes !== undefined) {
    set.slaFirstResponseMinutes = input.slaFirstResponseMinutes;
  }
  await deps.db.transaction(async (tx) => {
    if (Object.keys(acc).length) {
      const [row] = await tx
        .update(mailAccounts)
        .set({ ...acc, updatedAt: new Date() })
        .where(eq(mailAccounts.id, l.account.id))
        .returning();
      l.account = row!;
    }
    if (Object.keys(set).length) {
      const [row] = await tx
        .update(mailSharedInboxes)
        .set({ ...set, updatedAt: new Date() })
        .where(eq(mailSharedInboxes.id, l.inbox.id))
        .returning();
      l.inbox = row!;
    }
  });
  if (input.password !== undefined) closeAccountConnections(l.account.id);
  return inboxView(deps.db, a, l);
}

export async function deleteInbox(deps: InboxDeps, a: InboxActor, inboxId: string) {
  const l = await loadInbox(deps.db, a, inboxId);
  requireInbox(a, l.role, 'mail.inbox.manage');
  closeAccountConnections(l.account.id);
  // The account row takes the inbox, its conversations, notes and canned responses with it.
  await deps.db.delete(mailAccounts).where(eq(mailAccounts.id, l.account.id));
  return l;
}

/* ------------------------------------- conversations ----------------------------------- */

export async function listConversations(
  deps: InboxDeps,
  a: InboxActor,
  inboxId: string,
  q: MailConversationsQuery,
) {
  const l = await loadInbox(deps.db, a, inboxId);
  const { ctx, live } = await inboxContext(deps, l);
  // Not signed in yet: nothing to read; the page asks an admin to sign it in.
  if (needsSignIn(l.account)) return { items: [], nextCursor: null };
  if (!q.cursor) await freshInbox(deps, l, ctx, live);
  const where: SQL[] = [eq(mailConversations.inboxId, l.inbox.id)];
  if (q.status !== 'all') where.push(eq(mailConversations.status, q.status));
  if (q.assignee === 'me') where.push(eq(mailConversations.assigneeId, a.userId));
  else if (q.assignee === 'none') where.push(isNull(mailConversations.assigneeId));
  else if (q.assignee) where.push(eq(mailConversations.assigneeId, q.assignee));
  if (q.tag) where.push(sql`${mailConversations.tags} @> array[${q.tag}]::text[]`);
  if (q.q) {
    const term = `%${q.q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    where.push(
      or(
        ilike(mailConversations.subject, term),
        ilike(mailConversations.customerAddress, term),
        ilike(mailConversations.customerName, term),
      )!,
    );
  }
  const cursor = parseCursor(q.cursor);
  if (cursor) {
    where.push(
      or(
        lt(mailConversations.lastMessageAt, cursor.at),
        and(eq(mailConversations.lastMessageAt, cursor.at), lt(mailConversations.id, cursor.id)),
      )!,
    );
  }
  const rows = await conversationQuery(deps.db, and(...where)!)
    .orderBy(desc(mailConversations.lastMessageAt), desc(mailConversations.id))
    .limit(q.limit + 1);
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    items: page.map((r) => summaryOf(l.inbox, r)),
    nextCursor:
      rows.length > q.limit && last ? `${last.c.lastMessageAt.toISOString()}_${last.c.id}` : null,
  };
}

function parseCursor(raw: string | undefined) {
  if (!raw) return null;
  const [iso, id] = raw.split('_');
  const at = new Date(iso ?? '');
  if (!id || Number.isNaN(at.getTime()) || !/^[0-9a-f-]{36}$/i.test(id)) {
    throw new AppError('bad_request', { reason: 'invalid_cursor' });
  }
  return { at, id };
}

async function loadConversation(db: DbOrTx, l: Loaded, conversationId: string) {
  const [row] = await conversationQuery(
    db,
    and(eq(mailConversations.id, conversationId), eq(mailConversations.inboxId, l.inbox.id))!,
  );
  if (!row) throw new AppError('not_found');
  return row;
}

/** The conversation's newest message in INBOX (what a reply answers), else in Sent. */
async function anchorOf(db: DbOrTx, l: Loaded, c: ConversationRow) {
  const sent = knownSpecial(l.account, 'sent') ?? null;
  for (const folder of sent ? [INBOX_FOLDER, sent] : [INBOX_FOLDER]) {
    const [row] = await db
      .select({ uid: mailHeaders.uid })
      .from(mailHeaders)
      .where(
        and(
          eq(mailHeaders.accountId, l.account.id),
          eq(mailHeaders.folder, folder),
          eq(mailHeaders.threadId, c.threadId),
        ),
      )
      .orderBy(desc(mailHeaders.date), desc(mailHeaders.uid))
      .limit(1);
    if (row) return { folder, uid: row.uid };
  }
  throw new AppError('mail_message_not_found');
}

async function notesOf(db: DbOrTx, conversationId: string): Promise<MailConversationNote[]> {
  const rows = await db
    .select({ n: mailConversationNotes, a: assignee })
    .from(mailConversationNotes)
    .leftJoin(users, eq(users.id, mailConversationNotes.authorId))
    .where(eq(mailConversationNotes.conversationId, conversationId))
    .orderBy(mailConversationNotes.createdAt);
  return rows.map((r) => ({
    id: r.n.id,
    author: personOf(r.a),
    body: r.n.body,
    createdAt: r.n.createdAt.toISOString(),
  }));
}

export async function getConversation(
  deps: InboxDeps,
  a: InboxActor,
  inboxId: string,
  conversationId: string,
  opts: { remoteImages: boolean },
): Promise<MailConversation> {
  const l = await loadInbox(deps.db, a, inboxId);
  const { ctx, live } = await inboxContext(deps, l);
  touchLive(live, ctx);
  const row = await loadConversation(deps.db, l, conversationId);
  const at = await anchorOf(deps.db, l, row.c);
  const thread = await getThread(live, ctx, {
    folder: at.folder,
    uid: at.uid,
    markSeen: canInbox(a, l.role, 'mail.inbox.work'),
    remoteImages: opts.remoteImages,
  });
  if (row.c.unread && thread.items.every((m) => m.seen || m.folder !== INBOX_FOLDER)) {
    await deps.db
      .update(mailConversations)
      .set({ unread: false })
      .where(eq(mailConversations.id, row.c.id));
    row.c.unread = false;
  }
  return {
    ...summaryOf(l.inbox, row),
    messages: thread.items,
    notes: await notesOf(deps.db, row.c.id),
    replying: replyingIn(row.c.id),
  };
}

export async function updateConversation(
  deps: InboxDeps,
  a: InboxActor,
  inboxId: string,
  conversationId: string,
  input: UpdateMailConversation,
) {
  const l = await loadInbox(deps.db, a, inboxId);
  requireInbox(a, l.role, 'mail.inbox.work');
  const row = await loadConversation(deps.db, l, conversationId);
  const set: Partial<ConversationRow> = { updatedAt: new Date() };
  if (input.status !== undefined && input.status !== row.c.status) {
    set.status = input.status;
    set.statusChangedAt = new Date();
  }
  if (input.tags !== undefined) set.tags = [...new Set(input.tags.map((t) => t.trim()))];
  let assigned: string | null = null;
  if (input.assigneeId !== undefined && input.assigneeId !== row.c.assigneeId) {
    if (input.assigneeId !== null) {
      const role = await spaceRoleOf(deps.db, l.inbox.spaceId, input.assigneeId);
      if (!canInbox({ ...a, userId: input.assigneeId }, role, 'mail.inbox.work')) {
        throw new AppError('mail_inbox_assignee_invalid');
      }
      assigned = input.assigneeId;
    }
    set.assigneeId = input.assigneeId;
  }
  await deps.db.update(mailConversations).set(set).where(eq(mailConversations.id, row.c.id));
  if (assigned && assigned !== a.userId) {
    await notify(deps, [
      {
        orgId: a.org.id,
        userId: assigned,
        type: 'mail.inbox.assigned',
        category: 'alert',
        actorId: a.userId,
        target: { type: 'link', id: row.c.id },
        data: {
          name: row.c.subject,
          title: row.c.subject,
          authorName: a.userName,
          excerpt: l.inbox.name,
        },
        url: `/mail/inbox/${l.inbox.id}?conversation=${row.c.id}`,
        groupKey: `mail-inbox:${row.c.id}`,
      },
    ]);
  }
  await announceInbox(deps, l.inbox, row.c.id);
  const fresh = await loadConversation(deps.db, l, row.c.id);
  return summaryOf(l.inbox, fresh);
}

export async function addNote(
  deps: InboxDeps,
  a: InboxActor,
  inboxId: string,
  conversationId: string,
  body: string,
): Promise<MailConversationNote> {
  const l = await loadInbox(deps.db, a, inboxId);
  requireInbox(a, l.role, 'mail.inbox.work');
  const row = await loadConversation(deps.db, l, conversationId);
  const [note] = await deps.db
    .insert(mailConversationNotes)
    .values({ orgId: a.org.id, conversationId: row.c.id, authorId: a.userId, body })
    .returning();
  await announceInbox(deps, l.inbox, row.c.id);
  const [me] = await deps.db.select(assignee).from(users).where(eq(users.id, a.userId));
  return {
    id: note!.id,
    author: me ? personOf(me) : null,
    body: note!.body,
    createdAt: note!.createdAt.toISOString(),
  };
}

export async function deleteNote(
  deps: InboxDeps,
  a: InboxActor,
  inboxId: string,
  conversationId: string,
  noteId: string,
) {
  const l = await loadInbox(deps.db, a, inboxId);
  requireInbox(a, l.role, 'mail.inbox.work');
  const row = await loadConversation(deps.db, l, conversationId);
  const [note] = await deps.db
    .select()
    .from(mailConversationNotes)
    .where(
      and(eq(mailConversationNotes.id, noteId), eq(mailConversationNotes.conversationId, row.c.id)),
    );
  if (!note) throw new AppError('not_found');
  // Authors remove their own notes; space admins any.
  if (note.authorId !== a.userId && !canInbox(a, l.role, 'mail.inbox.manage')) {
    throw new AppError('forbidden');
  }
  await deps.db.delete(mailConversationNotes).where(eq(mailConversationNotes.id, note.id));
  await announceInbox(deps, l.inbox, row.c.id);
}

/* ------------------------------------- "replying now" ---------------------------------- */

/** A replying mark lives this long without a new heartbeat. */
const REPLYING_TTL_MS = 15_000;
const replying = new Map<string, Map<string, { person: MailInboxPerson; until: number }>>();

function replyingIn(conversationId: string): MailInboxPerson[] {
  const marks = replying.get(conversationId);
  if (!marks) return [];
  const now = Date.now();
  for (const [id, m] of marks) if (m.until < now) marks.delete(id);
  if (marks.size === 0) replying.delete(conversationId);
  return [...marks.values()].map((m) => m.person);
}

export async function setReplying(
  deps: InboxDeps,
  a: InboxActor,
  inboxId: string,
  conversationId: string,
  active: boolean,
) {
  const l = await loadInbox(deps.db, a, inboxId);
  requireInbox(a, l.role, 'mail.inbox.work');
  const row = await loadConversation(deps.db, l, conversationId);
  const [me] = await deps.db.select(assignee).from(users).where(eq(users.id, a.userId));
  const person = me ? personOf(me) : null;
  if (!person) throw new AppError('not_found');
  const marks = replying.get(row.c.id) ?? new Map();
  const had = marks.has(a.userId) && marks.get(a.userId)!.until >= Date.now();
  if (active) {
    marks.set(a.userId, { person, until: Date.now() + REPLYING_TTL_MS });
    replying.set(row.c.id, marks);
  } else {
    marks.delete(a.userId);
    if (marks.size === 0) replying.delete(row.c.id);
  }
  // Heartbeats renew silently; others hear only a change.
  if (had !== active) {
    await announce(deps, l.inbox.spaceId, {
      type: 'mail.inbox.replying',
      inboxId: l.inbox.id,
      conversationId: row.c.id,
      user: person,
      active,
    });
  }
}

/** Tests. */
export const clearReplying = () => replying.clear();

/* ---------------------------------------- replying ------------------------------------- */

export async function replyTo(
  deps: InboxDeps,
  a: InboxActor,
  inboxId: string,
  conversationId: string,
  input: MailInboxReply,
): Promise<MailSendResult> {
  const l = await loadInbox(deps.db, a, inboxId);
  requireInbox(a, l.role, 'mail.inbox.work');
  const { ctx, live } = await inboxContext(deps, l);
  const row = await loadConversation(deps.db, l, conversationId);
  const at = await anchorOf(deps.db, l, row.c);
  const { mode, status, ...mail } = input;
  const result = await sendMessage({ ...deps, ...live }, ctx, a, {
    ...mail,
    source: { folder: at.folder, uid: at.uid, mode },
  });
  // The copy in Sent (created by this reply on a new mailbox) is cached: the first response
  // time is known.
  await syncInbox(deps, l, ctx, live);
  await refreshConversations(deps.db, l.inbox, l.account);
  const set: Partial<ConversationRow> = { updatedAt: new Date() };
  if (status && status !== row.c.status) {
    set.status = status;
    set.statusChangedAt = new Date();
  }
  if (!row.c.assigneeId) set.assigneeId = a.userId;
  await deps.db.update(mailConversations).set(set).where(eq(mailConversations.id, row.c.id));
  replying.get(row.c.id)?.delete(a.userId);
  await announceInbox(deps, l.inbox, row.c.id);
  return result;
}

/* ------------------------------------- canned responses -------------------------------- */

const cannedOf = (r: typeof mailCannedResponses.$inferSelect): MailCannedResponse => ({
  id: r.id,
  inboxId: r.inboxId,
  title: r.title,
  html: r.html,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});

export async function listCanned(db: DbOrTx, a: InboxActor, inboxId: string) {
  const l = await loadInbox(db, a, inboxId);
  const rows = await db
    .select()
    .from(mailCannedResponses)
    .where(eq(mailCannedResponses.inboxId, l.inbox.id))
    .orderBy(mailCannedResponses.title);
  return rows.map(cannedOf);
}

export async function createCanned(
  db: DbOrTx,
  a: InboxActor,
  inboxId: string,
  input: CreateMailCannedResponse,
) {
  const l = await loadInbox(db, a, inboxId);
  requireInbox(a, l.role, 'mail.inbox.work');
  const [row] = await db
    .insert(mailCannedResponses)
    .values({
      orgId: a.org.id,
      inboxId: l.inbox.id,
      title: input.title,
      html: sanitizeHtml(input.html, { remoteImages: true }).html,
      createdBy: a.userId,
    })
    .returning();
  return cannedOf(row!);
}

async function loadCanned(db: DbOrTx, l: Loaded, cannedId: string) {
  const [row] = await db
    .select()
    .from(mailCannedResponses)
    .where(and(eq(mailCannedResponses.id, cannedId), eq(mailCannedResponses.inboxId, l.inbox.id)));
  if (!row) throw new AppError('not_found');
  return row;
}

export async function updateCanned(
  db: DbOrTx,
  a: InboxActor,
  inboxId: string,
  cannedId: string,
  input: UpdateMailCannedResponse,
) {
  const l = await loadInbox(db, a, inboxId);
  requireInbox(a, l.role, 'mail.inbox.work');
  const row = await loadCanned(db, l, cannedId);
  const [updated] = await db
    .update(mailCannedResponses)
    .set({
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.html !== undefined
        ? { html: sanitizeHtml(input.html, { remoteImages: true }).html }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(mailCannedResponses.id, row.id))
    .returning();
  return cannedOf(updated!);
}

export async function deleteCanned(db: DbOrTx, a: InboxActor, inboxId: string, cannedId: string) {
  const l = await loadInbox(db, a, inboxId);
  requireInbox(a, l.role, 'mail.inbox.work');
  const row = await loadCanned(db, l, cannedId);
  await db.delete(mailCannedResponses).where(eq(mailCannedResponses.id, row.id));
}

export async function inboxTags(db: DbOrTx, a: InboxActor, inboxId: string) {
  const l = await loadInbox(db, a, inboxId);
  const rows = await db.execute<{ tag: string }>(sql`
    select distinct unnest(${mailConversations.tags}) as tag from ${mailConversations}
    where ${mailConversations.inboxId} = ${l.inbox.id} order by 1 limit 200`);
  return rows.rows.map((r) => r.tag);
}

/** Mailbox context of an inbox the caller may read (attachments, saving to Drive). */
export async function inboxMailbox(deps: InboxDeps, a: InboxActor, inboxId: string) {
  const l = await loadInbox(deps.db, a, inboxId);
  return (await inboxContext(deps, l)).ctx;
}
