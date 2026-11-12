import { and, asc, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import {
  blobs,
  chatPolls,
  chatPollVotes,
  conversationMembers,
  conversations,
  incomingWebhooks,
  messageAttachments,
  messages,
  nodes,
  nodeVersions,
  orgMembers,
  federationReactions,
  reactions,
  readStates,
  spaceMembers,
  spaces,
  users,
  type DbOrTx,
} from '@crewhall/db';
import {
  AlertCard,
  SystemEvent,
  type Conversation,
  type Message,
  type MessageAttachment,
  type MessagePreview,
  type Poll,
  type UserSummary,
} from '@crewhall/shared';
import {
  defaultNotify,
  permissionsOf,
  spaceBound,
  spaceRoomChats,
  type ChatActor,
  type ConversationRow,
  type Membership,
  type MessageRow,
  historyFromRow,
  whisperVisible,
} from './access';
import { excerpt, mentionedIds, parseMentions } from './text';
import { federationOf } from '../federation/chat';

export const idList = (ids: string[]): SQL =>
  sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );

export async function usersById(db: DbOrTx, ids: Iterable<string>) {
  const list = [...new Set(ids)];
  if (list.length === 0) return new Map<string, UserSummary>();
  const rows = await db
    .select({ id: users.id, name: users.name, email: users.email, image: users.image })
    .from(users)
    .where(inArray(users.id, list));
  return new Map(
    rows.map((u) => [u.id, { id: u.id, name: u.name, email: u.email, imageUrl: u.image ?? null }]),
  );
}

const namesOf = (people: Map<string, UserSummary>) =>
  new Map([...people.values()].map((u) => [u.id, u.name]));

async function attachmentsOf(db: DbOrTx, messageIds: string[]) {
  const out = new Map<string, MessageAttachment[]>();
  if (messageIds.length === 0) return out;
  const rows = await db
    .select({
      messageId: messageAttachments.messageId,
      nodeId: nodes.id,
      name: nodes.name,
      mime: nodes.mime,
      sizeBytes: nodes.sizeBytes,
      deletedAt: nodes.deletedAt,
      preview: blobs.previewStatus,
    })
    .from(messageAttachments)
    .innerJoin(nodes, eq(nodes.id, messageAttachments.nodeId))
    .leftJoin(nodeVersions, eq(nodeVersions.id, nodes.currentVersionId))
    .leftJoin(blobs, eq(blobs.id, nodeVersions.blobId))
    .where(inArray(messageAttachments.messageId, messageIds))
    .orderBy(asc(messageAttachments.position));
  for (const r of rows) {
    const list = out.get(r.messageId) ?? [];
    list.push({
      nodeId: r.nodeId,
      name: r.name,
      mime: r.mime,
      sizeBytes: r.sizeBytes,
      preview: r.preview ?? 'none',
      removed: r.deletedAt !== null,
    });
    out.set(r.messageId, list);
  }
  return out;
}

async function reactionsOf(db: DbOrTx, viewerId: string, messageIds: string[]) {
  const out = new Map<string, Message['reactions']>();
  if (messageIds.length === 0) return out;
  const rows = await db
    .select({
      messageId: reactions.messageId,
      emoji: reactions.emoji,
      count: sql<number>`count(*)::int`,
      userIds: sql<
        string[]
      >`(array_agg(${reactions.userId} order by ${reactions.createdAt}))[1:20]`,
      mine: viewerId
        ? sql<boolean>`bool_or(${reactions.userId} = ${viewerId}::uuid)`
        : sql<boolean>`false`,
    })
    .from(reactions)
    .where(inArray(reactions.messageId, messageIds))
    .groupBy(reactions.messageId, reactions.emoji)
    .orderBy(sql`min(${reactions.createdAt})`);
  for (const r of rows) {
    const list = out.get(r.messageId) ?? [];
    list.push({ emoji: r.emoji, count: r.count, userIds: r.userIds, mine: r.mine });
    out.set(r.messageId, list);
  }
  // People on other installations (federation): counted, named, never "mine".
  const remote = await db
    .select({
      messageId: federationReactions.messageId,
      emoji: federationReactions.emoji,
      count: sql<number>`count(*)::int`,
      names: sql<
        string[]
      >`(array_agg(${federationReactions.name} order by ${federationReactions.createdAt}))[1:20]`,
    })
    .from(federationReactions)
    .where(inArray(federationReactions.messageId, messageIds))
    .groupBy(federationReactions.messageId, federationReactions.emoji)
    .orderBy(sql`min(${federationReactions.createdAt})`);
  for (const r of remote) {
    const list = out.get(r.messageId) ?? [];
    const same = list.find((x) => x.emoji === r.emoji);
    if (same) {
      same.count += r.count;
      same.remoteNames = r.names;
    } else {
      list.push({ emoji: r.emoji, count: r.count, userIds: [], mine: false, remoteNames: r.names });
    }
    out.set(r.messageId, list);
  }
  return out;
}

/** Polls (roadmap 23) by id, with every voter per option. */
export async function pollsById(db: DbOrTx, ids: string[]) {
  const out = new Map<string, Poll>();
  if (ids.length === 0) return out;
  const polls = await db.select().from(chatPolls).where(inArray(chatPolls.id, ids));
  const votes = await db
    .select()
    .from(chatPollVotes)
    .where(inArray(chatPollVotes.pollId, ids))
    .orderBy(asc(chatPollVotes.createdAt));
  for (const p of polls) {
    const mine = votes.filter((v) => v.pollId === p.id);
    out.set(p.id, {
      id: p.id,
      question: p.question,
      multiple: p.multiple,
      closedAt: p.closedAt?.toISOString() ?? null,
      createdBy: p.createdBy,
      voterCount: new Set(mine.map((v) => v.userId)).size,
      options: p.options.map((text, index) => {
        const userIds = mine.filter((v) => v.option === index).map((v) => v.userId);
        return { index, text, count: userIds.length, userIds };
      }),
    });
  }
  return out;
}

/** Message rows → contract shape for one viewer (reactions' `mine`). */
export async function toMessages(
  db: DbOrTx,
  viewerId: string,
  rows: MessageRow[],
): Promise<Message[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const replyIds = [...new Set(rows.map((r) => r.replyToId).filter((v): v is string => !!v))];
  const quoted = replyIds.length
    ? await db.select().from(messages).where(inArray(messages.id, replyIds))
    : [];
  const quotedById = new Map(quoted.map((q) => [q.id, q]));
  const all = [...rows, ...quoted];

  const people = await usersById(db, [
    ...all.map((r) => r.authorId).filter((v): v is string => !!v),
    ...rows.map((r) => r.whisperTo).filter((v): v is string => !!v),
    ...rows.map((r) => r.body.claim?.userId).filter((v): v is string => !!v),
    ...mentionedIds(all.map((r) => r.text)),
  ]);
  const polls = await pollsById(
    db,
    rows.map((r) => r.body.poll).filter((v): v is string => !!v && typeof v === 'string'),
  );
  const names = namesOf(people);
  const webhookIds = [...new Set(all.map((r) => r.webhookId).filter((v): v is string => !!v))];
  const hooks = new Map(
    (webhookIds.length
      ? await db
          .select({ id: incomingWebhooks.id, name: incomingWebhooks.name })
          .from(incomingWebhooks)
          .where(inArray(incomingWebhooks.id, webhookIds))
      : []
    ).map((h) => [h.id, h]),
  );
  const files = await attachmentsOf(db, [...ids, ...replyIds]);
  const reacts = await reactionsOf(db, viewerId, ids);

  return rows.map((r): Message => {
    const deleted = r.deletedAt !== null;
    const q = r.replyToId ? quotedById.get(r.replyToId) : undefined;
    const card = r.body.card ? AlertCard.safeParse(r.body.card) : null;
    const system = r.body.system ? SystemEvent.safeParse(r.body.system) : null;
    const parsed = deleted ? null : parseMentions(r.text);
    const hook = r.webhookId ? hooks.get(r.webhookId) : undefined;
    const qHook = q?.webhookId ? hooks.get(q.webhookId) : undefined;
    return {
      id: r.id,
      conversationId: r.conversationId,
      seq: r.seq,
      kind: r.kind,
      author: r.authorId ? (people.get(r.authorId) ?? null) : null,
      webhook: hook
        ? { id: hook.id, name: hook.name, avatarUrl: null }
        : r.body.automation
          ? { id: r.body.automation.ruleId, name: r.body.automation.ruleName, avatarUrl: null }
          : null,
      automation: r.body.automation ?? null,
      ...(r.body.severity ? { severity: r.body.severity } : {}),
      text: deleted ? '' : r.text,
      mentions: parsed
        ? [
            ...parsed.userIds.map((userId) => ({ kind: 'user' as const, userId })),
            ...(parsed.all ? [{ kind: 'all' as const, userId: null }] : []),
            ...(parsed.here ? [{ kind: 'here' as const, userId: null }] : []),
          ]
        : [],
      card: !deleted && card?.success ? card.data : null,
      system: system?.success ? system.data : null,
      via:
        !deleted &&
        r.body.via &&
        (r.body.via.kind === 'mcp' || r.body.via.kind === 'api' || r.body.via.kind === 'plugin')
          ? { kind: r.body.via.kind, client: r.body.via.client }
          : null,
      ...(r.body.remote
        ? {
            remoteAuthor: {
              address: r.body.remote.address,
              name: r.body.remote.name,
              domain: r.body.remote.domain,
            },
          }
        : {}),
      ...(r.body.guest ? { guestAuthor: { name: r.body.guest.name } } : {}),
      emote: r.body.emote === true && !deleted,
      whisperTo: r.whisperTo ? (people.get(r.whisperTo) ?? null) : null,
      poll: !deleted && r.body.poll ? (polls.get(r.body.poll) ?? null) : null,
      gif: !deleted && r.body.gif ? r.body.gif : null,
      refs: !deleted && r.body.refs ? r.body.refs : [],
      claim:
        !deleted && r.body.claim && people.get(r.body.claim.userId)
          ? { user: people.get(r.body.claim.userId)!, at: r.body.claim.at }
          : null,
      attachments: deleted ? [] : (files.get(r.id) ?? []),
      replyTo: q
        ? {
            id: q.id,
            seq: q.seq,
            author: q.authorId ? (people.get(q.authorId) ?? null) : null,
            webhookName: qHook?.name ?? q.body.automation?.ruleName ?? null,
            ...(q.body.guest ? { guestAuthor: { name: q.body.guest.name } } : {}),
            excerpt: q.deletedAt ? null : excerpt(q.text, names, 160),
            hasAttachments: !q.deletedAt && (files.get(q.id)?.length ?? 0) > 0,
            deleted: q.deletedAt !== null,
          }
        : null,
      reactions: deleted ? [] : (reacts.get(r.id) ?? []),
      clientMsgId: r.clientMsgId,
      pinnedAt: r.pinnedAt?.toISOString() ?? null,
      editedAt: r.editedAt?.toISOString() ?? null,
      deletedAt: r.deletedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  });
}

export async function toMessage(db: DbOrTx, viewerId: string, row: MessageRow) {
  const [m] = await toMessages(db, viewerId, [row]);
  return m!;
}

function groupTitle(others: UserSummary[]) {
  const first = others
    .map((u) => u.name.split(/\s+/)[0] ?? u.name)
    .sort((x, y) => x.localeCompare(y, 'tr'));
  if (first.length <= 3) return first.join(', ');
  return `${first.slice(0, 3).join(', ')} +${first.length - 3}`;
}

/** Unread counts for one person across conversations (messages after their read seq). */
export async function unreadCounts(db: DbOrTx, userId: string, convIds: string[]) {
  const unread = new Map<string, number>();
  const mentions = new Map<string, number>();
  if (convIds.length === 0) return { unread, mentions };
  const u = await db.execute<{ conversation_id: string; n: number }>(sql`
    select m.conversation_id, count(*)::int as n
    from ${messages} m
    left join ${readStates} r on r.conversation_id = m.conversation_id and r.user_id = ${userId}::uuid
    left join ${conversationMembers} cm
      on cm.conversation_id = m.conversation_id and cm.user_id = ${userId}::uuid
    where m.conversation_id in (${idList(convIds)})
      and m.seq > coalesce(r.last_read_seq, 0)
      and m.seq >= coalesce(cm.history_from_seq, 0)
      and m.deleted_at is null and m.kind <> 'system'
      and m.author_id is distinct from ${userId}::uuid
      and (m.whisper_to is null or m.whisper_to = ${userId}::uuid)
    group by 1`);
  for (const r of u.rows) unread.set(r.conversation_id, r.n);
  // "Okunmadı olarak işaretle" is at least one unread message.
  const marked = await db
    .select({ id: readStates.conversationId })
    .from(readStates)
    .where(
      and(
        eq(readStates.userId, userId),
        eq(readStates.markedUnread, true),
        inArray(readStates.conversationId, convIds),
      ),
    );
  for (const r of marked) unread.set(r.id, Math.max(1, unread.get(r.id) ?? 0));
  const mm = await db.execute<{ conversation_id: string; n: number }>(sql`
    select x.conversation_id, count(*)::int as n
    from mentions x
    join ${messages} m on m.id = x.message_id
    left join ${readStates} r on r.conversation_id = x.conversation_id and r.user_id = ${userId}::uuid
    where x.notified_user_id = ${userId}::uuid
      and x.conversation_id in (${idList(convIds)})
      and x.seq > coalesce(r.last_read_seq, 0)
      and m.deleted_at is null
    group by 1`);
  for (const r of mm.rows) mentions.set(r.conversation_id, r.n);
  return { unread, mentions };
}

/** Conversation rows → contract shape for the caller (title, unread, own settings). */
export async function conversationViews(
  db: DbOrTx,
  a: ChatActor,
  convs: ConversationRow[],
): Promise<Conversation[]> {
  if (convs.length === 0) return [];
  const ids = convs.map((c) => c.id);
  const spaceIds = [...new Set(convs.map((c) => c.spaceId).filter((v): v is string => !!v))];

  const spaceRows = spaceIds.length
    ? await db
        .select({ id: spaces.id, name: spaces.name, color: spaces.color })
        .from(spaces)
        .where(inArray(spaces.id, spaceIds))
    : [];
  const spaceInfo = new Map(spaceRows.map((s) => [s.id, s]));
  const roomChats = await spaceRoomChats(db, convs);
  const myRoles = new Map(
    (spaceIds.length
      ? await db
          .select({ spaceId: spaceMembers.spaceId, role: spaceMembers.role })
          .from(spaceMembers)
          .where(and(eq(spaceMembers.userId, a.userId), inArray(spaceMembers.spaceId, spaceIds)))
      : []
    ).map((r) => [r.spaceId, r.role]),
  );
  const spaceCounts = new Map(
    (spaceIds.length
      ? await db
          .select({ spaceId: spaceMembers.spaceId, n: sql<number>`count(*)::int` })
          .from(spaceMembers)
          .innerJoin(
            orgMembers,
            and(
              eq(orgMembers.userId, spaceMembers.userId),
              eq(orgMembers.organizationId, a.org.id),
              eq(orgMembers.status, 'active'),
            ),
          )
          .where(inArray(spaceMembers.spaceId, spaceIds))
          .groupBy(spaceMembers.spaceId)
      : []
    ).map((r) => [r.spaceId, r.n]),
  );

  const memberRows = await db
    .select({
      conversationId: conversationMembers.conversationId,
      row: conversationMembers,
      user: { id: users.id, name: users.name, email: users.email, image: users.image },
    })
    .from(conversationMembers)
    .innerJoin(users, eq(users.id, conversationMembers.userId))
    .where(inArray(conversationMembers.conversationId, ids))
    .orderBy(asc(conversationMembers.createdAt));
  const membersOf = new Map<string, UserSummary[]>();
  const mine = new Map<string, (typeof memberRows)[number]['row']>();
  for (const r of memberRows) {
    const list = membersOf.get(r.conversationId) ?? [];
    list.push({ id: r.user.id, name: r.user.name, email: r.user.email, imageUrl: r.user.image });
    membersOf.set(r.conversationId, list);
    if (r.user.id === a.userId) mine.set(r.conversationId, r.row);
  }

  const readRows = await db
    .select({
      conversationId: readStates.conversationId,
      seq: readStates.lastReadSeq,
      marked: readStates.markedUnread,
    })
    .from(readStates)
    .where(and(eq(readStates.userId, a.userId), inArray(readStates.conversationId, ids)));
  const reads = new Map(readRows.map((r) => [r.conversationId, r.seq]));
  const markedUnread = new Set(readRows.filter((r) => r.marked).map((r) => r.conversationId));
  const { unread, mentions } = await unreadCounts(db, a.userId, ids);

  const last = await db
    .selectDistinctOn([messages.conversationId])
    .from(messages)
    .where(and(inArray(messages.conversationId, ids), whisperVisible(a.userId)))
    .orderBy(messages.conversationId, desc(messages.seq));
  const lastPeople = await usersById(db, [
    ...last.map((m) => m.authorId).filter((v): v is string => !!v),
    ...mentionedIds(last.map((m) => m.text)),
  ]);
  const lastHooks = new Map(
    (
      await db
        .select({
          id: incomingWebhooks.id,
          name: incomingWebhooks.name,
          conversationId: incomingWebhooks.conversationId,
          disabledAt: incomingWebhooks.disabledAt,
        })
        .from(incomingWebhooks)
        .where(inArray(incomingWebhooks.conversationId, ids))
    ).map((h) => [h.id, h]),
  );
  const withHooks = new Set(
    [...lastHooks.values()].filter((h) => !h.disabledAt).map((h) => h.conversationId),
  );
  const files = new Set(
    (last.length
      ? await db
          .select({ messageId: messageAttachments.messageId })
          .from(messageAttachments)
          .where(
            inArray(
              messageAttachments.messageId,
              last.map((m) => m.id),
            ),
          )
      : []
    ).map((r) => r.messageId),
  );
  const lastBy = new Map(last.map((m) => [m.conversationId, m]));
  const names = namesOf(lastPeople);
  const federated = await federationOf(db, a.org, ids);

  return convs.map((c): Conversation => {
    const row = mine.get(c.id) ?? null;
    const spaceRole = c.spaceId ? (myRoles.get(c.spaceId) ?? null) : null;
    const m: Membership = {
      conv: c,
      row,
      spaceRole,
      isMember: spaceBound(c)
        ? spaceRole !== null
        : row !== null || (spaceRole !== null && roomChats.has(c.id)),
    };
    const people = membersOf.get(c.id) ?? [];
    const others = people.filter((u) => u.id !== a.userId);
    const peer = c.type === 'direct' ? (others[0] ?? null) : null;
    const space = c.spaceId ? spaceInfo.get(c.spaceId) : undefined;
    const historyFrom = historyFromRow(row);
    const lm = lastBy.get(c.id);
    let preview: MessagePreview | null = null;
    if (lm && lm.seq >= historyFrom) {
      const author = lm.authorId ? lastPeople.get(lm.authorId) : undefined;
      const hook = lm.webhookId ? lastHooks.get(lm.webhookId) : undefined;
      const card = lm.body.card as { title?: unknown } | undefined;
      // A GIF-only message reads "GIF" in the list (the same word in every language).
      // A reference-only message: a link sign, never the item's title.
      const text =
        lm.text ||
        (typeof card?.title === 'string' ? card.title : '') ||
        (lm.body.gif ? 'GIF' : '') ||
        (lm.body.refs?.length ? '🔗' : '');
      preview = {
        seq: lm.seq,
        kind: lm.kind,
        authorId: lm.authorId,
        authorName:
          author?.name ??
          hook?.name ??
          lm.body.remote?.name ??
          lm.body.guest?.name ??
          lm.body.automation?.ruleName ??
          null,
        excerpt: lm.deletedAt ? null : excerpt(text, names),
        hasAttachments: files.has(lm.id),
        deleted: lm.deletedAt !== null,
        createdAt: lm.createdAt.toISOString(),
      };
    }
    const title =
      c.name ??
      (c.type === 'direct' ? (peer?.name ?? '') : others.length ? groupTitle(others) : '');
    return {
      id: c.id,
      type: c.type,
      spaceId: c.spaceId,
      spaceName: space?.name ?? null,
      spaceColor: space?.color ?? null,
      meetingId: c.meetingId,
      name: c.name,
      emoji: c.emoji,
      title,
      avatarUrl: null,
      peer,
      memberCount: spaceBound(c) ? (spaceCounts.get(c.spaceId!) ?? 0) : people.length,
      lastSeq: c.lastSeq,
      lastMessageAt: c.lastMessageAt?.toISOString() ?? null,
      lastMessage: preview,
      attachmentsNodeId: c.attachmentsNodeId,
      hasWebhooks: withHooks.has(c.id),
      archivedAt: c.archivedAt?.toISOString() ?? null,
      createdBy: c.createdBy,
      createdAt: c.createdAt.toISOString(),
      my: {
        pinnedAt: row?.pinnedAt?.toISOString() ?? null,
        pinPosition: row?.pinPosition ?? null,
        notify: row?.notify ?? defaultNotify(c.type),
        mutedUntil:
          row?.mutedUntil && row.mutedUntil.getTime() > Date.now()
            ? row.mutedUntil.toISOString()
            : null,
        lastReadSeq: reads.get(c.id) ?? 0,
        markedUnread: markedUnread.has(c.id),
        unread: unread.get(c.id) ?? 0,
        unreadMentions: mentions.get(c.id) ?? 0,
        historyFromSeq: row?.historyFromSeq ?? null,
        archivedAt: row?.archivedAt?.toISOString() ?? null,
        clearedAtSeq: row?.clearedAtSeq ?? null,
      },
      permissions: permissionsOf(a, m),
      ...(federated.has(c.id) ? { federation: federated.get(c.id)! } : {}),
    };
  });
}

export async function conversationView(db: DbOrTx, a: ChatActor, conv: ConversationRow) {
  const [v] = await conversationViews(db, a, [conv]);
  return v!;
}

/** Fresh row (after updates). */
export async function reloadConversation(db: DbOrTx, id: string) {
  const [c] = await db.select().from(conversations).where(eq(conversations.id, id));
  return c!;
}
