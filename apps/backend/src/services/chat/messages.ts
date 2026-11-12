import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, sql, type SQL } from 'drizzle-orm';
import {
  conversationMembers,
  conversations,
  federationReactions,
  mentions,
  messageAttachments,
  messages,
  nodes,
  reactions,
  readMarks,
  readStates,
  type DbOrTx,
  type Tx,
  type MessageBodyData,
} from '@crewhall/db';
import { archiveHeldMessage } from '../compliance/holds';
import { checkDlp } from '../compliance/policy';
import {
  CHAT_LIMITS,
  isReactionEmoji,
  type AlertCard,
  type Message,
  type MessageGif,
  type MessageRef,
  type MessagePage,
  type SystemEvent,
} from '@crewhall/shared';
import type { Deps } from '../../deps';
import { auditVia } from '../audit';
import { AppError } from '../../http/errors';
import { publishToUsers } from '../../realtime/bus';
import { readConversationNotifications } from '../notifications/center';
import {
  createNotifications,
  deliverNotifications,
  type NotificationRow,
} from '../notifications/notify';
import {
  audienceOf,
  historyFrom,
  memberIds,
  permissionsOf,
  requireMember,
  requireMessage,
  requirePermission,
  type ChatActor,
  type ConversationRow,
  type Membership,
  type MessageRow,
  whisperVisible,
} from './access';
import { messageNotifications } from './notify-rules';
import { checkMessageGif } from './gif';
import { checkRefs } from './refs';
import { parseMentions } from './text';
import { toMessage, toMessages, unreadCounts, usersById } from './views';
import {
  federateDelete,
  federateEdit,
  federateMessage,
  federateReaction,
  isFederated,
} from '../federation/chat';
import { emitPluginEvent } from '../plugins/events';

const UNIQUE_VIOLATION = '23505';
export const isUnique = (err: unknown, constraint: string) => {
  const e = err as {
    code?: string;
    constraint?: string;
    cause?: { code?: string; constraint?: string };
  };
  const c = e.cause ?? e;
  return c.code === UNIQUE_VIOLATION && c.constraint === constraint;
};

/**
 * The next seq of a conversation (doc 17 §6): one UPDATE … RETURNING in the writing
 * transaction; the row lock queues concurrent writers, so the order is exact.
 */
export async function nextSeq(tx: DbOrTx, conversationId: string) {
  const [row] = await tx
    .update(conversations)
    .set({
      lastSeq: sql`${conversations.lastSeq} + 1`,
      lastMessageAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(eq(conversations.id, conversationId))
    .returning({ seq: conversations.lastSeq });
  return row!.seq;
}

/** A system line in the flow (renamed, members added, pinned…). */
export async function appendSystem(tx: DbOrTx, conv: ConversationRow, event: SystemEvent) {
  const seq = await nextSeq(tx, conv.id);
  const [row] = await tx
    .insert(messages)
    .values({
      orgId: conv.orgId,
      conversationId: conv.id,
      seq,
      kind: 'system',
      authorId: null,
      body: { system: event as unknown as Record<string, unknown> },
      text: '',
    })
    .returning();
  return row!;
}

/** Publish a new or changed message to everyone in the conversation. */
export async function publishMessage(
  deps: Pick<Deps, 'db' | 'bus'>,
  conv: ConversationRow,
  type: 'message.created' | 'message.updated',
  row: MessageRow,
) {
  // Reactions' `mine` is per person; events carry the shared view (use userIds).
  const message = await toMessage(deps.db, '', row);
  const ids = await audienceOf(deps.db, conv, row);
  publishToUsers(deps.bus, ids, { type, conversationId: conv.id, message });
  return message;
}

export async function listMessages(
  db: DbOrTx,
  a: ChatActor,
  conversationId: string,
  q: {
    afterSeq?: number | undefined;
    beforeSeq?: number | undefined;
    aroundSeq?: number | undefined;
    updatedAfter?: string | undefined;
    limit: number;
  },
): Promise<MessagePage> {
  const m = await requireMember(db, a, conversationId);
  const from = Math.max(historyFrom(m), 1);
  const base = and(
    eq(messages.conversationId, conversationId),
    gte(messages.seq, from),
    whisperVisible(a.userId),
  );
  let rows: MessageRow[];
  let moreAfter: boolean | null = null;
  if (q.updatedAfter !== undefined) {
    const found = await db
      .select()
      .from(messages)
      .where(and(base, gt(messages.updatedAt, new Date(q.updatedAfter))))
      .orderBy(asc(messages.updatedAt), asc(messages.seq))
      .limit(q.limit + 1);
    moreAfter = found.length > q.limit;
    rows = found.slice(0, q.limit).sort((x, y) => x.seq - y.seq);
  } else if (q.afterSeq !== undefined) {
    rows = await db
      .select()
      .from(messages)
      .where(and(base, gt(messages.seq, q.afterSeq)))
      .orderBy(asc(messages.seq))
      .limit(q.limit);
  } else if (q.aroundSeq !== undefined) {
    const half = Math.max(1, Math.floor(q.limit / 2));
    const before = await db
      .select()
      .from(messages)
      .where(and(base, lt(messages.seq, q.aroundSeq)))
      .orderBy(desc(messages.seq))
      .limit(half);
    const after = await db
      .select()
      .from(messages)
      .where(and(base, gte(messages.seq, q.aroundSeq)))
      .orderBy(asc(messages.seq))
      .limit(q.limit - before.length);
    rows = [...before.reverse(), ...after];
  } else {
    const where = q.beforeSeq !== undefined ? and(base, lt(messages.seq, q.beforeSeq)) : base;
    rows = (
      await db.select().from(messages).where(where).orderBy(desc(messages.seq)).limit(q.limit)
    ).reverse();
  }
  // Seqs are contiguous (a rolled-back write rolls its seq back too), except for others'
  // whispers: past the page's ends, look for a message this person may see.
  const first = rows[0]?.seq;
  const last = rows.at(-1)?.seq;
  const anyVisible = async (cond: SQL) =>
    (await db.select({ seq: messages.seq }).from(messages).where(and(base, cond)).limit(1)).length >
    0;
  return {
    items: await toMessages(db, a.userId, rows),
    hasMoreBefore:
      first !== undefined ? first > from && (await anyVisible(lt(messages.seq, first))) : false,
    hasMoreAfter:
      moreAfter ??
      (last !== undefined
        ? last < m.conv.lastSeq && (await anyVisible(gt(messages.seq, last)))
        : false),
    lastSeq: m.conv.lastSeq,
  };
}

interface SendInput {
  /** Send anyway after 409 dlp_warning. */
  dlpAck?: boolean | undefined;
  clientMsgId: string;
  text: string;
  replyToId?: string | undefined;
  attachmentNodeIds: string[];
  confirmMentionAll?: boolean | undefined;
  emote?: boolean | undefined;
  whisperTo?: string | undefined;
  gif?: MessageGif | undefined;
  refs?: MessageRef[] | undefined;
}

export async function existingByClientId(db: DbOrTx, userId: string, clientMsgId: string) {
  const [row] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.authorId, userId), eq(messages.clientMsgId, clientMsgId)));
  return row ?? null;
}

/** Validates attachments: files the sender uploaded, alive, in this org. */
export async function attachableNodes(db: DbOrTx, a: ChatActor, ids: string[]) {
  if (ids.length === 0) return [];
  const rows = await db
    .select()
    .from(nodes)
    .where(
      and(
        eq(nodes.orgId, a.org.id),
        inArray(nodes.id, ids),
        isNull(nodes.deletedAt),
        eq(nodes.type, 'file'),
        eq(nodes.createdBy, a.userId),
      ),
    );
  if (rows.length !== new Set(ids).size) throw new AppError('invalid_target');
  return ids.map((id) => rows.find((r) => r.id === id)!);
}

/**
 * Mention rows: the written ones plus one per person reached. @all / @here only in
 * conversations of 3+ people; from 20 on they need `confirmMentionAll`.
 */
function resolveMentions(
  text: string,
  members: string[],
  authorId: string | null,
  online: (ids: string[]) => string[],
  confirm: boolean,
  allowBroadcast: boolean,
) {
  const parsed = parseMentions(text);
  const memberSet = new Set(members);
  const users = parsed.userIds.filter((id) => memberSet.has(id) && id !== authorId);
  const others = members.filter((id) => id !== authorId);
  const all = parsed.all && allowBroadcast && members.length >= 3;
  const here = parsed.here && allowBroadcast && members.length >= 3;
  if ((all || here) && members.length >= CHAT_LIMITS.mentionAllConfirmMembers && !confirm) {
    throw new AppError('chat_mention_all_confirm', { members: members.length });
  }
  const notified = new Map<string, 'user' | 'all' | 'here'>();
  for (const id of users) notified.set(id, 'user');
  if (all) for (const id of others) if (!notified.has(id)) notified.set(id, 'all');
  if (here) for (const id of online(others)) if (!notified.has(id)) notified.set(id, 'here');
  return { users, all, here, notified };
}

async function insertMentions(tx: DbOrTx, row: MessageRow, m: ReturnType<typeof resolveMentions>) {
  const values: (typeof mentions.$inferInsert)[] = [];
  const base = {
    orgId: row.orgId,
    messageId: row.id,
    conversationId: row.conversationId,
    seq: row.seq,
  };
  for (const [userId, kind] of m.notified) {
    values.push({ ...base, kind, userId: kind === 'user' ? userId : null, notifiedUserId: userId });
  }
  if (m.all) values.push({ ...base, kind: 'all', userId: null, notifiedUserId: null });
  if (m.here) values.push({ ...base, kind: 'here', userId: null, notifiedUserId: null });
  if (values.length) await tx.insert(mentions).values(values);
}

export async function markReadTx(
  tx: DbOrTx,
  orgId: string,
  convId: string,
  userId: string,
  seq: number,
) {
  const [prev] = await tx
    .select({ seq: readStates.lastReadSeq })
    .from(readStates)
    .where(and(eq(readStates.conversationId, convId), eq(readStates.userId, userId)));
  const from = prev?.seq ?? 0;
  // The stretch read now and when ("Mesaj bilgisi": who saw a message, first when).
  if (seq > from) {
    await tx
      .insert(readMarks)
      .values({ orgId, conversationId: convId, userId, fromSeq: from, toSeq: seq });
  }
  await tx
    .insert(readStates)
    .values({ orgId, conversationId: convId, userId, lastReadSeq: seq })
    .onConflictDoUpdate({
      target: [readStates.conversationId, readStates.userId],
      set: {
        lastReadSeq: sql`greatest(${readStates.lastReadSeq}, ${seq})`,
        // Reading (or writing) ends a "marked unread".
        markedUnread: false,
        updatedAt: sql`now()`,
      },
    });
}

/**
 * A message written inside an MCP tool call or an approval it waits on carries `via` (the
 * same auditVia the audit rows get), so chat can mark it "Claude ile".
 */
function messageVia(): { via?: NonNullable<MessageBodyData['via']> } {
  const v = auditVia.getStore();
  if (!v || !['mcp', 'api', 'plugin'].includes(String(v.kind)) || typeof v.client !== 'string') {
    return {};
  }
  return {
    via: {
      kind: String(v.kind),
      client: v.client,
      grant: typeof v.grant === 'string' ? v.grant : null,
      token: typeof v.token === 'string' ? v.token : null,
    },
  };
}

/** Writes a message (user or webhook) with its seq, mentions and notifications. */
export async function writeMessage(
  deps: Deps,
  tx: Tx,
  m: Membership,
  input: {
    authorId: string | null;
    webhookId?: string | null;
    kind: 'user' | 'webhook';
    text: string;
    card?: AlertCard | null;
    clientMsgId?: string | null;
    replyTo?: MessageRow | null;
    attachments?: { id: string }[];
    confirmMentionAll?: boolean;
    silent?: boolean;
    /** Federation: the remote author (authorId is then null). */
    remote?: NonNullable<MessageBodyData['remote']>;
    /** A meeting guest (authorId is then null). */
    guest?: NonNullable<MessageBodyData['guest']>;
    emote?: boolean;
    whisperTo?: string | null;
    pollId?: string;
    gif?: MessageGif;
    /** Internal references, checked by the caller (ids only). */
    refs?: MessageRef[];
    /** Automation bot messages (kind webhook, no webhook row). */
    automation?: NonNullable<MessageBodyData['automation']>;
  },
) {
  const conv = m.conv;
  const all = await memberIds(tx, conv);
  // A whisper reaches (and may mention) only its pair.
  const whisperTo = input.whisperTo ?? null;
  const members = whisperTo ? all.filter((id) => id === whisperTo || id === input.authorId) : all;
  const mention = resolveMentions(
    input.text,
    members,
    input.authorId,
    (ids) => deps.presence.onlineUserIds(ids),
    input.confirmMentionAll === true,
    input.kind === 'user' && !whisperTo,
  );
  const seq = await nextSeq(tx, conv.id);
  const [row] = await tx
    .insert(messages)
    .values({
      orgId: conv.orgId,
      conversationId: conv.id,
      seq,
      kind: input.kind,
      authorId: input.authorId,
      webhookId: input.webhookId ?? null,
      body: {
        ...(input.card ? { card: input.card as unknown as Record<string, unknown> } : {}),
        ...(input.automation ? { automation: input.automation } : {}),
        ...(input.emote ? { emote: true } : {}),
        ...(input.pollId ? { poll: input.pollId } : {}),
        ...(input.gif ? { gif: input.gif } : {}),
        ...(input.refs?.length ? { refs: input.refs } : {}),
        ...messageVia(),
        ...(input.remote ? { remote: input.remote } : {}),
        ...(input.guest ? { guest: input.guest } : {}),
      },
      text: input.text,
      replyToId: input.replyTo?.id ?? null,
      clientMsgId: input.clientMsgId ?? null,
      whisperTo,
    })
    .returning();
  const msg = row!;
  if (input.attachments?.length) {
    await tx.insert(messageAttachments).values(
      input.attachments.map((n, position) => ({
        messageId: msg.id,
        nodeId: n.id,
        orgId: conv.orgId,
        conversationId: conv.id,
        position,
      })),
    );
  }
  await insertMentions(tx, msg, mention);
  if (input.authorId) await markReadTx(tx, conv.orgId, conv.id, input.authorId, seq);
  const notes = input.silent
    ? []
    : await createNotifications(
        tx,
        await messageNotifications(tx, conv, msg, {
          members,
          mentioned: mention.notified,
          replyTo: input.replyTo ?? null,
          card: input.card ?? null,
        }),
        deps.presence,
      );
  return { msg, notes };
}

export async function afterWrite(
  deps: Deps,
  conv: ConversationRow,
  msg: MessageRow,
  notes: NotificationRow[],
) {
  const fresh = { ...conv, lastSeq: msg.seq, lastMessageAt: msg.createdAt };
  await publishMessage(deps, fresh, 'message.created', msg);
  if (msg.authorId) await publishOwnRead(deps, conv.orgId, conv.id, msg.authorId, msg.seq);
  await deliverNotifications(deps, notes);
}

export async function sendMessage(
  deps: Deps,
  a: ChatActor,
  conversationId: string,
  input: SendInput,
): Promise<Message> {
  const { db } = deps;
  const m = await requireMember(db, a, conversationId);
  const existing = await existingByClientId(db, a.userId, input.clientMsgId);
  if (existing) {
    if (existing.conversationId !== conversationId) {
      throw new AppError('conflict', { reason: 'client_msg_id_used' });
    }
    return toMessage(db, a.userId, existing);
  }
  requirePermission(a, m, 'write');
  const text = input.text.trim();
  await checkDlp(
    db,
    {
      orgId: a.org.id,
      actorId: a.userId,
      surface: 'chat',
      ack: input.dlpAck,
      targetType: 'conversation',
      targetId: conversationId,
    },
    text,
  );
  const commandText = input.emote === true || input.whisperTo !== undefined;
  if (input.gif) await checkMessageGif(db, a.org.id, input.gif);
  // A chat shared with another installation: its people could not open the item.
  if (input.refs?.length && (await isFederated(db, conversationId))) {
    throw new AppError('invalid_target', { reason: 'refs_in_federated_chat' });
  }
  const refs = await checkRefs(db, a, input.refs);
  if (
    !text &&
    !input.gif &&
    !refs.length &&
    (input.attachmentNodeIds.length === 0 || commandText)
  ) {
    throw new AppError('validation_failed', {
      in: 'body',
      issues: [{ path: ['text'], code: 'too_small', message: 'empty message' }],
    });
  }
  const whisperTo = input.whisperTo ?? null;
  if (whisperTo) await checkWhisper(db, a, m.conv, whisperTo, input.attachmentNodeIds.length);
  let replyTo: MessageRow | null = null;
  if (input.replyToId) {
    const r = await requireMessage(db, a, input.replyToId);
    if (r.msg.conversationId !== conversationId) throw new AppError('invalid_target');
    // A whisper is answered only by a whisper between the same two people.
    if (r.msg.whisperTo) {
      const pair = new Set([r.msg.whisperTo, r.msg.authorId]);
      if (!whisperTo || !pair.has(whisperTo) || !pair.has(a.userId)) {
        throw new AppError('invalid_target');
      }
    }
    replyTo = r.msg;
  }
  const files = await attachableNodes(db, a, input.attachmentNodeIds);
  let result: Awaited<ReturnType<typeof writeMessage>>;
  try {
    result = await db.transaction((tx) =>
      writeMessage(deps, tx, m, {
        authorId: a.userId,
        kind: 'user',
        text: input.text,
        clientMsgId: input.clientMsgId,
        replyTo,
        attachments: files,
        confirmMentionAll: input.confirmMentionAll === true,
        emote: input.emote === true,
        whisperTo,
        ...(input.gif ? { gif: input.gif } : {}),
        ...(refs.length ? { refs } : {}),
      }),
    );
  } catch (err) {
    // The same clientMsgId raced in: answer with the first message.
    if (isUnique(err, 'messages_author_client_uq')) {
      const first = await existingByClientId(db, a.userId, input.clientMsgId);
      if (first) return toMessage(db, a.userId, first);
    }
    throw err;
  }
  await afterWrite(deps, m.conv, result.msg, result.notes);
  await federateMessage(deps, m.conv, result.msg);
  // Plugins (event subscriptions): ids only, never for direct chats.
  if (m.conv.type !== 'direct') {
    await emitPluginEvent(deps, m.conv.orgId, 'message.created', {
      conversationId: m.conv.id,
      conversationType: m.conv.type,
      messageId: result.msg.id,
      authorId: result.msg.authorId,
      createdAt: result.msg.createdAt.toISOString(),
    });
  }
  return toMessage(db, a.userId, result.msg);
}

/** A whisper goes to another member of a conversation with more than two people. */
async function checkWhisper(
  db: DbOrTx,
  a: ChatActor,
  conv: ConversationRow,
  whisperTo: string,
  attachments: number,
) {
  if (conv.type === 'direct' || whisperTo === a.userId || attachments > 0) {
    throw new AppError('invalid_target');
  }
  if (!(await memberIds(db, conv)).includes(whisperTo)) throw new AppError('invalid_target');
}

export async function updateMessage(
  deps: Deps,
  a: ChatActor,
  messageId: string,
  text: string,
  dlpAck?: boolean,
) {
  const { db } = deps;
  const { msg, m } = await requireMessage(db, a, messageId);
  if (msg.authorId !== a.userId || msg.deletedAt || msg.kind !== 'user' || msg.body.poll) {
    throw new AppError('chat_message_not_editable');
  }
  requirePermission(a, m, 'write');
  await checkDlp(
    db,
    {
      orgId: a.org.id,
      actorId: a.userId,
      surface: 'chat',
      ack: dlpAck,
      targetType: 'message',
      targetId: msg.id,
    },
    text,
  );
  await archiveHeldMessage(db, 'edit', msg);
  const members = await audienceOf(db, m.conv, msg);
  const before = new Set(
    (
      await db
        .select({ id: mentions.notifiedUserId })
        .from(mentions)
        .where(eq(mentions.messageId, msg.id))
    ).map((r) => r.id),
  );
  const { row, notes } = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(messages)
      .set({ text, editedAt: new Date() })
      .where(eq(messages.id, msg.id))
      .returning();
    const mention = resolveMentions(
      text,
      members,
      a.userId,
      (ids) => deps.presence.onlineUserIds(ids),
      true,
      !msg.whisperTo,
    );
    await tx.delete(mentions).where(eq(mentions.messageId, msg.id));
    await insertMentions(tx, row!, mention);
    // Only people newly mentioned by the edit are notified.
    const fresh = new Map([...mention.notified].filter(([id]) => !before.has(id)));
    const notes = await createNotifications(
      tx,
      (
        await messageNotifications(tx, m.conv, row!, {
          members,
          mentioned: fresh,
          replyTo: null,
          card: null,
        })
      ).filter((n) => n.category === 'mention'),
      deps.presence,
    );
    return { row: row!, notes };
  });
  await publishMessage(deps, m.conv, 'message.updated', row);
  await deliverNotifications(deps, notes);
  await federateEdit(deps, m.conv, row);
  return toMessage(db, a.userId, row);
}

export async function deleteMessage(deps: Deps, a: ChatActor, messageId: string) {
  const { db } = deps;
  const { msg, m } = await requireMessage(db, a, messageId);
  if (msg.deletedAt) return toMessage(db, a.userId, msg);
  const own = msg.authorId === a.userId && msg.kind === 'user';
  const perms = permissionsOf(a, m);
  if (!own && !perms.moderate) throw new AppError('chat_message_not_editable');
  await archiveHeldMessage(db, 'delete', msg);
  const row = await removeMessage(deps, m.conv, msg, a.userId);
  await federateDelete(deps, m.conv, msg);
  return toMessage(db, a.userId, row);
}

/**
 * Deletes a message for everyone here: text, reactions and mentions go, attachments go to
 * the Drive trash. `deletedBy` is null for a delete from another installation (federation).
 */
export async function removeMessage(
  deps: Deps,
  conv: ConversationRow,
  msg: MessageRow,
  deletedBy: string | null,
) {
  const { db } = deps;
  const now = new Date();
  const row = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(messages)
      .set({
        deletedAt: now,
        deletedBy,
        text: '',
        // A remote message keeps its origin: a late retry of it is not written again.
        body: {
          ...(msg.body.remote ? { remote: msg.body.remote } : {}),
          ...(msg.body.guest ? { guest: msg.body.guest } : {}),
        },
        pinnedAt: null,
        pinnedBy: null,
      })
      .where(eq(messages.id, msg.id))
      .returning();
    await tx.delete(mentions).where(eq(mentions.messageId, msg.id));
    await tx.delete(reactions).where(eq(reactions.messageId, msg.id));
    await tx.delete(federationReactions).where(eq(federationReactions.messageId, msg.id));
    // Attachments go to the Drive trash with the message (design 04 rules).
    const files = await tx
      .select({ nodeId: messageAttachments.nodeId })
      .from(messageAttachments)
      .where(eq(messageAttachments.messageId, msg.id));
    if (files.length) {
      await tx
        .update(nodes)
        .set({ deletedAt: now, deletedBy })
        .where(
          and(
            inArray(
              nodes.id,
              files.map((f) => f.nodeId),
            ),
            isNull(nodes.deletedAt),
          ),
        );
    }
    return row!;
  });
  const ids = await audienceOf(db, conv, msg);
  publishToUsers(deps.bus, ids, {
    type: 'message.deleted',
    conversationId: conv.id,
    messageId: msg.id,
    seq: msg.seq,
    deletedAt: now.toISOString(),
  });
  // Messages quoting it now read "Bu mesaj silindi".
  const quoting = await db
    .select()
    .from(messages)
    .where(and(eq(messages.replyToId, msg.id), isNull(messages.deletedAt)))
    .limit(50);
  for (const q of quoting) await publishMessage(deps, conv, 'message.updated', q);
  return row;
}

const MAX_EMOJIS_PER_MESSAGE = 50;

export async function react(
  deps: Deps,
  a: ChatActor,
  messageId: string,
  emoji: string,
  add: boolean,
) {
  const { db } = deps;
  // Only a real emoji can be added; a bad one already stored can still be taken back (S1).
  if (add && !isReactionEmoji(emoji)) throw new AppError('chat_invalid_reaction');
  const { msg, m } = await requireMessage(db, a, messageId);
  if (msg.deletedAt) throw new AppError('chat_message_not_editable');
  if (!m.isMember || m.conv.archivedAt) throw new AppError('forbidden');
  let changed: boolean;
  if (add) {
    const [n] = await db
      .select({ n: sql<number>`count(distinct ${reactions.emoji})::int` })
      .from(reactions)
      .where(eq(reactions.messageId, msg.id));
    if ((n?.n ?? 0) >= MAX_EMOJIS_PER_MESSAGE)
      throw new AppError('conflict', { reason: 'too_many_reactions' });
    const ins = await db
      .insert(reactions)
      .values({ messageId: msg.id, userId: a.userId, emoji, orgId: a.org.id })
      .onConflictDoNothing()
      .returning();
    changed = ins.length > 0;
  } else {
    const del = await db
      .delete(reactions)
      .where(
        and(
          eq(reactions.messageId, msg.id),
          eq(reactions.userId, a.userId),
          eq(reactions.emoji, emoji),
        ),
      )
      .returning();
    changed = del.length > 0;
  }
  let row = msg;
  if (changed) {
    [row] = (await db
      .update(messages)
      .set({ updatedAt: new Date() })
      .where(eq(messages.id, msg.id))
      .returning()) as [MessageRow];
    const ids = await audienceOf(db, m.conv, msg);
    publishToUsers(deps.bus, ids, {
      type: 'reaction',
      conversationId: m.conv.id,
      messageId: msg.id,
      emoji,
      userId: a.userId,
      added: add,
    });
    await federateReaction(deps, m.conv, msg, a.userId, emoji, add);
  }
  return toMessage(db, a.userId, row);
}

export async function setPinned(deps: Deps, a: ChatActor, messageId: string, pinned: boolean) {
  const { db } = deps;
  const { msg, m } = await requireMessage(db, a, messageId);
  requirePermission(a, m, 'pin');
  if (msg.deletedAt || msg.kind === 'system' || msg.whisperTo) {
    throw new AppError('invalid_target');
  }
  if (pinned === (msg.pinnedAt !== null)) return toMessage(db, a.userId, msg);
  const result = await db.transaction(async (tx) => {
    if (pinned) {
      const [n] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(messages)
        .where(and(eq(messages.conversationId, m.conv.id), sql`${messages.pinnedAt} is not null`));
      if ((n?.n ?? 0) >= CHAT_LIMITS.pinnedMessages) throw new AppError('chat_pin_limit');
    }
    const [row] = await tx
      .update(messages)
      .set(
        pinned ? { pinnedAt: new Date(), pinnedBy: a.userId } : { pinnedAt: null, pinnedBy: null },
      )
      .where(eq(messages.id, msg.id))
      .returning();
    const line = pinned
      ? await appendSystem(tx, m.conv, {
          type: 'message_pinned',
          actorId: a.userId,
          messageId: msg.id,
        })
      : null;
    return { row: row!, line };
  });
  await publishMessage(deps, m.conv, 'message.updated', result.row);
  if (result.line) await publishMessage(deps, m.conv, 'message.created', result.line);
  return toMessage(db, a.userId, result.row);
}

/**
 * "Ben bakıyorum" on a webhook card: anyone who can write takes it (or takes it over); letting
 * go is for the one who took it or a moderator. Everyone sees it through message.updated.
 */
export async function setClaim(deps: Deps, a: ChatActor, messageId: string, claimed: boolean) {
  const { db } = deps;
  const { msg, m } = await requireMessage(db, a, messageId);
  requirePermission(a, m, 'write');
  if (msg.deletedAt || msg.kind !== 'webhook') throw new AppError('invalid_target');
  const current = msg.body.claim ?? null;
  if (claimed && current?.userId === a.userId) return toMessage(db, a.userId, msg);
  if (!claimed) {
    if (!current) return toMessage(db, a.userId, msg);
    if (current.userId !== a.userId && !permissionsOf(a, m).moderate) {
      throw new AppError('forbidden');
    }
  }
  const { claim: _old, ...rest } = msg.body;
  const body = claimed
    ? { ...rest, claim: { userId: a.userId, at: new Date().toISOString() } }
    : rest;
  const [row] = await db
    .update(messages)
    .set({ body, updatedAt: new Date() })
    .where(eq(messages.id, msg.id))
    .returning();
  await publishMessage(deps, m.conv, 'message.updated', row!);
  return toMessage(db, a.userId, row!);
}

export async function listPinned(db: DbOrTx, a: ChatActor, conversationId: string) {
  const m = await requireMember(db, a, conversationId);
  const rows = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        gte(messages.seq, historyFrom(m)),
        sql`${messages.pinnedAt} is not null`,
        isNull(messages.deletedAt),
      ),
    )
    .orderBy(desc(messages.pinnedAt));
  const views = await toMessages(db, a.userId, rows);
  const pinners = await usersById(
    db,
    rows.map((r) => r.pinnedBy).filter((v): v is string => !!v),
  );
  return rows.map((r, i) => ({
    message: views[i]!,
    pinnedBy: r.pinnedBy ? (pinners.get(r.pinnedBy) ?? null) : null,
    pinnedAt: r.pinnedAt!.toISOString(),
  }));
}

// ---- Read state ----------------------------------------------------------------------

async function readResult(db: DbOrTx, userId: string, conversationId: string) {
  const [r] = await db
    .select({ seq: readStates.lastReadSeq })
    .from(readStates)
    .where(and(eq(readStates.conversationId, conversationId), eq(readStates.userId, userId)));
  const { unread, mentions: men } = await unreadCounts(db, userId, [conversationId]);
  return {
    conversationId,
    lastReadSeq: r?.seq ?? 0,
    unread: unread.get(conversationId) ?? 0,
    unreadMentions: men.get(conversationId) ?? 0,
  };
}

/** Own devices get the counts; others the position, when both have receipts on. */
async function publishOwnRead(
  deps: Pick<Deps, 'db' | 'bus'>,
  orgId: string,
  conversationId: string,
  userId: string,
  _seq: number,
) {
  const r = await readResult(deps.db, userId, conversationId);
  publishToUsers(deps.bus, [userId], { type: 'read', userId, ...r });
  return r;
}

async function publishRead(deps: Deps, conv: ConversationRow, userId: string) {
  const r = await publishOwnRead(deps, conv.orgId, conv.id, userId, 0);
  // Reads are always shared: there is no hiding (user decision; readReceipts is ignored).
  const ids = (await memberIds(deps.db, conv)).filter((id) => id !== userId);
  publishToUsers(deps.bus, ids, {
    type: 'read',
    conversationId: conv.id,
    userId,
    lastReadSeq: r.lastReadSeq,
  });
  return r;
}

export async function markRead(deps: Deps, a: ChatActor, conversationId: string, seq: number) {
  const { db } = deps;
  const m = await requireMember(db, a, conversationId);
  const capped = Math.min(seq, m.conv.lastSeq);
  await markReadTx(db, a.org.id, conversationId, a.userId, capped);
  await db
    .update(mentions)
    .set({ seenAt: new Date() })
    .where(
      and(
        eq(mentions.conversationId, conversationId),
        eq(mentions.notifiedUserId, a.userId),
        isNull(mentions.seenAt),
        sql`${mentions.seq} <= ${capped}`,
      ),
    );
  const r = await publishRead(deps, m.conv, a.userId);
  await readConversationNotifications(
    db,
    deps.bus,
    a.org.id,
    a.userId,
    conversationId,
    r.lastReadSeq,
  );
  return r;
}

/** "Okunmadı olarak işaretle": the only way the read position moves back. */
export async function markUnread(
  deps: Deps,
  a: ChatActor,
  conversationId: string,
  fromSeq: number,
) {
  const { db } = deps;
  const m = await requireMember(db, a, conversationId);
  const seq = Math.max(0, Math.min(fromSeq, m.conv.lastSeq + 1) - 1);
  await db
    .insert(readStates)
    .values({
      orgId: a.org.id,
      conversationId,
      userId: a.userId,
      lastReadSeq: seq,
      markedUnread: true,
    })
    .onConflictDoUpdate({
      target: [readStates.conversationId, readStates.userId],
      // Unread even when only my own messages come after (they never count as unread).
      set: { lastReadSeq: seq, markedUnread: true, updatedAt: sql`now()` },
    });
  return publishOwnRead(deps, a.org.id, conversationId, a.userId, seq);
}

/**
 * "Mesaj bilgisi": who saw my message and first when, and who has not yet. Only its author
 * asks (403 otherwise). People who turned read receipts off are counted apart, not listed.
 */
export async function messageInfo(db: DbOrTx, a: ChatActor, messageId: string) {
  const { msg, m } = await requireMessage(db, a, messageId);
  if (msg.authorId !== a.userId || msg.kind === 'system') throw new AppError('forbidden');
  const audience = (await audienceOf(db, m.conv, msg)).filter((id) => id !== a.userId);
  // People added later without this part of the history never had it to see.
  const rows = audience.length
    ? await db
        .select({
          userId: conversationMembers.userId,
          historyFromSeq: conversationMembers.historyFromSeq,
        })
        .from(conversationMembers)
        .where(
          and(
            eq(conversationMembers.conversationId, m.conv.id),
            inArray(conversationMembers.userId, audience),
          ),
        )
    : [];
  const late = new Set(
    rows
      .filter((r) => r.historyFromSeq !== null && r.historyFromSeq > msg.seq)
      .map((r) => r.userId),
  );
  const people = audience.filter((id) => !late.has(id));
  // No one is hidden: the read receipts setting is not applied here (user decision).
  const open = people;
  const states = open.length
    ? await db
        .select({ userId: readStates.userId, seq: readStates.lastReadSeq })
        .from(readStates)
        .where(and(eq(readStates.conversationId, m.conv.id), inArray(readStates.userId, open)))
    : [];
  const position = new Map(states.map((s) => [s.userId, s.seq]));
  const firstSeen = open.length
    ? await db
        .select({ userId: readMarks.userId, at: sql<Date>`min(${readMarks.at})` })
        .from(readMarks)
        .where(
          and(
            eq(readMarks.conversationId, m.conv.id),
            inArray(readMarks.userId, open),
            sql`${readMarks.fromSeq} < ${msg.seq}`,
            sql`${readMarks.toSeq} >= ${msg.seq}`,
          ),
        )
        .groupBy(readMarks.userId)
    : [];
  const when = new Map(firstSeen.map((r) => [r.userId, new Date(r.at)]));
  const seenIds = open.filter((id) => when.has(id) || (position.get(id) ?? 0) >= msg.seq);
  const unseenIds = open.filter((id) => !seenIds.includes(id));
  const users = await usersById(db, [...seenIds, ...unseenIds]);
  const seen = seenIds
    .flatMap((id) => {
      const user = users.get(id);
      return user ? [{ user, at: when.get(id)?.toISOString() ?? null }] : [];
    })
    .sort((x, y) => (y.at ?? '').localeCompare(x.at ?? ''));
  const notSeen = unseenIds.flatMap((id) => {
    const user = users.get(id);
    return user ? [user] : [];
  });
  return {
    messageId: msg.id,
    total: people.length,
    seenCount: seen.length,
    seen,
    notSeen,
  };
}

export async function listReadReceipts(db: DbOrTx, a: ChatActor, conversationId: string) {
  const m = await requireMember(db, a, conversationId);
  // Everyone's reads, whatever their readReceipts setting (no hiding, user decision).
  const visible = (await memberIds(db, m.conv)).filter((id) => id !== a.userId);
  if (visible.length === 0) return [];
  const rows = await db
    .select()
    .from(readStates)
    .where(and(eq(readStates.conversationId, conversationId), inArray(readStates.userId, visible)));
  return rows.map((r) => ({
    userId: r.userId,
    lastReadSeq: r.lastReadSeq,
    at: r.updatedAt.toISOString(),
  }));
}
