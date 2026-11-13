import { and, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import {
  conversationMembers,
  conversations,
  meetings,
  messages,
  orgMembers,
  spaceMembers,
  spaces,
  type DbOrTx,
} from '@crewhall/db';
import {
  can,
  type ConversationType,
  type NotifyLevel,
  type SpaceAction,
  type SpaceRole,
} from '@crewhall/shared';
import { AppError } from '../../http/errors';
import { orgContext } from '../membership';
import type { DriveActor } from '../drive/access';

export type ChatActor = DriveActor;
export type ConversationRow = typeof conversations.$inferSelect;
export type MemberRow = typeof conversationMembers.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;

/** Space conversations and space-bound alert ones take their members from the space. */
export const spaceBound = (c: Pick<ConversationRow, 'type' | 'spaceId' | 'private'>) =>
  c.spaceId !== null && (c.type === 'space' || c.type === 'alert') && !c.private;

/**
 * A private space channel (Teams-like): its members are its conversation_members rows, and
 * each must be in the space since before their row was written. Leaving the space ends access;
 * coming back to the space does not bring it back (someone adds them again).
 */
export const privateChannel = (c: Pick<ConversationRow, 'type' | 'spaceId' | 'private'>) =>
  c.spaceId !== null && (c.type === 'space' || c.type === 'alert') && c.private;

/** The one membership rule (requireMember and list views agree on it). */
export function isMemberOf(
  conv: Pick<ConversationRow, 'type' | 'spaceId' | 'private'>,
  row: MemberRow | null,
  spaceRole: SpaceRole | null,
  spaceRoomChat: boolean,
  /** When the person joined the conversation's space (private channels). */
  spaceJoinedAt: Date | null = null,
) {
  if (spaceBound(conv)) return spaceRole !== null;
  if (privateChannel(conv)) {
    return (
      row !== null &&
      spaceRole !== null &&
      (spaceJoinedAt === null || row.createdAt.getTime() >= spaceJoinedAt.getTime())
    );
  }
  return row !== null || (spaceRole !== null && spaceRoomChat);
}

/**
 * Notification level for a member without a saved one (doc 17 §10). Groups are small and chosen
 * (CHAT_LIMITS.groupMembers); space channels can hold everyone, so they stay at mentions.
 */
export function defaultNotify(type: ConversationType): NotifyLevel {
  if (type === 'direct' || type === 'group') return 'all';
  if (type === 'alert') return 'critical';
  return 'mentions';
}

/**
 * Private channel rows that count: the person is in the space and was already in it when the
 * row was written (conversation_members in scope as the outer table).
 */
export const inSpaceSinceAdded = (spaceId: string | SQL) =>
  sql`exists (select 1 from ${spaceMembers} sm
    where sm.space_id = ${spaceId}::uuid and sm.user_id = ${conversationMembers.userId}
      and sm.created_at <= ${conversationMembers.createdAt})`;

/** Everyone who belongs to the conversation (active org members only). */
export async function memberIds(db: DbOrTx, conv: ConversationRow): Promise<string[]> {
  if (spaceBound(conv)) {
    const rows = await db
      .select({ userId: spaceMembers.userId })
      .from(spaceMembers)
      .innerJoin(
        orgMembers,
        and(
          eq(orgMembers.userId, spaceMembers.userId),
          eq(orgMembers.organizationId, conv.orgId),
          eq(orgMembers.status, 'active'),
        ),
      )
      .where(eq(spaceMembers.spaceId, conv.spaceId!));
    return rows.map((r) => r.userId);
  }
  const rows = await db
    .select({ userId: conversationMembers.userId })
    .from(conversationMembers)
    .innerJoin(
      orgMembers,
      and(
        eq(orgMembers.userId, conversationMembers.userId),
        eq(orgMembers.organizationId, conv.orgId),
        eq(orgMembers.status, 'active'),
      ),
    )
    .where(
      and(
        eq(conversationMembers.conversationId, conv.id),
        privateChannel(conv) ? inSpaceSinceAdded(conv.spaceId!) : undefined,
      ),
    );
  return rows.map((r) => r.userId);
}

/**
 * Which of these are the chat of a space's permanent room: those are open to the space. Any other
 * meeting's chat belongs to the people invited and the people who joined (conversations.ts ›
 * visibleTo holds the same rule for lists).
 */
export async function spaceRoomChats(
  db: DbOrTx,
  convs: Pick<ConversationRow, 'id' | 'type' | 'spaceId' | 'meetingId'>[],
): Promise<Set<string>> {
  const candidates = convs.filter((c) => c.type === 'meeting' && c.spaceId && c.meetingId);
  if (candidates.length === 0) return new Set();
  const rooms = await db
    .select({ id: meetings.id })
    .from(meetings)
    .where(
      and(
        inArray(
          meetings.id,
          candidates.map((c) => c.meetingId!),
        ),
        eq(meetings.kind, 'room'),
        isNull(meetings.cancelledAt),
      ),
    );
  const roomIds = new Set(rooms.map((r) => r.id));
  return new Set(candidates.filter((c) => roomIds.has(c.meetingId!)).map((c) => c.id));
}

export interface Membership {
  conv: ConversationRow;
  /** The caller's own settings row (may be missing in space conversations). */
  row: MemberRow | null;
  spaceRole: SpaceRole | null;
  isMember: boolean;
}

export async function membershipOf(
  db: DbOrTx,
  conv: ConversationRow,
  userId: string,
): Promise<Membership> {
  const [row] = await db
    .select()
    .from(conversationMembers)
    .where(
      and(eq(conversationMembers.conversationId, conv.id), eq(conversationMembers.userId, userId)),
    );
  let spaceRole: SpaceRole | null = null;
  let spaceJoinedAt: Date | null = null;
  if (conv.spaceId) {
    const [sm] = await db
      .select({ role: spaceMembers.role, joinedAt: spaceMembers.createdAt })
      .from(spaceMembers)
      .innerJoin(spaces, eq(spaces.id, spaceMembers.spaceId))
      .where(
        and(
          eq(spaceMembers.spaceId, conv.spaceId),
          eq(spaceMembers.userId, userId),
          isNull(spaces.deletedAt),
        ),
      );
    spaceRole = sm?.role ?? null;
    spaceJoinedAt = sm?.joinedAt ?? null;
  }
  const roomChat =
    !spaceBound(conv) &&
    !privateChannel(conv) &&
    !row &&
    spaceRole !== null &&
    (await spaceRoomChats(db, [conv])).has(conv.id);
  const isMember = isMemberOf(conv, row ?? null, spaceRole, roomChat, spaceJoinedAt);
  return { conv, row: row ?? null, spaceRole, isMember };
}

export async function loadConversation(db: DbOrTx, orgId: string, conversationId: string) {
  const [conv] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.orgId, orgId)));
  if (!conv) throw new AppError('not_found');
  return conv;
}

/** The conversation if the caller belongs to it; 404 otherwise (existence is not revealed). */
export async function requireMember(db: DbOrTx, a: ChatActor, conversationId: string) {
  const conv = await loadConversation(db, a.org.id, conversationId);
  const m = await membershipOf(db, conv, a.userId);
  if (!m.isMember) throw new AppError('not_found');
  return m;
}

function spaceCan(a: ChatActor, m: Membership, action: SpaceAction) {
  return can(a.actor, action, { type: 'space', org: orgContext(a.org), myRole: m.spaceRole });
}

/** Doc 17 §5 chat rows: space conversations use the space role, others plain membership. */
export function permissionsOf(a: ChatActor, m: Membership) {
  const { conv } = m;
  const live = m.isMember && !conv.archivedAt;
  const orgAdmin = a.actor.orgRole === 'owner' || a.actor.orgRole === 'admin';
  const deleteAllowed =
    (a.org.settings as { chatDeleteForEveryone?: boolean }).chatDeleteForEveryone !== false;
  if (spaceBound(conv)) {
    return {
      clearForMe: false,
      deleteForEveryone: false,
      write: live && spaceCan(a, m, 'space.chat_write'),
      manage: live && spaceCan(a, m, 'space.chat_create'),
      pin: live && spaceCan(a, m, 'space.chat_create'),
      moderate: m.isMember && spaceCan(a, m, 'space.update_settings'),
      manageWebhooks: live && spaceCan(a, m, 'space.chat_create'),
      archive: m.isMember && spaceCan(a, m, 'space.update_settings'),
      // Make it private: the space's admins, or whoever opened it (still an editor there).
      changePrivacy:
        live &&
        a.actor.orgRole !== 'guest' &&
        (spaceCan(a, m, 'space.update_settings') ||
          (conv.createdBy === a.userId && spaceCan(a, m, 'space.chat_create'))),
    };
  }
  const direct = conv.type === 'direct';
  const guest = a.actor.orgRole === 'guest';
  if (privateChannel(conv)) {
    // Owners and the space's admins manage people; writing still follows the space role.
    const spaceAdmin = m.isMember && spaceCan(a, m, 'space.update_settings');
    const owner = m.isMember && m.row?.role === 'owner';
    return {
      clearForMe: false,
      deleteForEveryone:
        m.isMember && deleteAllowed && (orgAdmin || owner || conv.createdBy === a.userId),
      write: live && spaceCan(a, m, 'space.chat_write'),
      manage: live && !guest && (owner || spaceAdmin),
      pin: live && spaceCan(a, m, 'space.chat_write'),
      moderate: spaceAdmin,
      manageWebhooks: live && !guest && (owner || spaceAdmin),
      archive: m.isMember && !guest && (owner || spaceAdmin),
      changePrivacy: live && !guest && (owner || spaceAdmin),
    };
  }
  return {
    clearForMe: m.isMember,
    // Meeting chats: moderators too; the server checks the meeting itself (deleteConversation).
    deleteForEveryone:
      m.isMember && !direct && deleteAllowed && (orgAdmin || conv.createdBy === a.userId),
    write: live,
    manage: live && !direct && !guest,
    pin: live,
    moderate: false,
    manageWebhooks: live && !direct && !guest && (conv.type === 'group' || conv.type === 'alert'),
    archive: m.isMember && !direct && !guest,
    changePrivacy: false,
  };
}

export type Permissions = ReturnType<typeof permissionsOf>;

export function requirePermission(a: ChatActor, m: Membership, key: keyof Permissions) {
  if (m.conv.archivedAt && key === 'write') throw new AppError('chat_archived');
  if (!permissionsOf(a, m)[key]) throw new AppError('forbidden');
}

/** First seq the member may see (history shared when they were added). */
/**
 * First seq the caller may see: after "added without history" and after their own
 * "Benim için sil" (H19), whichever is later.
 */
export const historyFromRow = (
  row: Pick<MemberRow, 'historyFromSeq' | 'clearedAtSeq'> | null | undefined,
) => Math.max(row?.historyFromSeq ?? 0, row?.clearedAtSeq == null ? 0 : row.clearedAtSeq + 1);
export const historyFrom = (m: Pick<Membership, 'row'>) => historyFromRow(m.row);

/** `/whisper` (roadmap 23): visible to its author and the person it was sent to only. */
export const whisperVisible = (userId: string) =>
  sql`(${messages.whisperTo} is null or ${messages.whisperTo} = ${userId}::uuid or ${messages.authorId} = ${userId}::uuid)`;

export const canSeeMessage = (row: Pick<MessageRow, 'whisperTo' | 'authorId'>, userId: string) =>
  !row.whisperTo || row.whisperTo === userId || row.authorId === userId;

/** Who receives events about a message: the whisper pair, or everyone in the conversation. */
export async function audienceOf(
  db: DbOrTx,
  conv: ConversationRow,
  row: Pick<MessageRow, 'whisperTo' | 'authorId'>,
) {
  if (row.whisperTo) {
    return [...new Set([row.whisperTo, ...(row.authorId ? [row.authorId] : [])])];
  }
  return memberIds(db, conv);
}

export async function requireMessage(db: DbOrTx, a: ChatActor, messageId: string) {
  const [msg] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.id, messageId), eq(messages.orgId, a.org.id)));
  if (!msg || !canSeeMessage(msg, a.userId)) throw new AppError('not_found');
  const m = await requireMember(db, a, msg.conversationId);
  if (msg.seq < historyFrom(m)) throw new AppError('not_found');
  return { msg, m };
}

/** Spaces of the org the person belongs to, with their role (for list queries). */
export async function mySpaceRoles(db: DbOrTx, orgId: string, userId: string) {
  const rows = await db
    .select({ spaceId: spaceMembers.spaceId, role: spaceMembers.role })
    .from(spaceMembers)
    .innerJoin(spaces, eq(spaces.id, spaceMembers.spaceId))
    .where(and(eq(spaceMembers.userId, userId), eq(spaces.orgId, orgId), isNull(spaces.deletedAt)));
  return new Map(rows.map((r) => [r.spaceId, r.role]));
}

/** Active org members among `userIds` (people one can add to a conversation). */
export async function activeOrgUserIds(db: DbOrTx, orgId: string, userIds: string[]) {
  if (userIds.length === 0) return new Set<string>();
  const rows = await db
    .select({ userId: orgMembers.userId })
    .from(orgMembers)
    .where(
      and(
        eq(orgMembers.organizationId, orgId),
        eq(orgMembers.status, 'active'),
        inArray(orgMembers.userId, userIds),
      ),
    );
  return new Set(rows.map((r) => r.userId));
}
