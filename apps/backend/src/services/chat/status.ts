import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  chatUserSettings,
  conversations,
  orgMembers,
  reactions,
  spaces,
  users,
  type DbOrTx,
} from '@crewhall/db';
import { guestPeers } from '../guests';
import type { ChatUserCard, Presence, UserStatus } from '@crewhall/shared';
import type { Deps } from '../../deps';
import { AppError } from '../../http/errors';
import type { StatusChoice } from '../../realtime/presence';
import {
  ensureSettings,
  liveVisibility,
  loadSettings,
  type SettingsRow,
} from '../notifications/prefs';
import { mySpaceRoles, type ChatActor } from './access';
import { visibleTo } from './conversations';
import { conversationViews } from './views';

/** Status (design 19.15): visibility and message are separate; both may expire. */
function toStatus(s: SettingsRow): UserStatus {
  const now = Date.now();
  const msgLive = s.statusText && (!s.statusExpiresAt || s.statusExpiresAt.getTime() > now);
  const until = s.visibilityUntil && s.visibilityUntil.getTime() > now ? s.visibilityUntil : null;
  return {
    visibility: liveVisibility(s),
    visibilityUntil: until?.toISOString() ?? null,
    message: msgLive
      ? {
          text: s.statusText!,
          emoji: s.statusEmoji,
          expiresAt: s.statusExpiresAt?.toISOString() ?? null,
        }
      : null,
    autoMeeting: s.autoMeeting,
  };
}

export function toChoice(s: SettingsRow): StatusChoice {
  return {
    visibility: s.visibility,
    visibilityUntil: s.visibilityUntil,
    message: s.statusText
      ? { text: s.statusText, emoji: s.statusEmoji, expiresAt: s.statusExpiresAt }
      : null,
    autoMeeting: s.autoMeeting,
  };
}

export async function statusChoice(db: DbOrTx, orgId: string, userId: string) {
  const s = (await loadSettings(db, orgId, [userId])).get(userId)!;
  return toChoice(s);
}

export async function getMyStatus(db: DbOrTx, a: ChatActor) {
  return toStatus((await loadSettings(db, a.org.id, [a.userId])).get(a.userId)!);
}

export async function updateMyStatus(
  deps: Deps,
  a: ChatActor,
  input: {
    visibility?: UserStatus['visibility'] | undefined;
    visibilityUntil?: string | null | undefined;
    message?: { text: string; emoji: string | null; expiresAt: string | null } | null | undefined;
    autoMeeting?: boolean | undefined;
  },
) {
  const { db } = deps;
  await ensureSettings(db, a.org.id, a.userId);
  const patch: Partial<typeof chatUserSettings.$inferInsert> = {};
  if (input.visibility !== undefined) {
    patch.visibility = input.visibility;
    // A new choice without an end time keeps until changed.
    if (input.visibilityUntil === undefined) patch.visibilityUntil = null;
  }
  if (input.visibilityUntil !== undefined) {
    patch.visibilityUntil = input.visibilityUntil ? new Date(input.visibilityUntil) : null;
  }
  if (input.message !== undefined) {
    patch.statusText = input.message?.text ?? null;
    patch.statusEmoji = input.message?.emoji ?? null;
    patch.statusExpiresAt = input.message?.expiresAt ? new Date(input.message.expiresAt) : null;
  }
  if (input.autoMeeting !== undefined) patch.autoMeeting = input.autoMeeting;
  if (Object.keys(patch).length) {
    await db
      .update(chatUserSettings)
      .set(patch)
      .where(and(eq(chatUserSettings.orgId, a.org.id), eq(chatUserSettings.userId, a.userId)));
  }
  const s = (await loadSettings(db, a.org.id, [a.userId])).get(a.userId)!;
  deps.presence.setChoice(a.userId, toChoice(s));
  return toStatus(s);
}

export async function getChatSettings(db: DbOrTx, a: ChatActor) {
  const s = (await loadSettings(db, a.org.id, [a.userId])).get(a.userId)!;
  const recent = await db
    .select({ emoji: reactions.emoji, at: sql<Date>`max(${reactions.createdAt})` })
    .from(reactions)
    .where(and(eq(reactions.userId, a.userId), eq(reactions.orgId, a.org.id)))
    .groupBy(reactions.emoji)
    .orderBy(desc(sql`max(${reactions.createdAt})`))
    .limit(5);
  return {
    // Deprecated: kept for older clients, always on (there is no hiding).
    readReceipts: true,
    timezone: s.timezone,
    recentEmojis: recent.map((r) => r.emoji),
  };
}

export async function updateChatSettings(
  db: DbOrTx,
  a: ChatActor,
  input: { readReceipts?: boolean | undefined; timezone?: string | null | undefined },
) {
  if (input.timezone) {
    try {
      new Intl.DateTimeFormat('en', { timeZone: input.timezone });
    } catch {
      throw new AppError('validation_failed', {
        in: 'body',
        issues: [{ path: ['timezone'], code: 'invalid_value', message: 'unknown time zone' }],
      });
    }
  }
  await ensureSettings(db, a.org.id, a.userId);
  const patch: Partial<typeof chatUserSettings.$inferInsert> = {};
  // input.readReceipts is accepted and ignored (deprecated; reads are always shared).
  if (input.timezone !== undefined) patch.timezone = input.timezone;
  if (Object.keys(patch).length) {
    await db
      .update(chatUserSettings)
      .set(patch)
      .where(and(eq(chatUserSettings.orgId, a.org.id), eq(chatUserSettings.userId, a.userId)));
  }
  return getChatSettings(db, a);
}

/** Snapshot for people: live presence when connected, else offline with last seen. */
export async function presenceOf(
  deps: Pick<Deps, 'db' | 'presence'>,
  a: ChatActor,
  userIds: string[],
): Promise<Presence[]> {
  const ids = [...new Set(userIds)];
  const members = await deps.db
    .select({ userId: orgMembers.userId, lastSeenAt: users.lastSeenAt })
    .from(orgMembers)
    .innerJoin(users, eq(users.id, orgMembers.userId))
    .where(
      and(
        eq(orgMembers.organizationId, a.org.id),
        inArray(orgMembers.userId, ids),
        // Guests see presence only of the people they can reach.
        a.actor.orgRole === 'guest'
          ? sql`${orgMembers.userId} in ${guestPeers(a.userId)}`
          : undefined,
      ),
    );
  const settings = await loadSettings(
    deps.db,
    a.org.id,
    members.map((m) => m.userId),
  );
  return members.map((m) => {
    const live = deps.presence.get(m.userId);
    if (live) return live;
    const s = toStatus(settings.get(m.userId)!);
    return {
      userId: m.userId,
      state: 'offline' as const,
      auto: null,
      message: s.message,
      lastSeenAt: m.lastSeenAt?.toISOString() ?? null,
    };
  });
}

/** Person card (19.13): only spaces and conversations both people share. */
export async function userCard(
  deps: Pick<Deps, 'db' | 'presence'>,
  a: ChatActor,
  userId: string,
): Promise<ChatUserCard> {
  const { db } = deps;
  const [row] = await db
    .select({ user: users, role: orgMembers.role })
    .from(orgMembers)
    .innerJoin(users, eq(users.id, orgMembers.userId))
    .where(and(eq(orgMembers.organizationId, a.org.id), eq(orgMembers.userId, userId)));
  if (!row) throw new AppError('member_not_found');
  const mine = await mySpaceRoles(db, a.org.id, a.userId);
  const theirs = await mySpaceRoles(db, a.org.id, userId);
  const shared = [...mine.keys()].filter((id) => theirs.has(id));
  const sharedSpaces = shared.length
    ? await db
        .select({ id: spaces.id, name: spaces.name, color: spaces.color, kind: spaces.kind })
        .from(spaces)
        .where(inArray(spaces.id, shared))
    : [];
  // Guests only see people they share a conversation with.
  const myVisible = await db
    .select()
    .from(conversations)
    .where(visibleTo(a.org.id, a.userId, [...mine.keys()]));
  const theirVisible = new Set(
    (
      await db
        .select({ id: conversations.id })
        .from(conversations)
        .where(visibleTo(a.org.id, userId, [...theirs.keys()]))
    ).map((c) => c.id),
  );
  const common = myVisible.filter((c) => theirVisible.has(c.id) && !c.archivedAt);
  if (a.actor.orgRole === 'guest' && common.length === 0 && userId !== a.userId) {
    throw new AppError('member_not_found');
  }
  const views = await conversationViews(db, a, common.slice(0, 50));
  const direct = common.find((c) => c.type === 'direct');
  const settings = (await loadSettings(db, a.org.id, [userId])).get(userId)!;
  const [presence] = await presenceOf(deps, a, [userId]);
  return {
    user: { id: row.user.id, name: row.user.name, email: row.user.email, imageUrl: row.user.image },
    orgRole: row.role,
    isGuest: row.role === 'guest',
    presence: presence!,
    timezone: settings.timezone,
    sharedSpaces: sharedSpaces
      .filter((s) => s.kind === 'shared')
      .map((s) => ({ id: s.id, name: s.name, color: s.color })),
    sharedConversations: views
      .filter((v) => v.type !== 'direct')
      .map((v) => ({ id: v.id, type: v.type, title: v.title })),
    directConversationId: direct?.id ?? null,
  };
}
