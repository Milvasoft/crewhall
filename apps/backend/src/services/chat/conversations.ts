import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  notInArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import {
  conversationMembers,
  conversations,
  meetings,
  messageAttachments,
  messages,
  nodes,
  orgMembers,
  spaceMembers,
  spaces,
  users,
  type DbOrTx,
} from '@crewhall/db';
import { assertGuestReach } from '../guests';
import { conversationHeld } from '../compliance/holds';
import {
  CHAT_LIMITS,
  can,
  isReactionEmoji,
  type ChatMember,
  type Conversation,
  type CreateConversation,
  type HistoryShare,
  type NotifyLevel,
  type SpaceRole,
} from '@crewhall/shared';
import type { Deps } from '../../deps';
import { AppError } from '../../http/errors';
import { publishToUsers, userTopic } from '../../realtime/bus';
import { orgContext, toActor } from '../membership';
import {
  activeOrgUserIds,
  defaultNotify,
  memberIds,
  mySpaceRoles,
  requireMember,
  privateChannel,
  requirePermission,
  spaceBound,
  type ChatActor,
  type ConversationRow,
} from './access';
import { appendSystem, markReadTx, publishMessage, sendMessage } from './messages';
import { readConversationNotifications } from '../notifications/center';
import { audit } from '../audit';
import { resources } from '@crewhall/i18n';
import type { RequestInfo } from '../../http/types';
import { endSharesOf } from '../federation/shared';
import { conversationView, conversationViews, reloadConversation } from './views';

const directKey = (a: string, b: string) => [a, b].sort().join(':');

/** Conversations the caller belongs to (visibility rule shared by list and unreads). */
export function visibleTo(orgId: string, userId: string, spaceIds: string[]): SQL {
  const spaceRule = spaceIds.length
    ? sql`(${conversations.spaceId} in (${sql.join(
        spaceIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )}) and ${conversations.type} in ('space', 'alert') and not ${conversations.private})`
    : sql`false`;
  // A private channel: the person's row, written while they were already in the (live) space
  // (access.ts › inSpaceSinceAdded).
  const privateRule = spaceIds.length
    ? sql`(${conversations.spaceId} in (${sql.join(
        spaceIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )}) and exists (select 1 from ${conversationMembers} cp
        join ${spaceMembers} sp on sp.space_id = ${conversations.spaceId} and sp.user_id = cp.user_id
        where cp.conversation_id = ${conversations.id} and cp.user_id = ${userId}::uuid
          and sp.created_at <= cp.created_at))`
    : sql`false`;
  // A space's permanent room shows to the whole space. A planned meeting or a quick call stays
  // with the people invited and the people who joined (access.ts › spaceRoomChats).
  const spaceRoomRule = spaceIds.length
    ? sql`(${conversations.type} = 'meeting' and ${conversations.spaceId} in (${sql.join(
        spaceIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )}) and exists (select 1 from ${meetings} m where m.id = ${conversations.meetingId}
        and m.kind = 'room' and m.cancelled_at is null))`
    : sql`false`;
  return and(
    eq(conversations.orgId, orgId),
    or(
      spaceRule,
      spaceRoomRule,
      sql`(not (${conversations.spaceId} is not null and ${conversations.type} in ('space', 'alert')
          and not ${conversations.private})
        and (not ${conversations.private} or ${privateRule})
        and exists (select 1 from ${conversationMembers} cm
          where cm.conversation_id = ${conversations.id} and cm.user_id = ${userId}::uuid))`,
    ),
    // "Benim için sil" (H19): gone from my list until a newer message arrives.
    sql`not exists (select 1 from ${conversationMembers} cc
      where cc.conversation_id = ${conversations.id} and cc.user_id = ${userId}::uuid
        and cc.cleared_at_seq is not null and cc.cleared_at_seq >= ${conversations.lastSeq})`,
    // Direct and group conversations exist for others from their first message (4.17).
    sql`not (${conversations.type} in ('direct', 'group') and ${conversations.lastSeq} = 0
      and ${conversations.createdBy} is distinct from ${userId}::uuid)`,
  )!;
}

interface ListCursor {
  t: string;
  id: string;
}
const encode = (c: ListCursor) => Buffer.from(JSON.stringify(c)).toString('base64url');
function decode(s: string): ListCursor {
  try {
    const c = JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as ListCursor;
    if (typeof c.t === 'string' && typeof c.id === 'string') return c;
  } catch {
    // fall through
  }
  throw new AppError('bad_request', { reason: 'invalid_cursor' });
}

const activity = sql<Date>`coalesce(${conversations.lastMessageAt}, ${conversations.createdAt})`;

/** The person's own archive (H19), next to the conversation-wide one. */
const archivedByMe = (userId: string) =>
  sql`exists (select 1 from ${conversationMembers} ca
    where ca.conversation_id = ${conversations.id} and ca.user_id = ${userId}::uuid
      and ca.archived_at is not null)`;

export async function listConversations(
  db: DbOrTx,
  a: ChatActor,
  q: {
    filter?: 'unread' | 'direct' | 'group' | 'space' | 'meeting' | undefined;
    q?: string | undefined;
    archived?: boolean | undefined;
    cursor?: string | undefined;
    limit: number;
  },
): Promise<{ items: Conversation[]; nextCursor: string | null }> {
  const spaceIds = [...(await mySpaceRoles(db, a.org.id, a.userId)).keys()];
  const where: SQL[] = [visibleTo(a.org.id, a.userId, spaceIds)];
  // "Arşiv": archived for everyone or by me; the main list shows neither.
  where.push(
    q.archived
      ? or(isNotNull(conversations.archivedAt), archivedByMe(a.userId))!
      : and(isNull(conversations.archivedAt), sql`not ${archivedByMe(a.userId)}`)!,
  );
  if (q.filter === 'direct') where.push(eq(conversations.type, 'direct'));
  if (q.filter === 'group') where.push(sql`${conversations.type} in ('group', 'alert')`);
  if (q.filter === 'space') where.push(eq(conversations.type, 'space'));
  if (q.filter === 'meeting') where.push(eq(conversations.type, 'meeting'));

  const pinnedIds = (
    await db
      .select({ id: conversationMembers.conversationId })
      .from(conversationMembers)
      .where(
        and(eq(conversationMembers.userId, a.userId), isNotNull(conversationMembers.pinPosition)),
      )
  ).map((r) => r.id);

  // Searching and the unread filter look at every conversation (no paging).
  const scan = q.filter === 'unread' || !!q.q;
  let pinnedRows: ConversationRow[] = [];
  if (!q.cursor && pinnedIds.length && !scan) {
    pinnedRows = await db
      .select()
      .from(conversations)
      .where(and(...where, inArray(conversations.id, pinnedIds)));
  }
  const rest: SQL[] = [...where];
  if (!scan && pinnedIds.length)
    rest.push(
      sql`${conversations.id} not in (${sql.join(
        pinnedIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})`,
    );
  if (q.cursor) {
    const c = decode(q.cursor);
    rest.push(
      sql`(${activity}, ${conversations.id}) < (${new Date(c.t)}::timestamptz, ${c.id}::uuid)`,
    );
  }
  const rows = await db
    .select()
    .from(conversations)
    .where(and(...rest))
    .orderBy(desc(activity), desc(conversations.id))
    .limit(scan ? 1000 : q.limit + 1);
  const page = scan ? rows : rows.slice(0, q.limit);
  let views = await conversationViews(db, a, [...pinnedRows, ...page]);
  if (q.filter === 'unread')
    views = views.filter((v) => v.my.unread > 0 || v.my.unreadMentions > 0);
  if (q.q) {
    const needle = q.q.toLocaleLowerCase('tr');
    views = views.filter((v) => v.title.toLocaleLowerCase('tr').includes(needle));
  }
  views.sort((x, y) => {
    const px = x.my.pinPosition;
    const py = y.my.pinPosition;
    if (px !== null || py !== null) {
      if (px === null) return 1;
      if (py === null) return -1;
      return px - py;
    }
    return 0;
  });
  const last = page.at(-1);
  return {
    items: views,
    nextCursor:
      !scan && rows.length > q.limit && last
        ? encode({
            t: (last.lastMessageAt ?? last.createdAt).toISOString(),
            id: last.id,
          })
        : null,
  };
}

export async function getConversation(db: DbOrTx, a: ChatActor, id: string) {
  const m = await requireMember(db, a, id);
  return conversationView(db, a, m.conv);
}

/** Per-recipient `conversation.updated` (own settings and permissions differ). */
export async function publishConversation(
  deps: Pick<Deps, 'db' | 'bus'>,
  a: ChatActor,
  conv: ConversationRow,
  only?: string[],
) {
  const ids = only ?? (await memberIds(deps.db, conv));
  if (ids.length === 0) return;
  const members = await deps.db
    .select()
    .from(orgMembers)
    .where(and(eq(orgMembers.organizationId, conv.orgId), inArray(orgMembers.userId, ids)));
  for (const mrow of members) {
    const actor: ChatActor = { org: a.org, actor: toActor(mrow), userId: mrow.userId };
    const view = await conversationView(deps.db, actor, conv);
    deps.bus.publish(userTopic(mrow.userId), { type: 'conversation.updated', conversation: view });
  }
}

async function insertMembers(
  db: DbOrTx,
  conv: ConversationRow,
  userIds: string[],
  addedBy: string,
  historyFromSeq: number | null,
  owners: readonly string[] = [],
) {
  if (userIds.length === 0) return;
  await db
    .insert(conversationMembers)
    .values(
      userIds.map((userId) => ({
        conversationId: conv.id,
        userId,
        orgId: conv.orgId,
        notify: defaultNotify(conv.type),
        addedBy,
        historyFromSeq: userId === addedBy ? null : historyFromSeq,
        role: owners.includes(userId) ? ('owner' as const) : ('member' as const),
      })),
    )
    .onConflictDoNothing();
}

/** Space members among `userIds` (who may join a private channel of that space). */
async function spaceMemberIds(db: DbOrTx, spaceId: string, userIds: string[]) {
  if (userIds.length === 0) return new Set<string>();
  const rows = await db
    .select({ userId: spaceMembers.userId })
    .from(spaceMembers)
    .where(and(eq(spaceMembers.spaceId, spaceId), inArray(spaceMembers.userId, userIds)));
  return new Set(rows.map((r) => r.userId));
}

/** People added to a private channel: active org members who are in its space. */
async function requireChannelPeople(db: DbOrTx, orgId: string, spaceId: string, ids: string[]) {
  const active = await activeOrgUserIds(db, orgId, ids);
  if (active.size !== ids.length) throw new AppError('member_not_found');
  const inSpace = await spaceMemberIds(db, spaceId, ids);
  if (inSpace.size !== ids.length) {
    throw new AppError('chat_not_in_space', { userIds: ids.filter((u) => !inSpace.has(u)) });
  }
}

/**
 * A private channel keeps at least one owner: when the last one leaves (or is removed or made
 * a member), the longest-standing member still in the space takes over.
 */
async function ensureOwner(db: DbOrTx, conv: ConversationRow) {
  if (!privateChannel(conv)) return;
  const current = new Set(await memberIds(db, conv));
  if (current.size === 0) return;
  const rows = await db
    .select({ userId: conversationMembers.userId, role: conversationMembers.role })
    .from(conversationMembers)
    .where(eq(conversationMembers.conversationId, conv.id))
    .orderBy(asc(conversationMembers.createdAt));
  const live = rows.filter((r) => current.has(r.userId));
  if (live.length === 0 || live.some((r) => r.role === 'owner')) return;
  await db
    .update(conversationMembers)
    .set({ role: 'owner' })
    .where(
      and(
        eq(conversationMembers.conversationId, conv.id),
        eq(conversationMembers.userId, live[0]!.userId),
      ),
    );
}

function requireSpaceAction(a: ChatActor, role: SpaceRole | null, action: 'space.chat_create') {
  const ok = can(a.actor, action, { type: 'space', org: orgContext(a.org), myRole: role });
  if (!ok) throw new AppError('forbidden');
}

/** A channel emoji: one emoji grapheme (the reaction rule), or nothing. */
function channelEmoji(value: string | null | undefined): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (!isReactionEmoji(value)) throw new AppError('chat_invalid_emoji');
  return value;
}

export async function createConversation(
  deps: Deps,
  a: ChatActor,
  input: CreateConversation,
): Promise<Conversation> {
  const { db } = deps;
  const guest = a.actor.orgRole === 'guest';
  let conv: ConversationRow;

  if (input.type === 'direct') {
    if (input.userId === a.userId) throw new AppError('bad_request', { reason: 'self' });
    if (!(await activeOrgUserIds(db, a.org.id, [input.userId])).has(input.userId)) {
      throw new AppError('member_not_found');
    }
    // Guests write only to people they share a space or a conversation with (doc 17 §5).
    if (guest) await assertGuestReach(db, a.actor, [input.userId]);
    const key = directKey(a.userId, input.userId);
    const [found] = await db
      .select()
      .from(conversations)
      .where(and(eq(conversations.orgId, a.org.id), eq(conversations.directKey, key)));
    if (found) {
      conv = found;
    } else {
      conv = await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(conversations)
          .values({ orgId: a.org.id, type: 'direct', directKey: key, createdBy: a.userId })
          .onConflictDoNothing()
          .returning();
        const c =
          row ??
          (
            await tx
              .select()
              .from(conversations)
              .where(and(eq(conversations.orgId, a.org.id), eq(conversations.directKey, key)))
          )[0]!;
        await insertMembers(tx, c, [a.userId, input.userId], a.userId, null);
        return c;
      });
    }
  } else if (input.type === 'group') {
    if (guest) throw new AppError('forbidden');
    const others = [...new Set(input.userIds)].filter((id) => id !== a.userId);
    if (others.length < 2) throw new AppError('bad_request', { reason: 'group_needs_three' });
    if (others.length + 1 > CHAT_LIMITS.groupMembers) throw new AppError('chat_group_full');
    const emoji = channelEmoji(input.emoji);
    const active = await activeOrgUserIds(db, a.org.id, others);
    if (active.size !== others.length) throw new AppError('member_not_found');
    conv = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(conversations)
        .values({
          orgId: a.org.id,
          type: 'group',
          name: input.name ?? null,
          emoji,
          createdBy: a.userId,
        })
        .returning();
      await insertMembers(tx, row!, [a.userId, ...others], a.userId, null);
      return row!;
    });
  } else {
    const spaceId = input.type === 'space' ? input.spaceId : (input.spaceId ?? null);
    const emoji = channelEmoji(input.emoji);
    if (spaceId) {
      const roles = await mySpaceRoles(db, a.org.id, a.userId);
      requireSpaceAction(a, roles.get(spaceId) ?? null, 'space.chat_create');
    } else if (guest) {
      throw new AppError('forbidden');
    }
    const isPrivate = input.type === 'space' && input.private === true;
    const extra =
      input.type === 'alert' && !spaceId
        ? [...new Set(input.userIds)].filter((id) => id !== a.userId)
        : input.type === 'space' && isPrivate
          ? [...new Set(input.userIds ?? [])].filter((id) => id !== a.userId)
          : [];
    if (isPrivate) {
      if (guest) throw new AppError('forbidden');
      if (extra.length + 1 > CHAT_LIMITS.privateChannelMembers) {
        throw new AppError('chat_group_full');
      }
      await requireChannelPeople(db, a.org.id, spaceId!, extra);
    } else {
      if (extra.length + 1 > CHAT_LIMITS.groupMembers) throw new AppError('chat_group_full');
      if (extra.length) {
        const active = await activeOrgUserIds(db, a.org.id, extra);
        if (active.size !== extra.length) throw new AppError('member_not_found');
      }
    }
    const created = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(conversations)
        .values({
          orgId: a.org.id,
          type: input.type,
          spaceId,
          name: input.name,
          emoji,
          private: isPrivate,
          createdBy: a.userId,
        })
        .returning();
      if (!spaceId || isPrivate) {
        await insertMembers(tx, row!, [a.userId, ...extra], a.userId, null, [a.userId]);
      }
      const line = await appendSystem(tx, row!, {
        type: 'created',
        actorId: a.userId,
        name: input.name,
      });
      return { conv: row!, line };
    });
    conv = await reloadConversation(db, created.conv.id);
    await publishConversation(deps, a, conv);
    await publishMessage(deps, conv, 'message.created', created.line);
  }

  if ('message' in input && input.message) {
    await sendMessage(deps, a, conv.id, input.message);
    conv = await reloadConversation(db, conv.id);
    await publishConversation(deps, a, conv);
  }
  return conversationView(db, a, await reloadConversation(db, conv.id));
}

export async function updateConversation(
  deps: Deps,
  a: ChatActor,
  id: string,
  input: {
    name?: string | null | undefined;
    archived?: boolean | undefined;
    emoji?: string | null | undefined;
    private?: boolean | undefined;
  },
) {
  const { db } = deps;
  const m = await requireMember(db, a, id);
  if (m.conv.type === 'direct') throw new AppError('forbidden');
  const lines = [];
  if (input.private !== undefined && input.private !== m.conv.private) {
    lines.push(await setPrivate(deps, a, m, input.private));
  }
  if (input.archived !== undefined && input.archived !== (m.conv.archivedAt !== null)) {
    requirePermission(a, m, 'archive');
    await db
      .update(conversations)
      .set({ archivedAt: input.archived ? new Date() : null })
      .where(eq(conversations.id, id));
    lines.push(
      await appendSystem(db, m.conv, {
        type: input.archived ? 'archived' : 'unarchived',
        actorId: a.userId,
      }),
    ); // A shared channel stops being shared (federation: channel.share.end).
    if (input.archived) await endSharesOf(deps, a.org.id, id);
  }
  if (input.name !== undefined && input.name !== m.conv.name) {
    const fresh = await reloadConversation(db, id);
    requirePermission(a, { ...m, conv: fresh }, 'manage');
    if (input.name === null && fresh.type !== 'group') {
      throw new AppError('bad_request', { reason: 'name_required' });
    }
    await db.update(conversations).set({ name: input.name }).where(eq(conversations.id, id));
    lines.push(
      await appendSystem(db, fresh, {
        type: 'renamed',
        actorId: a.userId,
        ...(input.name ? { name: input.name } : {}),
      }),
    );
  }
  // Channel emoji: whoever may change the name (group members, space editors and up).
  let emojiChanged = false;
  if (input.emoji !== undefined) {
    const emoji = channelEmoji(input.emoji);
    const fresh = await reloadConversation(db, id);
    if (emoji !== fresh.emoji) {
      requirePermission(a, { ...m, conv: fresh }, 'manage');
      await db.update(conversations).set({ emoji }).where(eq(conversations.id, id));
      emojiChanged = true;
    }
  }
  const conv = await reloadConversation(db, id);
  for (const line of lines) await publishMessage(deps, conv, 'message.created', line);
  if (lines.length || emojiChanged) await publishConversation(deps, a, conv);
  return conversationView(db, a, conv);
}

/**
 * Open ↔ private for a space channel (its owners and the space's admins). Going private adds
 * everyone in the space now (the caller as owner) so nobody loses it silently; people are then
 * removed by hand. Going open hands it back to the whole space; the rows stay as settings.
 */
async function setPrivate(
  deps: Deps,
  a: ChatActor,
  m: Awaited<ReturnType<typeof requireMember>>,
  makePrivate: boolean,
) {
  const { db } = deps;
  const conv = m.conv;
  if (!conv.spaceId || (conv.type !== 'space' && conv.type !== 'alert')) {
    throw new AppError('bad_request', { reason: 'not_a_space_channel' });
  }
  if (a.actor.orgRole === 'guest') throw new AppError('forbidden');
  const spaceAdmin = can(a.actor, 'space.update_settings', {
    type: 'space',
    org: orgContext(a.org),
    myRole: m.spaceRole,
  });
  // An open channel's owner is whoever opened it (still an editor of the space); a private
  // one's are its owner rows.
  const owner = privateChannel(conv)
    ? m.row?.role === 'owner'
    : conv.createdBy === a.userId &&
      can(a.actor, 'space.chat_create', {
        type: 'space',
        org: orgContext(a.org),
        myRole: m.spaceRole,
      });
  if (!spaceAdmin && !owner) {
    throw new AppError('forbidden');
  }
  if (makePrivate) {
    const everyone = await memberIds(db, conv);
    if (everyone.length > CHAT_LIMITS.privateChannelMembers) throw new AppError('chat_group_full');
    await db.transaction(async (tx) => {
      // Old settings rows were not memberships: people no longer in the space lose theirs, and
      // everyone in the space now becomes a member from now on (settings kept).
      if (everyone.length) {
        await tx
          .delete(conversationMembers)
          .where(
            and(
              eq(conversationMembers.conversationId, conv.id),
              notInArray(conversationMembers.userId, everyone),
            ),
          );
      } else {
        await tx.delete(conversationMembers).where(eq(conversationMembers.conversationId, conv.id));
      }
      await tx
        .update(conversationMembers)
        .set({ role: 'member', createdAt: sql`now()` })
        .where(eq(conversationMembers.conversationId, conv.id));
      await insertMembers(tx, conv, everyone, a.userId, null);
      await tx
        .update(conversationMembers)
        .set({ role: 'owner' })
        .where(
          and(
            eq(conversationMembers.conversationId, conv.id),
            eq(conversationMembers.userId, a.userId),
          ),
        );
      await tx.update(conversations).set({ private: true }).where(eq(conversations.id, conv.id));
    });
    // A private channel is not shared with other orgs (federation: channel.share.end).
    await endSharesOf(deps, a.org.id, conv.id);
  } else {
    await db.update(conversations).set({ private: false }).where(eq(conversations.id, conv.id));
  }
  const fresh = await reloadConversation(db, conv.id);
  return appendSystem(db, fresh, {
    type: makePrivate ? 'made_private' : 'made_open',
    actorId: a.userId,
  });
}

/** Private channels: make a member an owner or back (owners and the space's admins). */
export async function updateMemberRole(
  deps: Deps,
  a: ChatActor,
  id: string,
  userId: string,
  role: 'owner' | 'member',
) {
  const { db } = deps;
  const m = await requireMember(db, a, id);
  if (!privateChannel(m.conv)) throw new AppError('bad_request', { reason: 'not_private' });
  requirePermission(a, m, 'manage');
  const current = new Set(await memberIds(db, m.conv));
  if (!current.has(userId)) throw new AppError('member_not_found');
  if (role === 'member') {
    const owners = await db
      .select({ userId: conversationMembers.userId })
      .from(conversationMembers)
      .where(
        and(eq(conversationMembers.conversationId, id), eq(conversationMembers.role, 'owner')),
      );
    // Never an ownerless channel: make someone else an owner first.
    if (owners.every((o) => o.userId === userId || !current.has(o.userId))) {
      throw new AppError('bad_request', { reason: 'last_owner' });
    }
  }
  await db
    .update(conversationMembers)
    .set({ role })
    .where(and(eq(conversationMembers.conversationId, id), eq(conversationMembers.userId, userId)));
  const conv = await reloadConversation(db, id);
  await publishConversation(deps, a, conv);
  return listMembers(db, a, id);
}

/** "Space'e bağla" (4.6): history and attachments stay; members now come from the space. */
export async function linkConversationSpace(deps: Deps, a: ChatActor, id: string, spaceId: string) {
  const { db } = deps;
  const m = await requireMember(db, a, id);
  if (m.conv.type !== 'group') throw new AppError('bad_request', { reason: 'not_a_group' });
  requirePermission(a, m, 'manage');
  const roles = await mySpaceRoles(db, a.org.id, a.userId);
  requireSpaceAction(a, roles.get(spaceId) ?? null, 'space.chat_create');
  const before = await memberIds(db, m.conv);
  await db.update(conversations).set({ type: 'space', spaceId }).where(eq(conversations.id, id));
  const conv = await reloadConversation(db, id);
  const line = await appendSystem(db, conv, { type: 'linked_space', actorId: a.userId });
  const fresh = await reloadConversation(db, id);
  const after = new Set(await memberIds(db, fresh));
  await publishMessage(deps, fresh, 'message.created', line);
  await publishConversation(deps, a, fresh);
  publishToUsers(
    deps.bus,
    before.filter((u) => !after.has(u)),
    { type: 'conversation.removed', conversationId: id },
  );
  return conversationView(db, a, fresh);
}

/** The caller's member row, created on demand in space conversations. */
async function ownRow(db: DbOrTx, conv: ConversationRow, userId: string) {
  await db
    .insert(conversationMembers)
    .values({
      conversationId: conv.id,
      userId,
      orgId: conv.orgId,
      notify: defaultNotify(conv.type),
    })
    .onConflictDoNothing();
}

export async function updateMyConversation(
  deps: Deps,
  a: ChatActor,
  id: string,
  input: {
    pinned?: boolean | undefined;
    notify?: NotifyLevel | undefined;
    mutedUntil?: string | null | undefined;
    archived?: boolean | undefined;
  },
) {
  const { db } = deps;
  const m = await requireMember(db, a, id);
  await ownRow(db, m.conv, a.userId);
  const patch: Partial<typeof conversationMembers.$inferInsert> = {};
  if (input.archived !== undefined) {
    patch.archivedAt = input.archived ? (m.row?.archivedAt ?? new Date()) : null;
  }
  if (input.notify !== undefined) patch.notify = input.notify;
  if (input.mutedUntil !== undefined) {
    patch.mutedUntil = input.mutedUntil ? new Date(input.mutedUntil) : null;
  }
  if (input.pinned !== undefined) {
    const pinned = await db
      .select({ id: conversationMembers.conversationId, pos: conversationMembers.pinPosition })
      .from(conversationMembers)
      .where(
        and(
          eq(conversationMembers.userId, a.userId),
          eq(conversationMembers.orgId, a.org.id),
          isNotNull(conversationMembers.pinPosition),
        ),
      );
    const already = pinned.some((p) => p.id === id);
    if (input.pinned && !already) {
      if (pinned.length >= CHAT_LIMITS.pinnedConversations) throw new AppError('chat_pin_limit');
      patch.pinnedAt = new Date();
      patch.pinPosition = Math.max(-1, ...pinned.map((p) => p.pos ?? 0)) + 1;
    }
    if (!input.pinned) {
      patch.pinnedAt = null;
      patch.pinPosition = null;
    }
  }
  if (Object.keys(patch).length) {
    await db
      .update(conversationMembers)
      .set(patch)
      .where(
        and(eq(conversationMembers.conversationId, id), eq(conversationMembers.userId, a.userId)),
      );
  }
  const view = await conversationView(db, a, m.conv);
  deps.bus.publish(userTopic(a.userId), { type: 'conversation.updated', conversation: view });
  return view;
}

export async function reorderPinned(deps: Deps, a: ChatActor, ids: string[]) {
  const { db } = deps;
  for (const [pos, id] of ids.entries()) {
    await db
      .update(conversationMembers)
      .set({ pinPosition: pos })
      .where(
        and(
          eq(conversationMembers.conversationId, id),
          eq(conversationMembers.userId, a.userId),
          isNotNull(conversationMembers.pinPosition),
        ),
      );
  }
}

export async function leaveConversation(deps: Deps, a: ChatActor, id: string) {
  const { db } = deps;
  const m = await requireMember(db, a, id);
  if (spaceBound(m.conv) || m.conv.type === 'direct') {
    throw new AppError('bad_request', { reason: 'cannot_leave' });
  }
  await db
    .delete(conversationMembers)
    .where(
      and(eq(conversationMembers.conversationId, id), eq(conversationMembers.userId, a.userId)),
    );
  await ensureOwner(db, m.conv);
  const line = await appendSystem(db, m.conv, { type: 'member_left', actorId: a.userId });
  const conv = await reloadConversation(db, id);
  await publishMessage(deps, conv, 'message.created', line);
  await publishConversation(deps, a, conv);
  deps.bus.publish(userTopic(a.userId), { type: 'conversation.removed', conversationId: id });
}

export async function listMembers(db: DbOrTx, a: ChatActor, id: string): Promise<ChatMember[]> {
  const m = await requireMember(db, a, id);
  const roleOf = (r: string) => r === 'guest';
  if (spaceBound(m.conv)) {
    const rows = await db
      .select({
        user: { id: users.id, name: users.name, email: users.email, image: users.image },
        spaceRole: spaceMembers.role,
        orgRole: orgMembers.role,
        joinedAt: spaceMembers.createdAt,
      })
      .from(spaceMembers)
      .innerJoin(users, eq(users.id, spaceMembers.userId))
      .innerJoin(
        orgMembers,
        and(
          eq(orgMembers.userId, spaceMembers.userId),
          eq(orgMembers.organizationId, a.org.id),
          eq(orgMembers.status, 'active'),
        ),
      )
      .where(eq(spaceMembers.spaceId, m.conv.spaceId!))
      .orderBy(asc(users.name));
    return rows.map((r) => ({
      user: { id: r.user.id, name: r.user.name, email: r.user.email, imageUrl: r.user.image },
      isGuest: roleOf(r.orgRole),
      spaceRole: r.spaceRole,
      joinedAt: r.joinedAt.toISOString(),
    }));
  }
  if (privateChannel(m.conv)) {
    // The channel's rows, still in the space; their space role and channel role show too.
    const rows = await db
      .select({
        user: { id: users.id, name: users.name, email: users.email, image: users.image },
        orgRole: orgMembers.role,
        spaceRole: spaceMembers.role,
        role: conversationMembers.role,
        joinedAt: conversationMembers.createdAt,
      })
      .from(conversationMembers)
      .innerJoin(users, eq(users.id, conversationMembers.userId))
      .innerJoin(
        orgMembers,
        and(
          eq(orgMembers.userId, conversationMembers.userId),
          eq(orgMembers.organizationId, a.org.id),
          eq(orgMembers.status, 'active'),
        ),
      )
      .innerJoin(
        spaceMembers,
        and(
          eq(spaceMembers.userId, conversationMembers.userId),
          eq(spaceMembers.spaceId, m.conv.spaceId!),
          lte(spaceMembers.createdAt, conversationMembers.createdAt),
        ),
      )
      .where(eq(conversationMembers.conversationId, id))
      .orderBy(asc(users.name));
    return rows.map((r) => ({
      user: { id: r.user.id, name: r.user.name, email: r.user.email, imageUrl: r.user.image },
      isGuest: roleOf(r.orgRole),
      spaceRole: r.spaceRole,
      joinedAt: r.joinedAt.toISOString(),
      role: r.role,
    }));
  }
  const rows = await db
    .select({
      user: { id: users.id, name: users.name, email: users.email, image: users.image },
      orgRole: orgMembers.role,
      joinedAt: conversationMembers.createdAt,
    })
    .from(conversationMembers)
    .innerJoin(users, eq(users.id, conversationMembers.userId))
    .innerJoin(
      orgMembers,
      and(
        eq(orgMembers.userId, conversationMembers.userId),
        eq(orgMembers.organizationId, a.org.id),
        eq(orgMembers.status, 'active'),
      ),
    )
    .where(eq(conversationMembers.conversationId, id))
    .orderBy(asc(users.name));
  return rows.map((r) => ({
    user: { id: r.user.id, name: r.user.name, email: r.user.email, imageUrl: r.user.image },
    isGuest: roleOf(r.orgRole),
    spaceRole: null,
    joinedAt: r.joinedAt.toISOString(),
  }));
}

/** First seq a new member sees (design 4.8). */
async function historyStart(db: DbOrTx, conv: ConversationRow, share: HistoryShare) {
  if (share === 'all') return null;
  if (share === 'none') return conv.lastSeq + 1;
  const days = share === 'days7' ? 7 : 30;
  const [row] = await db
    .select({ seq: messages.seq })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conv.id),
        gte(messages.createdAt, sql`now() - make_interval(days => ${days})`),
      ),
    )
    .orderBy(asc(messages.seq))
    .limit(1);
  return row?.seq ?? conv.lastSeq + 1;
}

export async function addMembers(
  deps: Deps,
  a: ChatActor,
  id: string,
  input: { userIds: string[]; history: HistoryShare },
) {
  const { db } = deps;
  const m = await requireMember(db, a, id);
  if (spaceBound(m.conv) || m.conv.type === 'direct') {
    throw new AppError('bad_request', { reason: 'members_follow_space' });
  }
  requirePermission(a, m, 'manage');
  const isPrivate = privateChannel(m.conv);
  const current = new Set(await memberIds(db, m.conv));
  const fresh = [...new Set(input.userIds)].filter((u) => !current.has(u));
  if (isPrivate) {
    await requireChannelPeople(db, a.org.id, m.conv.spaceId!, fresh);
  } else {
    const active = await activeOrgUserIds(db, a.org.id, fresh);
    if (active.size !== fresh.length) throw new AppError('member_not_found');
  }
  const limit = isPrivate ? CHAT_LIMITS.privateChannelMembers : CHAT_LIMITS.groupMembers;
  if (current.size + fresh.length > limit) throw new AppError('chat_group_full');
  if (fresh.length) {
    const from = await historyStart(db, m.conv, input.history);
    if (isPrivate) {
      // A row left over (someone who left the space and came back) starts again as new.
      await db
        .delete(conversationMembers)
        .where(
          and(
            eq(conversationMembers.conversationId, id),
            inArray(conversationMembers.userId, fresh),
          ),
        );
    }
    await insertMembers(db, m.conv, fresh, a.userId, from);
    const line = await appendSystem(db, m.conv, {
      type: 'members_added',
      actorId: a.userId,
      userIds: fresh,
    });
    const conv = await reloadConversation(db, id);
    await publishMessage(deps, conv, 'message.created', line);
    await publishConversation(deps, a, conv);
  }
  return listMembers(db, a, id);
}

export async function removeMember(deps: Deps, a: ChatActor, id: string, userId: string) {
  if (userId === a.userId) return leaveConversation(deps, a, id);
  const { db } = deps;
  const m = await requireMember(db, a, id);
  if (spaceBound(m.conv) || m.conv.type === 'direct') {
    throw new AppError('bad_request', { reason: 'members_follow_space' });
  }
  requirePermission(a, m, 'manage');
  const del = await db
    .delete(conversationMembers)
    .where(and(eq(conversationMembers.conversationId, id), eq(conversationMembers.userId, userId)))
    .returning();
  if (del.length === 0) throw new AppError('member_not_found');
  await ensureOwner(db, m.conv);
  const line = await appendSystem(db, m.conv, {
    type: 'member_removed',
    actorId: a.userId,
    userIds: [userId],
  });
  const conv = await reloadConversation(db, id);
  await publishMessage(deps, conv, 'message.created', line);
  await publishConversation(deps, a, conv);
  deps.bus.publish(userTopic(userId), { type: 'conversation.removed', conversationId: id });
}

/** For `GET /me/unreads`: every visible conversation with unread state. */
export async function unreadSummary(db: DbOrTx, a: ChatActor) {
  const spaceIds = [...(await mySpaceRoles(db, a.org.id, a.userId)).keys()];
  const rows = await db
    .select()
    .from(conversations)
    .where(
      and(
        visibleTo(a.org.id, a.userId, spaceIds),
        isNull(conversations.archivedAt),
        sql`not ${archivedByMe(a.userId)}`,
      ),
    );
  const views = await conversationViews(db, a, rows);
  return views;
}

/**
 * "Benim için sil" (H19): the conversation leaves my list and the messages so far are
 * hidden from me only (seq <= cleared_at_seq); a newer message brings it back clean.
 * Everyone may do it except in space conversations, whose membership follows the space.
 */
export async function clearConversation(deps: Deps, a: ChatActor, id: string) {
  const { db } = deps;
  const m = await requireMember(db, a, id);
  if (spaceBound(m.conv) || privateChannel(m.conv)) {
    throw new AppError('chat_delete_not_allowed', { reason: 'space' });
  }
  await ownRow(db, m.conv, a.userId);
  const seq = m.conv.lastSeq;
  await db.transaction(async (tx) => {
    await tx
      .update(conversationMembers)
      .set({ clearedAtSeq: seq, archivedAt: null })
      .where(
        and(eq(conversationMembers.conversationId, id), eq(conversationMembers.userId, a.userId)),
      );
    // Nothing left to read in what I cleared.
    await markReadTx(tx, a.org.id, id, a.userId, seq);
  });
  await readConversationNotifications(db, deps.bus, a.org.id, a.userId, id, seq);
  // My other devices drop it too.
  deps.bus.publish(userTopic(a.userId), {
    type: 'conversation.removed',
    conversationId: id,
    reason: 'cleared',
  });
}

/** Meeting chats: the meeting's host or a moderator made during it. */
async function meetingModerator(db: DbOrTx, conv: ConversationRow, userId: string) {
  const [row] = await db
    .select({ host: meetings.hostUserId, settings: meetings.settings })
    .from(meetings)
    .where(
      conv.meetingId ? eq(meetings.id, conv.meetingId) : eq(meetings.chatConversationId, conv.id),
    );
  if (!row) return false;
  return row.host === userId || (row.settings.moderatorIds ?? []).includes(userId);
}

/**
 * "Herkes için sil" (H19): messages, reactions, reads and notifications go for everyone,
 * attachments move to the Drive trash (its retention purges them), an audit row stays.
 * Group owner (creator) or org admin; meeting chats: moderator or org admin. Direct and
 * space conversations cannot be deleted for everyone; the org can turn this off.
 */
export async function deleteConversation(deps: Deps, a: ChatActor, id: string, req: RequestInfo) {
  const { db } = deps;
  const m = await requireMember(db, a, id);
  const conv = m.conv;
  if (conv.type === 'direct' || spaceBound(conv)) {
    throw new AppError('chat_delete_not_allowed', {
      reason: conv.type === 'direct' ? 'direct' : 'space',
    });
  }
  if ((a.org.settings as { chatDeleteForEveryone?: boolean }).chatDeleteForEveryone === false) {
    throw new AppError('chat_delete_disabled');
  }
  // Legal hold: a held conversation (its space or a member) is not deleted for everyone.
  if (await conversationHeld(db, a.org.id, conv.id)) throw new AppError('legal_hold');
  const orgAdmin = a.actor.orgRole === 'owner' || a.actor.orgRole === 'admin';
  const allowed =
    orgAdmin ||
    (conv.type === 'meeting'
      ? await meetingModerator(db, conv, a.userId)
      : conv.createdBy === a.userId || (privateChannel(conv) && m.row?.role === 'owner'));
  if (!allowed) throw new AppError('chat_delete_not_allowed', { reason: 'role' });

  const members = await memberIds(db, conv);
  const counts = await db.transaction(async (tx) => {
    // Only files that live in a chat attachments folder and in no other conversation: a
    // file attached from elsewhere in Drive, or moved out of the folder since, stays put.
    const folderNames = [resources.tr.email.chat.folders, resources.en.email.chat.folders].map(
      (f) => f.chatAttachments,
    );
    const trashed = await tx.execute<{ id: string }>(sql`
      update ${nodes} n set deleted_at = now(), deleted_by = ${a.userId}::uuid
      where n.id in (select node_id from ${messageAttachments} where conversation_id = ${conv.id}::uuid)
        and n.deleted_at is null
        and not exists (select 1 from ${messageAttachments} o
          where o.node_id = n.id and o.conversation_id <> ${conv.id}::uuid)
        and exists (select 1 from ${nodes} p
          where p.id = n.parent_id and p.type = 'folder' and p.deleted_at is null
            and (p.id = ${conv.attachmentsNodeId}::uuid
              or (p.parent_id is null and p.name in (${sql.join(
                folderNames.map((x) => sql`${x}`),
                sql`, `,
              )})
                and exists (select 1 from ${spaces} s where s.id = p.space_id and s.kind = 'personal'))))
      returning n.id`);
    const [msgCount] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(messages)
      .where(eq(messages.conversationId, conv.id));
    // Messages, attachments rows, reactions, mentions, reads, members and notifications cascade.
    await tx.delete(conversations).where(eq(conversations.id, conv.id));
    await audit(
      tx,
      {
        orgId: conv.orgId,
        actorId: a.userId,
        action: 'chat.conversation.delete',
        targetType: 'conversation',
        targetId: conv.id,
        meta: {
          type: conv.type,
          name: conv.name,
          messages: msgCount?.n ?? 0,
          attachments: trashed.rows.length,
          members: members.length,
        },
      },
      req,
    );
    return { attachments: trashed.rows.length };
  });
  for (const uid of new Set([...members, a.userId])) {
    deps.bus.publish(userTopic(uid), {
      type: 'conversation.removed',
      conversationId: conv.id,
      reason: 'deleted',
    });
  }
  return counts;
}
