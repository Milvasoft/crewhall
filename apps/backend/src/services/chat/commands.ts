import { and, asc, eq, isNull, lte, sql } from 'drizzle-orm';
import {
  chatPolls,
  chatPollVotes,
  chatReminders,
  conversations,
  messages,
  newId,
  type DbOrTx,
} from '@crewhall/db';
import {
  REMINDER_LIMITS,
  type ChatReminder,
  type CreateChatReminder,
  type CreatePoll,
  type Message,
  paths,
} from '@crewhall/shared';
import type { Deps } from '../../deps';
import { AppError } from '../../http/errors';
import { notify, type NotifyDeps } from '../notifications/notify';
import {
  permissionsOf,
  requireMember,
  requireMessage,
  requirePermission,
  type ChatActor,
  type MessageRow,
} from './access';
import { afterWrite, existingByClientId, isUnique, publishMessage, writeMessage } from './messages';
import { chatEnabled } from './module';
import { toMessage } from './views';

/**
 * Slash commands with their own data (roadmap 23): `/poll` and `/remind`. `/me` and
 * `/whisper` are message flags (sendMessage); `/meet` uses the meet module's endpoints.
 */

// ---- /poll --------------------------------------------------------------------------

export async function createPoll(
  deps: Deps,
  a: ChatActor,
  conversationId: string,
  input: CreatePoll,
): Promise<Message> {
  const { db } = deps;
  const m = await requireMember(db, a, conversationId);
  const existing = await existingByClientId(db, a.userId, input.clientMsgId);
  if (existing) {
    if (existing.conversationId !== conversationId || !existing.body.poll) {
      throw new AppError('conflict', { reason: 'client_msg_id_used' });
    }
    return toMessage(db, a.userId, existing);
  }
  requirePermission(a, m, 'write');
  const pollId = newId();
  let result: Awaited<ReturnType<typeof writeMessage>>;
  try {
    result = await db.transaction(async (tx) => {
      const written = await writeMessage(deps, tx, m, {
        authorId: a.userId,
        kind: 'user',
        text: input.question,
        clientMsgId: input.clientMsgId,
        pollId,
      });
      await tx.insert(chatPolls).values({
        id: pollId,
        orgId: a.org.id,
        conversationId,
        messageId: written.msg.id,
        question: input.question,
        options: input.options,
        multiple: input.multiple,
        createdBy: a.userId,
      });
      return written;
    });
  } catch (err) {
    if (isUnique(err, 'messages_author_client_uq')) {
      const first = await existingByClientId(db, a.userId, input.clientMsgId);
      if (first) return toMessage(db, a.userId, first);
    }
    throw err;
  }
  await afterWrite(deps, m.conv, result.msg, result.notes);
  return toMessage(db, a.userId, result.msg);
}

/** The poll with its message, if the caller can see that message. */
async function requirePoll(db: DbOrTx, a: ChatActor, pollId: string) {
  const [poll] = await db
    .select()
    .from(chatPolls)
    .where(and(eq(chatPolls.id, pollId), eq(chatPolls.orgId, a.org.id)));
  if (!poll) throw new AppError('not_found');
  const { msg, m } = await requireMessage(db, a, poll.messageId);
  if (msg.deletedAt) throw new AppError('not_found');
  return { poll, msg, m };
}

/** Bumps the message so `?updatedAfter=` catch-up sees the change, then tells everyone. */
async function touchAndPublish(deps: Deps, a: ChatActor, msg: MessageRow, convId: string) {
  const [row] = await deps.db
    .update(messages)
    .set({ updatedAt: new Date() })
    .where(eq(messages.id, msg.id))
    .returning();
  const conv = (await requireMember(deps.db, a, convId)).conv;
  await publishMessage(deps, conv, 'message.updated', row!);
  return toMessage(deps.db, a.userId, row!);
}

export async function votePoll(deps: Deps, a: ChatActor, pollId: string, options: number[]) {
  const { db } = deps;
  const { poll, msg, m } = await requirePoll(db, a, pollId);
  if (!m.isMember || m.conv.archivedAt) throw new AppError('forbidden');
  if (poll.closedAt) throw new AppError('conflict', { reason: 'poll_closed' });
  const chosen = [...new Set(options)];
  if (chosen.some((o) => o >= poll.options.length) || (!poll.multiple && chosen.length > 1)) {
    throw new AppError('validation_failed', {
      in: 'body',
      issues: [{ path: ['options'], code: 'invalid_value', message: 'invalid poll option' }],
    });
  }
  await db.transaction(async (tx) => {
    await tx
      .delete(chatPollVotes)
      .where(and(eq(chatPollVotes.pollId, poll.id), eq(chatPollVotes.userId, a.userId)));
    if (chosen.length) {
      await tx
        .insert(chatPollVotes)
        .values(
          chosen.map((option) => ({ pollId: poll.id, userId: a.userId, option, orgId: a.org.id })),
        );
    }
  });
  return touchAndPublish(deps, a, msg, m.conv.id);
}

export async function closePoll(deps: Deps, a: ChatActor, pollId: string) {
  const { db } = deps;
  const { poll, msg, m } = await requirePoll(db, a, pollId);
  if (poll.createdBy !== a.userId && !permissionsOf(a, m).moderate) {
    throw new AppError('forbidden');
  }
  if (poll.closedAt) throw new AppError('conflict', { reason: 'poll_closed' });
  await db
    .update(chatPolls)
    .set({ closedAt: new Date(), updatedAt: new Date() })
    .where(eq(chatPolls.id, poll.id));
  return touchAndPublish(deps, a, msg, m.conv.id);
}

// ---- /remind ------------------------------------------------------------------------

type ReminderRow = typeof chatReminders.$inferSelect;

const toReminder = (r: ReminderRow): ChatReminder => ({
  id: r.id,
  conversationId: r.conversationId,
  text: r.text,
  remindAt: r.remindAt.toISOString(),
  firedAt: r.firedAt?.toISOString() ?? null,
  createdAt: r.createdAt.toISOString(),
});

/** Small slack for clocks: a time up to a minute ago still counts as "now". */
const PAST_SLACK_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

export async function createReminder(db: DbOrTx, a: ChatActor, input: CreateChatReminder) {
  await requireMember(db, a, input.conversationId);
  const at = new Date(input.remindAt);
  const now = Date.now();
  if (at.getTime() < now - PAST_SLACK_MS || at.getTime() > now + REMINDER_LIMITS.maxDays * DAY_MS) {
    throw new AppError('validation_failed', {
      in: 'body',
      issues: [{ path: ['remindAt'], code: 'too_small', message: 'reminder time out of range' }],
    });
  }
  const [n] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(chatReminders)
    .where(
      and(
        eq(chatReminders.orgId, a.org.id),
        eq(chatReminders.userId, a.userId),
        isNull(chatReminders.firedAt),
      ),
    );
  if ((n?.n ?? 0) >= REMINDER_LIMITS.pending) {
    throw new AppError('conflict', { reason: 'too_many_reminders' });
  }
  const [row] = await db
    .insert(chatReminders)
    .values({
      orgId: a.org.id,
      userId: a.userId,
      conversationId: input.conversationId,
      text: input.text,
      remindAt: at,
    })
    .returning();
  return toReminder(row!);
}

export async function listReminders(db: DbOrTx, a: ChatActor) {
  const rows = await db
    .select()
    .from(chatReminders)
    .where(
      and(
        eq(chatReminders.orgId, a.org.id),
        eq(chatReminders.userId, a.userId),
        isNull(chatReminders.firedAt),
      ),
    )
    .orderBy(asc(chatReminders.remindAt));
  return rows.map(toReminder);
}

export async function deleteReminder(db: DbOrTx, a: ChatActor, reminderId: string) {
  const del = await db
    .delete(chatReminders)
    .where(
      and(
        eq(chatReminders.id, reminderId),
        eq(chatReminders.orgId, a.org.id),
        eq(chatReminders.userId, a.userId),
      ),
    )
    .returning({ id: chatReminders.id });
  if (del.length === 0) throw new AppError('not_found');
}

/**
 * chat.reminders job (every minute): claims due reminders (UPDATE … RETURNING, so two
 * workers never fire the same one) and notifies their owners. Orgs with chat off skip.
 */
export async function fireDueReminders(deps: NotifyDeps, now: Date = new Date()) {
  const due = await deps.db
    .update(chatReminders)
    .set({ firedAt: now, updatedAt: now })
    .where(and(isNull(chatReminders.firedAt), lte(chatReminders.remindAt, now)))
    .returning();
  let sent = 0;
  for (const r of due) {
    try {
      if (!(await chatEnabled(deps.db, r.orgId))) continue;
      const [conv] = await deps.db
        .select({ name: conversations.name, type: conversations.type })
        .from(conversations)
        .where(eq(conversations.id, r.conversationId));
      await notify(deps, [
        {
          orgId: r.orgId,
          userId: r.userId,
          type: 'chat.reminder',
          category: 'mention',
          actorId: null,
          // No target.conversationId: reading the chat must not clear the reminder.
          target: { type: 'conversation', id: r.conversationId },
          data: {
            text: r.text,
            excerpt: r.text,
            conversationTitle: conv?.name ?? null,
            conversationType: conv?.type ?? null,
          },
          url: paths.chatConversation(r.conversationId),
        },
      ]);
      sent++;
    } catch (err) {
      deps.logger.warn({ err, reminderId: r.id }, 'reminder notification failed');
    }
  }
  return sent;
}
