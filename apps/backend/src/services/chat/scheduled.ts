import { and, asc, eq, inArray, lt, lte, sql } from 'drizzle-orm';
import { conversations, nodes, scheduledMessages, type DbOrTx } from '@crewhall/db';
import {
  SCHEDULE_LIMITS,
  type ErrorCode,
  type CreateScheduledMessage,
  type ScheduledMessage,
  type UpdateScheduledMessage,
  paths,
} from '@crewhall/shared';
import type { Deps } from '../../deps';
import { AppError } from '../../http/errors';
import { actorFor } from '../boards/collab';
import { notify } from '../notifications/notify';
import { requireMember, requireMessage, requirePermission, type ChatActor } from './access';
import { isFederated } from '../federation/chat';
import { attachableNodes, sendMessage } from './messages';
import { checkRefs } from './refs';
import { excerpt } from './text';

/**
 * Scheduled messages ("Daha sonra gönder", `/zamanla`). Checked like a message now, and again
 * when due: the author must still be an active member who may write there; otherwise the
 * row fails and the author is told. Posted with the row id as clientMsgId, so a retried job
 * never posts twice.
 */

type Row = typeof scheduledMessages.$inferSelect;

const DAY_MS = 24 * 60 * 60 * 1000;
/** A time a minute in the past still counts as "now" (clock skew, slow typing). */
const PAST_SLACK_MS = 60_000;
/** A claim older than this is a crashed worker: the row goes back to scheduled. */
const STUCK_MS = 5 * 60_000;

async function toViews(db: DbOrTx, rows: Row[]): Promise<ScheduledMessage[]> {
  const ids = [...new Set(rows.flatMap((r) => r.attachmentNodeIds))];
  const files = ids.length
    ? await db
        .select({
          id: nodes.id,
          name: nodes.name,
          mime: nodes.mime,
          sizeBytes: nodes.sizeBytes,
          deletedAt: nodes.deletedAt,
        })
        .from(nodes)
        .where(inArray(nodes.id, ids))
    : [];
  const byId = new Map(files.map((f) => [f.id, f]));
  return rows.map((r) => ({
    id: r.id,
    conversationId: r.conversationId,
    text: r.text,
    replyToId: r.replyToId,
    attachments: r.attachmentNodeIds.flatMap((id) => {
      const f = byId.get(id);
      return f
        ? [
            {
              nodeId: f.id,
              name: f.name,
              mime: f.mime,
              sizeBytes: f.sizeBytes,
              preview: 'none' as const,
              removed: f.deletedAt !== null,
            },
          ]
        : [];
    }),
    refs: r.refs,
    sendAt: r.sendAt.toISOString(),
    // "sending" is internal: still waiting from the outside.
    status: r.status === 'sending' ? 'scheduled' : r.status,
    error: r.error,
    messageId: r.messageId,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }));
}

const toView = async (db: DbOrTx, row: Row) => (await toViews(db, [row]))[0]!;

function checkTime(sendAt: string) {
  const at = new Date(sendAt);
  const now = Date.now();
  if (at.getTime() < now - PAST_SLACK_MS || at.getTime() > now + SCHEDULE_LIMITS.maxDays * DAY_MS) {
    throw new AppError('validation_failed', {
      in: 'body',
      issues: [{ path: ['sendAt'], code: 'too_small', message: 'send time out of range' }],
    });
  }
  return at;
}

async function queue(deps: Pick<Deps, 'jobs'>, row: Row) {
  const seconds = Math.max(1, Math.ceil((row.sendAt.getTime() - Date.now()) / 1000));
  await deps.jobs.send('chat.scheduled', { id: row.id }, { startAfterSeconds: seconds });
}

/** One of the caller's own rows. */
async function requireOwn(db: DbOrTx, a: ChatActor, id: string) {
  const [row] = await db
    .select()
    .from(scheduledMessages)
    .where(
      and(
        eq(scheduledMessages.id, id),
        eq(scheduledMessages.orgId, a.org.id),
        eq(scheduledMessages.authorId, a.userId),
      ),
    );
  if (!row) throw new AppError('not_found');
  return row;
}

const requirePending = (row: Row) => {
  if (row.status !== 'scheduled') throw new AppError('conflict', { reason: 'not_scheduled' });
};

export async function listScheduled(db: DbOrTx, a: ChatActor, conversationId: string) {
  await requireMember(db, a, conversationId);
  const rows = await db
    .select()
    .from(scheduledMessages)
    .where(
      and(
        eq(scheduledMessages.conversationId, conversationId),
        eq(scheduledMessages.authorId, a.userId),
        inArray(scheduledMessages.status, ['scheduled', 'sending']),
      ),
    )
    .orderBy(asc(scheduledMessages.sendAt));
  return toViews(db, rows);
}

export async function createScheduled(
  deps: Deps,
  a: ChatActor,
  conversationId: string,
  input: CreateScheduledMessage,
) {
  const { db } = deps;
  const m = await requireMember(db, a, conversationId);
  requirePermission(a, m, 'write');
  if (!input.text.trim() && input.attachmentNodeIds.length === 0 && !input.refs?.length) {
    throw new AppError('validation_failed', {
      in: 'body',
      issues: [{ path: ['text'], code: 'too_small', message: 'empty message' }],
    });
  }
  const sendAt = checkTime(input.sendAt);
  if (input.replyToId) {
    const r = await requireMessage(db, a, input.replyToId);
    if (r.msg.conversationId !== conversationId || r.msg.whisperTo) {
      throw new AppError('invalid_target');
    }
  }
  await attachableNodes(db, a, input.attachmentNodeIds);
  if (input.refs?.length && (await isFederated(db, conversationId))) {
    throw new AppError('invalid_target', { reason: 'refs_in_federated_chat' });
  }
  const refs = await checkRefs(db, a, input.refs);
  const [n] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(scheduledMessages)
    .where(
      and(
        eq(scheduledMessages.orgId, a.org.id),
        eq(scheduledMessages.authorId, a.userId),
        eq(scheduledMessages.status, 'scheduled'),
      ),
    );
  if ((n?.n ?? 0) >= SCHEDULE_LIMITS.pending) {
    throw new AppError('conflict', { reason: 'too_many_scheduled', max: SCHEDULE_LIMITS.pending });
  }
  const [row] = await db
    .insert(scheduledMessages)
    .values({
      orgId: a.org.id,
      conversationId,
      authorId: a.userId,
      text: input.text,
      replyToId: input.replyToId ?? null,
      attachmentNodeIds: input.attachmentNodeIds,
      refs,
      confirmMentionAll: input.confirmMentionAll === true,
      sendAt,
    })
    .returning();
  await queue(deps, row!);
  return toView(db, row!);
}

export async function updateScheduled(
  deps: Deps,
  a: ChatActor,
  id: string,
  input: UpdateScheduledMessage,
) {
  const { db } = deps;
  const row = await requireOwn(db, a, id);
  requirePending(row);
  const text = input.text ?? row.text;
  if (!text.trim() && row.attachmentNodeIds.length === 0 && row.refs.length === 0) {
    throw new AppError('validation_failed', {
      in: 'body',
      issues: [{ path: ['text'], code: 'too_small', message: 'empty message' }],
    });
  }
  const sendAt = input.sendAt !== undefined ? checkTime(input.sendAt) : row.sendAt;
  const [next] = await db
    .update(scheduledMessages)
    .set({ text, sendAt })
    .where(and(eq(scheduledMessages.id, row.id), eq(scheduledMessages.status, 'scheduled')))
    .returning();
  if (!next) throw new AppError('conflict', { reason: 'not_scheduled' });
  if (input.sendAt !== undefined) await queue(deps, next);
  return toView(db, next);
}

export async function cancelScheduled(db: DbOrTx, a: ChatActor, id: string) {
  const row = await requireOwn(db, a, id);
  requirePending(row);
  const done = await db
    .update(scheduledMessages)
    .set({ status: 'cancelled' })
    .where(and(eq(scheduledMessages.id, row.id), eq(scheduledMessages.status, 'scheduled')))
    .returning({ id: scheduledMessages.id });
  if (done.length === 0) throw new AppError('conflict', { reason: 'not_scheduled' });
}

/** "Şimdi gönder". */
export async function sendScheduledNow(deps: Deps, a: ChatActor, id: string) {
  const row = await requireOwn(deps.db, a, id);
  requirePending(row);
  const result = await deliver(deps, row.id, { force: true });
  if (result.status === 'sent' && result.message) return result.message;
  if (result.status === 'failed') throw new AppError(result.code);
  throw new AppError('conflict', { reason: 'not_scheduled' });
}

/** Errors that mean "can't post here any more" (the row fails); others are retried. */
const REASONS: Record<string, string> = {
  not_found: 'not_member',
  forbidden: 'not_allowed',
  chat_archived: 'archived',
  invalid_target: 'invalid_target',
  validation_failed: 'invalid',
  chat_mention_all_confirm: 'mention_all',
  chat_ref_no_access: 'not_allowed',
};

/**
 * Posts one row if it is (still) scheduled and due (`force`: now regardless of the time).
 * Claims it first, so a job and the sweep never post it twice.
 */
export async function deliver(deps: Deps, id: string, opts: { force?: boolean } = {}) {
  const { db } = deps;
  const [row] = await db
    .update(scheduledMessages)
    .set({ status: 'sending' })
    .where(
      and(
        eq(scheduledMessages.id, id),
        eq(scheduledMessages.status, 'scheduled'),
        opts.force ? undefined : lte(scheduledMessages.sendAt, sql`now()`),
      ),
    )
    .returning();
  if (!row) return { status: 'skipped' as const };
  const actor = await actorFor(db, row.authorId, row.orgId);
  if (!actor) return fail(deps, row, 'not_member', 'not_found');
  try {
    const message = await sendMessage(deps, actor, row.conversationId, {
      clientMsgId: row.id,
      text: row.text,
      replyToId: row.replyToId ?? undefined,
      attachmentNodeIds: row.attachmentNodeIds,
      refs: row.refs,
      confirmMentionAll: row.confirmMentionAll,
    });
    await db
      .update(scheduledMessages)
      .set({ status: 'sent', messageId: message.id, error: null })
      .where(eq(scheduledMessages.id, row.id));
    return { status: 'sent' as const, message };
  } catch (err) {
    const code = err instanceof AppError ? err.code : null;
    const reason = code ? REASONS[code] : undefined;
    if (code && reason) return fail(deps, row, reason, code);
    // Database or network trouble: back in the queue for the next sweep.
    await db
      .update(scheduledMessages)
      .set({ status: 'scheduled' })
      .where(eq(scheduledMessages.id, row.id));
    throw err;
  }
}

async function fail(deps: Deps, row: Row, reason: string, code: ErrorCode) {
  const { db } = deps;
  await db
    .update(scheduledMessages)
    .set({ status: 'failed', error: reason })
    .where(eq(scheduledMessages.id, row.id));
  const [conv] = await db
    .select({ name: conversations.name, type: conversations.type })
    .from(conversations)
    .where(eq(conversations.id, row.conversationId));
  try {
    await notify(deps, [
      {
        orgId: row.orgId,
        userId: row.authorId,
        type: 'chat.scheduled_failed',
        category: 'mention',
        actorId: null,
        target: { type: 'conversation', id: row.conversationId },
        data: {
          excerpt: excerpt(row.text, new Map(), 140),
          reason,
          conversationTitle: conv?.name ?? null,
          conversationType: conv?.type ?? null,
        },
        url: paths.chatConversation(row.conversationId),
      },
    ]);
  } catch (err) {
    deps.logger.warn({ err, scheduledId: row.id }, 'scheduled message failure notice failed');
  }
  return { status: 'failed' as const, code, reason };
}

/**
 * chat.scheduled_sweep (every minute): rows whose job was lost, and claims a crashed
 * worker left behind. The per-row chat.scheduled job does the on-time work.
 */
export async function deliverDue(deps: Deps, now: Date = new Date()) {
  const { db } = deps;
  await db
    .update(scheduledMessages)
    .set({ status: 'scheduled' })
    .where(
      and(
        eq(scheduledMessages.status, 'sending'),
        lt(scheduledMessages.updatedAt, new Date(now.getTime() - STUCK_MS)),
      ),
    );
  const due = await db
    .select({ id: scheduledMessages.id })
    .from(scheduledMessages)
    .where(and(eq(scheduledMessages.status, 'scheduled'), lte(scheduledMessages.sendAt, now)))
    .orderBy(asc(scheduledMessages.sendAt))
    .limit(500);
  let sent = 0;
  for (const { id } of due) {
    try {
      const r = await deliver(deps, id, { force: true });
      if (r.status === 'sent') sent++;
    } catch (err) {
      deps.logger.warn({ err, scheduledId: id }, 'scheduled message delivery failed');
    }
  }
  return sent;
}
