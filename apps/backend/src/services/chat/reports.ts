import { and, desc, eq, inArray, isNull, lt, or } from 'drizzle-orm';
import {
  chatReports,
  conversations,
  messages,
  notifications,
  orgMembers,
  users,
  type DbOrTx,
} from '@crewhall/db';
import {
  can,
  paths,
  withQuery,
  type ChatReport,
  type ChatReportReceipt,
  type ChatReportStatus,
  type CreateChatReport,
  type ListChatReportsQuery,
  type UserSummary,
} from '@crewhall/shared';
import type { Deps } from '../../deps';
import { AppError } from '../../http/errors';
import { audit } from '../audit';
import { orgContext, toActor } from '../membership';
import { notify } from '../notifications/notify';
import { requireMessage, type ChatActor } from './access';
import { userCard } from './status';
import { excerpt, mentionedIds } from './text';

/**
 * "Yöneticiye bildir" (Play user-generated content policy): people report a message or a person
 * to their own org's owners and admins, who see the reports in Yönetim › Bildirilen içerik.
 * Crewhall itself does not moderate: there is no global queue and no blocking.
 */

type ReportRow = typeof chatReports.$inferSelect;

/** Long enough for any real message; the admin page clamps it. */
const EXCERPT_MAX = 4000;

const NOTIFY_TYPE = 'chat.report';

function requireReviewer(a: ChatActor) {
  if (!can(a.actor, 'chat.review_reports', { type: 'org', org: orgContext(a.org) })) {
    throw new AppError('forbidden');
  }
}

const receipt = (r: Pick<ReportRow, 'id' | 'status'>): ChatReportReceipt => ({
  id: r.id,
  status: r.status,
});

/** The caller's own open report on the same thing: reporting twice does not notify twice. */
async function openReportOf(
  db: DbOrTx,
  a: ChatActor,
  where: { messageId: string } | { userId: string },
) {
  const [row] = await db
    .select()
    .from(chatReports)
    .where(
      and(
        eq(chatReports.orgId, a.org.id),
        eq(chatReports.reporterId, a.userId),
        eq(chatReports.status, 'open'),
        'messageId' in where
          ? eq(chatReports.messageId, where.messageId)
          : and(eq(chatReports.kind, 'user'), eq(chatReports.reportedUserId, where.userId)),
      ),
    );
  return row ?? null;
}

export async function reportMessage(
  deps: Deps,
  a: ChatActor,
  messageId: string,
  input: CreateChatReport,
): Promise<ChatReportReceipt> {
  const { db } = deps;
  // The same rule as reading it: 404 for a message the caller cannot see.
  const { msg } = await requireMessage(db, a, messageId);
  if (msg.deletedAt || msg.kind === 'system') throw new AppError('not_found');
  if (msg.authorId === a.userId) throw new AppError('chat_report_self');
  const existing = await openReportOf(db, a, { messageId: msg.id });
  if (existing) return receipt(existing);

  const nameIds = mentionedIds([msg.text]);
  const people = nameIds.length
    ? await db
        .select({ id: users.id, name: users.name })
        .from(users)
        .where(inArray(users.id, nameIds))
    : [];
  const text = excerpt(msg.text, new Map(people.map((p) => [p.id, p.name])), EXCERPT_MAX);
  const [row] = await db
    .insert(chatReports)
    .values({
      orgId: a.org.id,
      kind: 'message',
      reporterId: a.userId,
      reportedUserId: msg.authorId,
      messageId: msg.id,
      conversationId: msg.conversationId,
      messageSeq: msg.seq,
      excerpt: text,
      reason: input.reason,
      note: input.note || null,
    })
    .returning();
  await afterCreate(deps, a, row!);
  return receipt(row!);
}

export async function reportUser(
  deps: Deps,
  a: ChatActor,
  userId: string,
  input: CreateChatReport,
): Promise<ChatReportReceipt> {
  const { db } = deps;
  if (userId === a.userId) throw new AppError('chat_report_self');
  const [member] = await db
    .select({ userId: orgMembers.userId })
    .from(orgMembers)
    .where(and(eq(orgMembers.organizationId, a.org.id), eq(orgMembers.userId, userId)));
  if (!member) throw new AppError('member_not_found');
  // Guests only reach the people they share a conversation with (the person card's rule).
  if (a.actor.orgRole === 'guest') await userCard(deps, a, userId);
  const existing = await openReportOf(db, a, { userId });
  if (existing) return receipt(existing);
  const [row] = await db
    .insert(chatReports)
    .values({
      orgId: a.org.id,
      kind: 'user',
      reporterId: a.userId,
      reportedUserId: userId,
      reason: input.reason,
      note: input.note || null,
    })
    .returning();
  await afterCreate(deps, a, row!);
  return receipt(row!);
}

/** Owners and admins of the org (who `can` review reports), except `except`. */
async function reviewerIds(db: DbOrTx, a: ChatActor, except: string) {
  const rows = await db
    .select()
    .from(orgMembers)
    .where(and(eq(orgMembers.organizationId, a.org.id), eq(orgMembers.status, 'active')));
  const org = orgContext(a.org);
  return rows
    .filter(
      (r) =>
        r.userId !== except &&
        can(toActor(r), 'chat.review_reports', { type: 'org', org }),
    )
    .map((r) => r.userId);
}

async function afterCreate(deps: Deps, a: ChatActor, row: ReportRow) {
  await audit(deps.db, {
    orgId: a.org.id,
    actorId: a.userId,
    action: 'chat.report.create',
    targetType: 'chat_report',
    targetId: row.id,
    meta: {
      kind: row.kind,
      reason: row.reason,
      reportedUserId: row.reportedUserId,
      messageId: row.messageId,
    },
  });
  const ids = [a.userId, ...(row.reportedUserId ? [row.reportedUserId] : [])];
  const people = await deps.db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(inArray(users.id, ids));
  const names = new Map(people.map((p) => [p.id, p.name]));
  const admins = await reviewerIds(deps.db, a, a.userId);
  if (admins.length === 0) return;
  // The message's words stay out of the notification (and the lock screen): admins read
  // them on the reports page.
  await notify(
    deps,
    admins.map((userId) => ({
      orgId: a.org.id,
      userId,
      type: NOTIFY_TYPE,
      category: 'alert' as const,
      actorId: a.userId,
      target: { type: 'report' as const, id: row.id },
      data: {
        kind: row.kind,
        reason: row.reason,
        actorName: names.get(a.userId) ?? '',
        name: (row.reportedUserId && names.get(row.reportedUserId)) || '',
      },
      url: paths.admin('reports'),
    })),
  ).catch((err: unknown) => deps.logger.warn({ err }, 'chat report notification failed'));
}

// ---- Admin side ----------------------------------------------------------------------

function decodeCursor(cursor: string | undefined) {
  if (!cursor) return null;
  try {
    const c = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      t: string;
      id: string;
    };
    if (typeof c.t !== 'string' || typeof c.id !== 'string') throw new Error('cursor');
    return c;
  } catch {
    throw new AppError('bad_request', { reason: 'invalid_cursor' });
  }
}

export async function listReports(db: DbOrTx, a: ChatActor, q: ListChatReportsQuery) {
  requireReviewer(a);
  const cursor = decodeCursor(q.cursor);
  const rows = await db
    .select()
    .from(chatReports)
    .where(
      and(
        eq(chatReports.orgId, a.org.id),
        q.status ? eq(chatReports.status, q.status) : undefined,
        cursor
          ? or(
              lt(chatReports.createdAt, new Date(cursor.t)),
              and(eq(chatReports.createdAt, new Date(cursor.t)), lt(chatReports.id, cursor.id)),
            )
          : undefined,
      ),
    )
    .orderBy(desc(chatReports.createdAt), desc(chatReports.id))
    .limit(q.limit + 1);
  const pageRows = rows.slice(0, q.limit);
  const last = pageRows.at(-1);
  return {
    items: await toReports(db, pageRows),
    nextCursor:
      rows.length > q.limit && last
        ? Buffer.from(JSON.stringify({ t: last.createdAt.toISOString(), id: last.id })).toString(
            'base64url',
          )
        : null,
  };
}

export async function resolveReport(
  db: DbOrTx,
  a: ChatActor,
  reportId: string,
  status: ChatReportStatus,
): Promise<ChatReport> {
  requireReviewer(a);
  const closing = status !== 'open';
  const [row] = await db
    .update(chatReports)
    .set({
      status,
      resolvedBy: closing ? a.userId : null,
      resolvedAt: closing ? new Date() : null,
    })
    .where(and(eq(chatReports.id, reportId), eq(chatReports.orgId, a.org.id)))
    .returning();
  if (!row) throw new AppError('not_found');
  await audit(db, {
    orgId: a.org.id,
    actorId: a.userId,
    action: 'chat.report.resolve',
    targetType: 'chat_report',
    targetId: row.id,
    meta: { status },
  });
  // A closed report leaves every admin's bell.
  if (closing) {
    await db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(notifications.orgId, a.org.id),
          eq(notifications.type, NOTIFY_TYPE),
          eq(notifications.targetId, row.id),
          isNull(notifications.readAt),
        ),
      );
  }
  const [report] = await toReports(db, [row]);
  return report!;
}

async function toReports(db: DbOrTx, rows: ReportRow[]): Promise<ChatReport[]> {
  if (rows.length === 0) return [];
  const userIds = [
    ...new Set(
      rows.flatMap((r) => [r.reporterId, r.reportedUserId, r.resolvedBy]).filter((x) => x !== null),
    ),
  ];
  const people = userIds.length
    ? await db
        .select({ id: users.id, name: users.name, email: users.email, image: users.image })
        .from(users)
        .where(inArray(users.id, userIds))
    : [];
  const byId = new Map<string, UserSummary>(
    people.map((p) => [p.id, { id: p.id, name: p.name, email: p.email, imageUrl: p.image }]),
  );
  const convIds = [...new Set(rows.map((r) => r.conversationId).filter((x) => x !== null))];
  const convs = convIds.length
    ? await db
        .select({ id: conversations.id, type: conversations.type, name: conversations.name })
        .from(conversations)
        .where(inArray(conversations.id, convIds))
    : [];
  const convById = new Map(convs.map((c) => [c.id, c]));
  const msgIds = [...new Set(rows.map((r) => r.messageId).filter((x) => x !== null))];
  const msgs = msgIds.length
    ? await db
        .select({ id: messages.id, deletedAt: messages.deletedAt })
        .from(messages)
        .where(inArray(messages.id, msgIds))
    : [];
  const deletedById = new Map(msgs.map((m) => [m.id, m.deletedAt !== null]));
  const user = (id: string | null) => (id ? (byId.get(id) ?? null) : null);

  return rows.map((r) => {
    const conv = r.conversationId ? convById.get(r.conversationId) : undefined;
    const deleted = r.messageId === null || !conv || (deletedById.get(r.messageId) ?? true);
    return {
      id: r.id,
      kind: r.kind,
      status: r.status,
      reason: r.reason,
      note: r.note,
      reporter: user(r.reporterId),
      reportedUser: user(r.reportedUserId),
      message:
        r.kind === 'message'
          ? {
              id: r.messageId,
              conversationId: conv ? conv.id : null,
              conversationType: conv?.type ?? null,
              conversationTitle: conv && conv.type !== 'direct' ? (conv.name ?? null) : null,
              seq: r.messageSeq,
              excerpt: r.excerpt ?? '',
              deleted,
              url:
                conv && r.messageSeq !== null && !deleted
                  ? withQuery(paths.chatConversation(conv.id), { seq: r.messageSeq })
                  : null,
            }
          : null,
      resolvedBy: user(r.resolvedBy),
      resolvedAt: r.resolvedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    };
  });
}
