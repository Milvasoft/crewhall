import { and, desc, eq, inArray, isNotNull, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { notifications, type DbOrTx } from '@crewhall/db';
import type { NotificationSource } from '@crewhall/shared';
import { AppError } from '../../http/errors';
import { userTopic, type Bus } from '../../realtime/bus';
import { sourceOf, toNotifications, unreadCount, visibleInbox } from './notify';

/** Notification centre (design 19.17, 2.10). Rows are kept 90 days. */

export const RETENTION_DAYS = 90;

const SOURCE_TYPES: Record<NotificationSource, SQL> = {
  chat: sql`${notifications.type} like 'chat.%' and ${notifications.type} not in ('chat.alert', 'chat.webhook_failing')`,
  pages: sql`(${notifications.type} like 'page.%' or ${notifications.type} like 'wiki.%')`,
  boards: sql`(${notifications.type} like 'board.%' or ${notifications.type} like 'boards.%')`,
  meetings: sql`(${notifications.type} like 'meet.%' or ${notifications.type} like 'meeting.%')`,
  drive: sql`(${notifications.type} like 'drive.%' or ${notifications.type} like 'space.%')`,
  vault: sql`${notifications.type} like 'vault.%'`,
  alerts: sql`(${notifications.type} in ('chat.alert', 'chat.webhook_failing') or ${notifications.type} like 'link.%' or ${notifications.type} like 'plugin.%')`,
  account: sql`${notifications.category} in ('security', 'portal')`,
  announcements: sql`${notifications.type} like 'announcement.%'`,
};

interface Cursor {
  t: string;
  id: string;
}
const encode = (c: Cursor) => Buffer.from(JSON.stringify(c)).toString('base64url');
function decode(s: string): Cursor {
  try {
    const c = JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as Cursor;
    if (typeof c.t === 'string' && typeof c.id === 'string') return c;
  } catch {
    // fall through
  }
  throw new AppError('bad_request', { reason: 'invalid_cursor' });
}

export async function listNotifications(
  db: DbOrTx,
  orgId: string,
  userId: string,
  q: {
    box: 'inbox' | 'snoozed' | 'dismissed';
    source?: NotificationSource | undefined;
    kind?: 'mentions' | 'assigned' | 'alerts' | undefined;
    unreadOnly?: boolean | undefined;
    cursor?: string | undefined;
    limit: number;
  },
) {
  const where: SQL[] = [eq(notifications.orgId, orgId), eq(notifications.userId, userId)];
  if (q.box === 'inbox') where.push(visibleInbox(orgId, userId)!);
  if (q.box === 'snoozed') {
    where.push(isNull(notifications.dismissedAt), sql`${notifications.snoozedUntil} > now()`);
  }
  if (q.box === 'dismissed') where.push(isNotNull(notifications.dismissedAt));
  if (q.source) where.push(SOURCE_TYPES[q.source]);
  if (q.kind === 'mentions') where.push(eq(notifications.category, 'mention'));
  if (q.kind === 'assigned') where.push(sql`${notifications.type} like '%.assigned'`);
  if (q.kind === 'alerts') where.push(SOURCE_TYPES.alerts);
  if (q.unreadOnly) where.push(isNull(notifications.readAt));
  if (q.cursor) {
    const c = decode(q.cursor);
    where.push(
      or(
        lt(notifications.updatedAt, new Date(c.t)),
        and(eq(notifications.updatedAt, new Date(c.t)), lt(notifications.id, c.id)),
      )!,
    );
  }
  const rows = await db
    .select()
    .from(notifications)
    .where(and(...where))
    .orderBy(desc(notifications.updatedAt), desc(notifications.id))
    .limit(q.limit + 1);
  const page = rows.slice(0, q.limit);
  const last = page.at(-1);
  return {
    items: await toNotifications(db, page),
    nextCursor:
      rows.length > q.limit && last
        ? encode({ t: last.updatedAt.toISOString(), id: last.id })
        : null,
  };
}

export async function notificationCounts(db: DbOrTx, orgId: string, userId: string) {
  const rows = await db
    .select({ type: notifications.type, category: notifications.category })
    .from(notifications)
    .where(and(visibleInbox(orgId, userId), isNull(notifications.readAt)));
  const bySource: Record<NotificationSource, number> = {
    chat: 0,
    pages: 0,
    boards: 0,
    meetings: 0,
    drive: 0,
    vault: 0,
    alerts: 0,
    account: 0,
    announcements: 0,
  };
  for (const r of rows) bySource[sourceOf(r.type, r.category)] += 1;
  const [snoozed] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(notifications)
    .where(
      and(
        eq(notifications.orgId, orgId),
        eq(notifications.userId, userId),
        isNull(notifications.dismissedAt),
        sql`${notifications.snoozedUntil} > now()`,
      ),
    );
  return { unread: rows.length, snoozed: snoozed?.n ?? 0, bySource };
}

export async function updateNotifications(
  db: DbOrTx,
  bus: Bus,
  orgId: string,
  userId: string,
  input: {
    ids?: string[] | undefined;
    all?: boolean | undefined;
    action: 'read' | 'unread' | 'snooze' | 'dismiss' | 'restore';
    until?: string | undefined;
  },
) {
  const scope = input.all
    ? and(visibleInbox(orgId, userId), isNull(notifications.readAt))
    : and(
        eq(notifications.orgId, orgId),
        eq(notifications.userId, userId),
        inArray(notifications.id, input.ids ?? []),
      );
  const now = new Date();
  const set =
    input.action === 'read'
      ? { readAt: now }
      : input.action === 'unread'
        ? { readAt: null }
        : input.action === 'snooze'
          ? // Back in the inbox as unread when the time comes (19.17).
            { snoozedUntil: new Date(input.until!), readAt: null }
          : input.action === 'dismiss'
            ? { dismissedAt: now }
            : { dismissedAt: null, snoozedUntil: null };
  await db
    .update(notifications)
    .set({ ...set, updatedAt: now })
    .where(scope);
  await publishCount(db, bus, orgId, userId);
  return notificationCounts(db, orgId, userId);
}

/** Notifications about a conversation up to `seq` are read once the conversation is. */
export async function readConversationNotifications(
  db: DbOrTx,
  bus: Bus,
  orgId: string,
  userId: string,
  conversationId: string,
  seq: number,
) {
  const done = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notifications.orgId, orgId),
        eq(notifications.userId, userId),
        eq(notifications.conversationId, conversationId),
        isNull(notifications.readAt),
        or(isNull(notifications.seq), sql`${notifications.seq} <= ${seq}`),
      ),
    )
    .returning({ id: notifications.id });
  if (done.length) await publishCount(db, bus, orgId, userId);
}

export async function publishCount(db: DbOrTx, bus: Bus, orgId: string, userId: string) {
  bus.publish(userTopic(userId), {
    type: 'notifications.changed',
    unreadCount: await unreadCount(db, orgId, userId),
  });
}

export async function purgeOldNotifications(db: DbOrTx) {
  await db
    .delete(notifications)
    .where(lt(notifications.updatedAt, sql`now() - make_interval(days => ${RETENTION_DAYS})`));
}
