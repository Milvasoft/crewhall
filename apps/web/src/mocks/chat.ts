import {
  NOTIFICATION_GROUPS,
  type ChatMember,
  type Conversation,
  type IncomingWebhook,
  type Message,
  type MessageGif,
  type MessageRef,
  paths,
  type ResolvedRef,
  withQuery,
  type ModuleEndpointName,
  type Notification,
  type NotificationChannel,
  type Presence,
  type ScheduledMessage,
  type RemoteUser,
  type SpaceRole,
  type UserSummary,
  type WsServerEvent,
  CHAT_LIMITS,
  WEBHOOK_PROVIDER_EVENTS,
  GoogleChatPayload,
  GIF_BUDGET,
  isGiphyMediaUrl,
  isReactionEmoji,
  HookPayload,
  messageSeverity,
  type NOTIFICATION_TYPES,
  NotificationCategory,
  NotificationSource,
  WsClientEvent,
} from '@crewhall/shared';
import { http, HttpResponse, ws } from 'msw';
import { type z } from 'zod';
import { MockApiError, myRole, randomToken, requireUser, summary, type Resolvers } from './core';
import { db, newId, save } from './db';
import { driveState, nodeForUser } from './drive';
import { MOCK_FEDERATION_DOMAIN, remoteLookup } from './federation';
import {
  CONV,
  seedChat,
  type ChatState,
  type MockChatMember,
  type MockConversation,
  type MockMessage,
  type MockNotification,
  type MockPoll,
  type MockReminder,
  type MockScheduled,
  type MockWebhook,
} from './chatSeed';
import { type MockState, type MockUser } from './seed';

/**
 * Chat part of the contract mock (design 04, 19.13-19.17): conversations, messages with seq,
 * reads, reactions, pins, search, attachments in Drive, presence, notifications, incoming
 * webhooks, and the /ws gateway (MSW WebSocket link) that fans events out to this tab.
 */

type ChatEndpoint = Extract<
  ModuleEndpointName,
  | 'createWsTicket'
  | 'getUnreads'
  | 'listConversations'
  | 'createConversation'
  | 'getConversation'
  | 'updateConversation'
  | 'linkConversationSpace'
  | 'updateMyConversation'
  | 'leaveConversation'
  | 'createRemoteConversation'
  | 'addRemoteConversationMember'
  | 'shareNodeRemote'
  | 'clearConversation'
  | 'deleteConversation'
  | 'reorderPinnedConversations'
  | 'listConversationMembers'
  | 'addConversationMembers'
  | 'removeConversationMember'
  | 'updateConversationMember'
  | 'listReadReceipts'
  | 'markConversationRead'
  | 'markConversationUnread'
  | 'listMessages'
  | 'sendMessage'
  | 'updateMessage'
  | 'deleteMessage'
  | 'addReaction'
  | 'removeReaction'
  | 'pinMessage'
  | 'unpinMessage'
  | 'resolveChatRefs'
  | 'searchChatRefs'
  | 'claimMessage'
  | 'unclaimMessage'
  | 'removeChatLinkPreview'
  | 'listPinnedMessages'
  | 'searchMessages'
  | 'getChatAttachmentFolder'
  | 'listChatFiles'
  | 'getChatAttachmentUrl'
  | 'getChatUserCard'
  | 'getPresence'
  | 'getMyStatus'
  | 'updateMyStatus'
  | 'getChatSettings'
  | 'updateChatSettings'
  | 'listNotifications'
  | 'getNotificationCounts'
  | 'updateNotifications'
  | 'getNotificationPrefs'
  | 'updateNotificationPrefs'
  | 'registerPushDevice'
  | 'unregisterPushDevice'
  | 'listPushDevices'
  | 'listIncomingWebhooks'
  | 'createIncomingWebhook'
  | 'updateIncomingWebhook'
  | 'deleteIncomingWebhook'
  | 'regenerateIncomingWebhookKey'
  | 'listWebhookDeliveries'
  | 'createPoll'
  | 'votePoll'
  | 'closePoll'
  | 'listChatReminders'
  | 'createChatReminder'
  | 'deleteChatReminder'
  | 'listScheduledMessages'
  | 'createScheduledMessage'
  | 'updateScheduledMessage'
  | 'deleteScheduledMessage'
  | 'sendScheduledMessageNow'
  | 'trendingGifs'
  | 'getMessageInfo'
  | 'searchGifs'
  | 'getGifSettings'
  | 'updateGifSettings'
  | 'testGifSettings'
>;

const now = () => new Date().toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;

type WithChat = MockState & { chat?: ChatState };

export function chatState(s: MockState = db()): ChatState {
  const x = s as WithChat;
  x.chat ??= seedChat(driveState(s));
  return x.chat;
}

// ---- lookups ----

function userById(s: MockState, id: string | null): MockUser | null {
  return id ? (s.users.find((u) => u.id === id) ?? null) : null;
}

function summaryOf(s: MockState, id: string | null): UserSummary | null {
  const u = userById(s, id);
  return u ? summary(u) : null;
}

function firstName(name: string): string {
  return name.split(/\s+/)[0] ?? name;
}

function rowsOf(c: ChatState, convId: string): MockChatMember[] {
  return c.members.filter((m) => m.conversationId === convId);
}

function rowOf(c: ChatState, convId: string, userId: string): MockChatMember | undefined {
  return c.members.find((m) => m.conversationId === convId && m.userId === userId);
}

function convOf(c: ChatState, id: string): MockConversation {
  const cv = c.conversations.find((x) => x.id === id);
  if (!cv) throw new MockApiError('not_found');
  return cv;
}

/** The caller must be a member; a non-member gets 404 so the chat's existence does not leak. */
function access(s: MockState, u: MockUser, convId: string) {
  const c = chatState(s);
  const conv = convOf(c, convId);
  const row = rowOf(c, convId, u.id);
  if (!row) throw new MockApiError('not_found');
  return { c, conv, row };
}

function spaceRoleOf(s: MockState, conv: MockConversation, userId: string): SpaceRole | null {
  return conv.spaceId ? myRole(s, conv.spaceId, userId) : null;
}

const RANK: Record<SpaceRole, number> = { viewer: 0, editor: 1, admin: 2, owner: 3 };
const atLeast = (r: SpaceRole | null, min: SpaceRole) => r !== null && RANK[r] >= RANK[min];

function permissions(s: MockState, conv: MockConversation, userId: string) {
  const role = spaceRoleOf(s, conv, userId);
  const spaced = conv.type === 'space' || (conv.type === 'alert' && conv.spaceId !== null);
  const archived = conv.archivedAt !== null;
  if (spaced && conv.private) {
    const owner = rowOf(chatState(s), conv.id, userId)?.role === 'owner';
    const lead = owner || atLeast(role, 'admin');
    return {
      write: !archived && atLeast(role, 'viewer'),
      manage: !archived && lead,
      pin: !archived && atLeast(role, 'viewer'),
      moderate: atLeast(role, 'admin'),
      manageWebhooks: !archived && lead,
      archive: lead,
      changePrivacy: !archived && lead,
      clearForMe: false,
      deleteForEveryone:
        s.org?.settings.chatDeleteForEveryone !== false &&
        (isOrgAdmin(s, userId) || owner || conv.createdBy === userId),
    };
  }
  return {
    write: !archived && (!spaced || atLeast(role, 'viewer')),
    manage:
      !archived &&
      (conv.type === 'group' || (spaced ? atLeast(role, 'admin') : conv.type === 'alert')),
    pin:
      !archived &&
      (conv.type === 'direct' || conv.type === 'group' || atLeast(role, 'editor') || !spaced),
    moderate: spaced && atLeast(role, 'admin'),
    manageWebhooks:
      !archived && conv.type !== 'direct' && (spaced ? atLeast(role, 'editor') : true),
    archive: spaced && atLeast(role, 'admin'),
    changePrivacy:
      spaced &&
      !archived &&
      (atLeast(role, 'admin') || (conv.createdBy === userId && atLeast(role, 'editor'))),
    clearForMe: conv.type !== 'space',
    deleteForEveryone:
      conv.type !== 'direct' &&
      conv.type !== 'space' &&
      s.org?.settings.chatDeleteForEveryone !== false &&
      (isOrgAdmin(s, userId) || conv.createdBy === userId),
  };
}

function isOrgAdmin(s: MockState, userId: string): boolean {
  const role = s.members.find((m) => m.userId === userId)?.role;
  return role === 'owner' || role === 'admin';
}

function titleOf(s: MockState, c: ChatState, conv: MockConversation, userId: string): string {
  if (conv.name) return conv.name;
  const others = rowsOf(c, conv.id)
    .filter((m) => m.userId !== userId)
    .map((m) => userById(s, m.userId))
    .filter((u): u is MockUser => u !== null);
  if (conv.type === 'direct') return others[0]?.name ?? '';
  return others.map((u) => firstName(u.name)).join(', ');
}

const TOKEN = /<@([0-9a-zA-Z-]+)>/g;

function mentionsOf(text: string) {
  const out: { kind: 'user' | 'all' | 'here'; userId: string | null }[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(TOKEN)) {
    const id = m[1] ?? '';
    if (seen.has(id)) continue;
    seen.add(id);
    if (id === 'all' || id === 'here') out.push({ kind: id, userId: null });
    else out.push({ kind: 'user', userId: id });
  }
  return out;
}

function plain(s: MockState, text: string): string {
  return text
    .replace(TOKEN, (_, id: string) =>
      id === 'all'
        ? '@herkes'
        : id === 'here'
          ? '@burada'
          : `@${firstName(userById(s, id)?.name ?? '…')}`,
    )
    .replace(/```[a-zA-Z0-9#+-]*\n?/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function excerptOf(s: MockState, m: MockMessage): string | null {
  if (m.deletedAt) return null;
  return (plain(s, m.text) || m.card?.title || '').slice(0, 200);
}

function visibleTo(row: MockChatMember | undefined, m: MockMessage): boolean {
  if (!row) return false;
  if (m.whisperTo && m.whisperTo !== row.userId && m.authorId !== row.userId) return false;
  if (row.clearedAtSeq != null && m.seq <= row.clearedAtSeq) return false;
  return row.historyFromSeq === null || m.seq >= row.historyFromSeq;
}

function mentionsUser(m: MockMessage, userId: string): boolean {
  return mentionsOf(m.text).some((x) => x.kind !== 'user' || x.userId === userId);
}

function counts(c: ChatState, conv: MockConversation, row: MockChatMember) {
  let unread = 0;
  let unreadMentions = 0;
  for (const m of c.messages) {
    if (m.conversationId !== conv.id || m.seq <= row.lastReadSeq) continue;
    if (!visibleTo(row, m) || m.authorId === row.userId || m.kind === 'system' || m.deletedAt) {
      continue;
    }
    unread++;
    if (mentionsUser(m, row.userId)) unreadMentions++;
  }
  // Marked unread on purpose: at least one, even when only my messages follow.
  if (row.markedUnread) unread = Math.max(1, unread);
  return { unread, unreadMentions };
}

function lastMessage(s: MockState, c: ChatState, conv: MockConversation, row: MockChatMember) {
  let last: MockMessage | undefined;
  for (const m of c.messages) {
    if (m.conversationId === conv.id && visibleTo(row, m) && (!last || m.seq > last.seq)) last = m;
  }
  return last;
}

function toConversation(s: MockState, conv: MockConversation, userId: string): Conversation {
  const c = chatState(s);
  const row = rowOf(c, conv.id, userId)!;
  const last = lastMessage(s, c, conv, row);
  const space = conv.spaceId ? s.spaces.find((x) => x.id === conv.spaceId) : undefined;
  const peerId =
    conv.type === 'direct' ? rowsOf(c, conv.id).find((m) => m.userId !== userId)?.userId : null;
  return {
    id: conv.id,
    type: conv.type,
    spaceId: conv.spaceId,
    spaceName: space?.name ?? null,
    spaceColor: space?.color ?? null,
    meetingId: conv.meetingId,
    name: conv.name,
    emoji: conv.emoji ?? null,
    ...(conv.spaceId && (conv.type === 'space' || conv.type === 'alert')
      ? { private: conv.private ?? false }
      : {}),
    title: titleOf(s, c, conv, userId),
    avatarUrl: null,
    peer: peerId ? summaryOf(s, peerId) : null,
    memberCount: rowsOf(c, conv.id).length,
    lastSeq: conv.lastSeq,
    lastMessageAt: last?.createdAt ?? null,
    lastMessage: last
      ? {
          seq: last.seq,
          kind: last.kind,
          authorId: last.authorId,
          authorName:
            userById(s, last.authorId)?.name ??
            c.webhooks.find((w) => w.id === last.webhookId)?.name ??
            null,
          excerpt: excerptOf(s, last),
          hasAttachments: last.attachments.length > 0,
          deleted: last.deletedAt !== null,
          createdAt: last.createdAt,
        }
      : null,
    attachmentsNodeId: conv.attachmentsNodeId,
    hasWebhooks: c.webhooks.some((w) => w.conversationId === conv.id),
    archivedAt: conv.archivedAt,
    createdBy: conv.createdBy,
    createdAt: conv.createdAt,
    my: {
      pinnedAt: row.pinnedAt,
      pinPosition: row.pinPosition,
      notify: row.notify,
      mutedUntil: row.mutedUntil,
      lastReadSeq: row.lastReadSeq,
      ...counts(c, conv, row),
      historyFromSeq: row.historyFromSeq,
      archivedAt: row.archivedAt ?? null,
      clearedAtSeq: row.clearedAtSeq ?? null,
    },
    permissions: permissions(s, conv, userId),
    ...(conv.federation ? { federation: conv.federation } : {}),
  };
}

function toMessage(s: MockState, m: MockMessage, userId: string): Message {
  const c = chatState(s);
  const hook = m.webhookId ? c.webhooks.find((w) => w.id === m.webhookId) : undefined;
  const reply = m.replyToId ? c.messages.find((x) => x.id === m.replyToId) : undefined;
  const d = driveState(s);
  const deleted = m.deletedAt !== null;
  return {
    id: m.id,
    conversationId: m.conversationId,
    seq: m.seq,
    kind: m.kind,
    author: summaryOf(s, m.authorId),
    webhook: hook ? { id: hook.id, name: hook.name, avatarUrl: hook.avatarUrl } : null,
    text: deleted ? '' : m.text,
    mentions: deleted ? [] : mentionsOf(m.text),
    card: deleted ? null : m.card,
    ...(m.severity ? { severity: m.severity } : {}),
    system: m.system,
    attachments: deleted
      ? []
      : m.attachments.map((a) => {
          const n = d.nodes.find((x) => x.id === a.nodeId);
          return { ...a, name: n?.name ?? a.name, removed: !n || n.deletedAt !== null };
        }),
    replyTo: reply
      ? {
          id: reply.id,
          seq: reply.seq,
          author: summaryOf(s, reply.authorId),
          webhookName: c.webhooks.find((w) => w.id === reply.webhookId)?.name ?? null,
          ...(reply.guestAuthor ? { guestAuthor: reply.guestAuthor } : {}),
          excerpt: excerptOf(s, reply),
          hasAttachments: reply.attachments.length > 0,
          deleted: reply.deletedAt !== null,
        }
      : null,
    reactions: deleted
      ? []
      : m.reactions
          .filter((r) => r.userIds.length > 0)
          .map((r) => ({
            emoji: r.emoji,
            count: r.userIds.length,
            userIds: r.userIds.slice(0, 20),
            mine: r.userIds.includes(userId),
          })),
    clientMsgId: m.clientMsgId,
    via: deleted ? null : (m.via ?? null),
    ...(m.remoteAuthor ? { remoteAuthor: m.remoteAuthor } : {}),
    ...(m.guestAuthor ? { guestAuthor: m.guestAuthor } : {}),
    emote: !deleted && m.emote === true,
    whisperTo: summaryOf(s, m.whisperTo ?? null),
    poll: !deleted && m.poll ? pollView(m.poll) : null,
    gif: !deleted ? (m.gif ?? null) : null,
    refs: !deleted ? (m.refs ?? []) : [],
    linkPreview: !deleted ? (m.linkPreview ?? null) : null,
    claim:
      !deleted && m.claim && summaryOf(s, m.claim.userId)
        ? { user: summaryOf(s, m.claim.userId)!, at: m.claim.at }
        : null,
    pinnedAt: m.pinnedAt,
    editedAt: m.editedAt,
    deletedAt: m.deletedAt,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
  };
}

function pollView(p: MockPoll): NonNullable<Message['poll']> {
  return {
    id: p.id,
    question: p.question,
    multiple: p.multiple,
    closedAt: p.closedAt,
    createdBy: p.createdBy,
    voterCount: new Set(p.votes.map((v) => v.userId)).size,
    options: p.options.map((text, index) => {
      const userIds = p.votes.filter((v) => v.option === index).map((v) => v.userId);
      return { index, text, count: userIds.length, userIds };
    }),
  };
}

function pollOf(s: MockState, u: MockUser, pollId: string) {
  const m = chatState(s).messages.find((x) => x.poll?.id === pollId && !x.deletedAt);
  if (!m?.poll) throw new MockApiError('not_found');
  return { ...messageOf(s, u, m.id), poll: m.poll };
}

function remindersOf(s: MockState): MockReminder[] {
  const c = chatState(s);
  c.reminders ??= [];
  return c.reminders;
}

function messageOf(s: MockState, u: MockUser, messageId: string) {
  const c = chatState(s);
  const m = c.messages.find((x) => x.id === messageId);
  if (!m) throw new MockApiError('not_found');
  const a = access(s, u, m.conversationId);
  if (!visibleTo(a.row, m)) throw new MockApiError('not_found');
  return { ...a, m };
}

// ---- realtime fan-out ----

interface Connection {
  userId: string;
  send: (e: WsServerEvent) => void;
}
const connections = new Set<Connection>();

/** Event built per recipient (unread counts, "mine" on reactions differ per person). */
function emitTo(userIds: Iterable<string>, build: (userId: string) => WsServerEvent | null): void {
  const ids = new Set(userIds);
  for (const conn of connections) {
    if (!ids.has(conn.userId)) continue;
    const e = build(conn.userId);
    if (e) conn.send(e);
  }
}

/** Other mock modules (meet calls) push events to the simulated sockets. */
export function emitToUsers(userIds: Iterable<string>, event: WsServerEvent): void {
  emitTo(userIds, () => event);
}

function emitConversation(
  s: MockState,
  convId: string,
  build: (userId: string) => WsServerEvent | null,
) {
  emitTo(
    rowsOf(chatState(s), convId).map((m) => m.userId),
    build,
  );
}

function emitConvUpdated(s: MockState, conv: MockConversation, userIds?: string[]) {
  const c = chatState(s);
  emitTo(userIds ?? rowsOf(c, conv.id).map((m) => m.userId), (uid) =>
    rowOf(c, conv.id, uid)
      ? { type: 'conversation.updated', conversation: toConversation(s, conv, uid) }
      : null,
  );
}

function emitMessage(s: MockState, m: MockMessage, type: 'message.created' | 'message.updated') {
  const c = chatState(s);
  emitConversation(s, m.conversationId, (uid) =>
    visibleTo(rowOf(c, m.conversationId, uid), m)
      ? { type, conversationId: m.conversationId, message: toMessage(s, m, uid) }
      : null,
  );
}

// ---- writes shared by HTTP, webhooks and the reply simulation ----

function append(
  s: MockState,
  conv: MockConversation,
  m: Omit<MockMessage, 'id' | 'conversationId' | 'seq' | 'createdAt' | 'updatedAt'>,
): MockMessage {
  const c = chatState(s);
  conv.lastSeq += 1;
  const at = now();
  const msg: MockMessage = {
    ...m,
    id: newId(),
    conversationId: conv.id,
    seq: conv.lastSeq,
    createdAt: at,
    updatedAt: at,
  };
  c.messages.push(msg);
  if (msg.authorId) {
    const row = rowOf(c, conv.id, msg.authorId);
    if (row) {
      row.lastReadSeq = msg.seq;
      row.markedUnread = false;
    }
  }
  emitMessage(s, msg, 'message.created');
  notifyFor(s, conv, msg);
  return msg;
}

function systemLine(s: MockState, conv: MockConversation, system: MockMessage['system']) {
  return append(s, conv, {
    kind: 'system',
    authorId: null,
    webhookId: null,
    text: '',
    card: null,
    system,
    attachments: [],
    replyToId: null,
    reactions: [],
    clientMsgId: null,
    pinnedAt: null,
    pinnedBy: null,
    editedAt: null,
    deletedAt: null,
  });
}

function addNotification(
  s: MockState,
  n: Omit<
    MockNotification,
    'id' | 'createdAt' | 'updatedAt' | 'count' | 'readAt' | 'snoozedUntil' | 'dismissedAt'
  >,
) {
  const c = chatState(s);
  const row: MockNotification = {
    ...n,
    id: newId(),
    count: 1,
    readAt: null,
    snoozedUntil: null,
    dismissedAt: null,
    createdAt: now(),
    updatedAt: now(),
  };
  c.notifications.push(row);
  emitTo([n.userId], () => ({
    type: 'notification',
    notification: toNotification(s, row),
    unreadCount: notificationCounts(s, n.userId).unread,
  }));
}

/** Mentions, direct messages and replies notify (doc 17 §10); muted chats only on mention. */
function notifyFor(s: MockState, conv: MockConversation, m: MockMessage) {
  const c = chatState(s);
  const title = (uid: string) => titleOf(s, c, conv, uid);
  const reply = m.replyToId ? c.messages.find((x) => x.id === m.replyToId) : undefined;
  for (const row of rowsOf(c, conv.id)) {
    const uid = row.userId;
    if (uid === m.authorId) continue;
    const mention = mentionsUser(m, uid);
    const muted =
      row.notify === 'none' || (row.mutedUntil !== null && Date.parse(row.mutedUntil) > Date.now());
    let type: (typeof NOTIFICATION_TYPES)[number] | null = null;
    let category: NotificationCategory = 'mention';
    if (mention) type = 'chat.mention';
    else if (muted) continue;
    else if (conv.type === 'direct') {
      type = 'chat.direct';
      category = 'direct_reply';
    } else if (reply?.authorId === uid) {
      type = 'chat.reply';
      category = 'direct_reply';
    } else if (messageSeverity(m) === 'critical' && row.notify !== 'mentions') {
      type = 'chat.alert';
      category = 'alert';
    }
    if (!type) continue;
    addNotification(s, {
      userId: uid,
      type,
      category,
      source: type === 'chat.alert' ? 'alerts' : 'chat',
      actorId: m.authorId,
      target: {
        type: 'message',
        id: m.id,
        conversationId: conv.id,
        seq: m.seq,
        spaceId: conv.spaceId,
      },
      data: {
        conversationTitle: title(uid),
        conversationType: conv.type,
        authorName:
          userById(s, m.authorId)?.name ??
          c.webhooks.find((w) => w.id === m.webhookId)?.name ??
          null,
        excerpt: excerptOf(s, m),
        webhookName: c.webhooks.find((w) => w.id === m.webhookId)?.name ?? null,
        severity: messageSeverity(m),
      },
      url: `/chat/c/${conv.id}?seq=${m.seq}`,
    });
  }
}

// ---- simulated colleagues (browser demo only) ----

const SIMULATE = typeof window !== 'undefined' && import.meta.env.MODE !== 'test';
const REPLIES = ['👍', 'Tamamdır, bakıyorum.', 'Teşekkürler!', 'Birazdan dönüyorum.', 'Harika 🎉'];

function simulateReply(s: MockState, conv: MockConversation, from: string) {
  if (!SIMULATE || conv.type !== 'direct') return;
  const c = chatState(s);
  const peer = rowsOf(c, conv.id).find((m) => m.userId !== from)?.userId;
  if (!peer) return;
  setTimeout(() => {
    emitConversation(s, conv.id, (uid) =>
      uid === peer
        ? null
        : {
            type: 'typing',
            conversationId: conv.id,
            userId: peer,
            expiresAt: new Date(Date.now() + 3000).toISOString(),
          },
    );
  }, 900);
  setTimeout(() => {
    const st = db();
    const cv = chatState(st).conversations.find((x) => x.id === conv.id);
    if (!cv) return;
    append(st, cv, {
      kind: 'user',
      authorId: peer,
      webhookId: null,
      text: REPLIES[cv.lastSeq % REPLIES.length] ?? '👍',
      card: null,
      system: null,
      attachments: [],
      replyToId: null,
      reactions: [],
      clientMsgId: null,
      pinnedAt: null,
      pinnedBy: null,
      editedAt: null,
      deletedAt: null,
    });
    save();
  }, 3200);
}

// ---- notifications ----

function toNotification(s: MockState, n: MockNotification): Notification {
  return {
    id: n.id,
    type: n.type,
    category: n.category,
    source: n.source,
    actor: summaryOf(s, n.actorId),
    target: n.target,
    data: n.data,
    count: n.count,
    url: n.url,
    readAt: n.readAt,
    snoozedUntil: n.snoozedUntil,
    dismissedAt: n.dismissedAt,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
  };
}

/** Snoozed rows whose time came are back in the inbox, unread. */
function wakeSnoozed(c: ChatState) {
  const t = Date.now();
  for (const n of c.notifications) {
    if (n.snoozedUntil && Date.parse(n.snoozedUntil) <= t) {
      n.snoozedUntil = null;
      n.readAt = null;
      n.updatedAt = now();
    }
  }
}

function inbox(n: MockNotification) {
  return n.dismissedAt === null && n.snoozedUntil === null;
}

function notificationCounts(s: MockState, userId: string) {
  const c = chatState(s);
  wakeSnoozed(c);
  const mine = c.notifications.filter((n) => n.userId === userId);
  const bySource = Object.fromEntries(NotificationSource.options.map((x) => [x, 0])) as Record<
    Notification['source'],
    number
  >;
  for (const n of mine.filter((x) => inbox(x) && !x.readAt)) {
    bySource[n.source] = (bySource[n.source] ?? 0) + 1;
  }
  return {
    unread: mine.filter((n) => inbox(n) && !n.readAt).length,
    snoozed: mine.filter((n) => n.dismissedAt === null && n.snoozedUntil !== null).length,
    bySource,
  };
}

// ---- presence ----

function presenceOf(s: MockState, userId: string): Presence {
  const c = chatState(s);
  const p = c.presence[userId] ?? { state: 'offline' as const, auto: null, lastSeenAt: null };
  const st = c.statuses[userId];
  let state = p.state;
  if (st && state !== 'offline') {
    if (st.visibility === 'invisible') state = 'offline';
    else if (st.visibility !== 'online') state = st.visibility;
  }
  if (p.auto === 'meeting' && st?.autoMeeting !== false && state !== 'offline') state = 'busy';
  const msg =
    st?.message && (!st.message.expiresAt || Date.parse(st.message.expiresAt) > Date.now())
      ? st.message
      : null;
  return {
    userId,
    state,
    auto: state === 'offline' ? null : p.auto,
    message: msg,
    lastSeenAt: p.lastSeenAt,
  };
}

function emitPresence(s: MockState, userId: string) {
  const p = presenceOf(s, userId);
  emitTo(
    [...connections].map((x) => x.userId),
    () => ({ type: 'presence', presence: p }),
  );
}

// ---- webhooks ----

function hookUrl(request: Request, h: MockWebhook, masked: boolean) {
  const origin = new URL(request.url).origin;
  return `${origin}/api/hooks/${h.id}?key=${masked ? '••••' : h.key}`;
}

function toWebhook(s: MockState, h: MockWebhook, request: Request): IncomingWebhook {
  const c = chatState(s);
  const recent = c.deliveries.filter(
    (d) => d.webhookId === h.id && Date.now() - Date.parse(d.receivedAt) < 24 * HOUR,
  );
  const lastHour = recent.filter((d) => Date.now() - Date.parse(d.receivedAt) < HOUR);
  const muted = h.mutedUntil !== null && Date.parse(h.mutedUntil) > Date.now();
  const latest = recent.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)).slice(0, 3);
  const health = h.disabledAt
    ? 'disabled'
    : muted
      ? 'muted'
      : latest.length > 0 &&
          latest.every((d) => d.status >= 400 && d.status < 500 && d.status !== 429)
        ? 'failing'
        : lastHour.some((d) => d.status === 429)
          ? 'limited'
          : 'active';
  return {
    id: h.id,
    conversationId: h.conversationId,
    name: h.name,
    avatarUrl: h.avatarUrl,
    maskedUrl: hookUrl(request, h, true),
    rateLimit: h.rateLimit,
    health,
    lastUsedAt: h.lastUsedAt,
    mutedUntil: h.mutedUntil,
    disabledAt: h.disabledAt,
    provider: h.provider ?? null,
    events: h.events ?? [],
    textSeverity: h.textSeverity ?? null,
    createdBy: summaryOf(s, h.createdBy),
    createdAt: h.createdAt,
    deliveries24h: recent.length,
  };
}

function webhookOf(s: MockState, u: MockUser, webhookId: string, manage = true) {
  const c = chatState(s);
  const h = c.webhooks.find((x) => x.id === webhookId);
  if (!h) throw new MockApiError('not_found');
  const a = access(s, u, h.conversationId);
  if (manage && !permissions(s, a.conv, u.id).manageWebhooks) throw new MockApiError('forbidden');
  return { ...a, h };
}

/** Google Chat cardsV2 → AlertCard: header title/subtitle, decoratedText widgets as fields. */
function fromGoogleChat(p: z.infer<typeof GoogleChatPayload>): {
  text: string;
  card: MockMessage['card'];
} {
  const first = p.cardsV2?.[0]?.card as
    | {
        header?: { title?: string; subtitle?: string };
        sections?: {
          widgets?: {
            decoratedText?: { topLabel?: string; text?: string };
            textParagraph?: { text?: string };
          }[];
        }[];
      }
    | undefined;
  if (!first) return { text: p.text ?? '', card: null };
  const fields: { label: string; value: string }[] = [];
  const texts: string[] = [];
  for (const sec of first.sections ?? []) {
    for (const w of sec.widgets ?? []) {
      if (w.decoratedText) {
        fields.push({ label: w.decoratedText.topLabel ?? '', value: w.decoratedText.text ?? '' });
      }
      if (w.textParagraph?.text) texts.push(w.textParagraph.text);
    }
  }
  return {
    text: p.text ?? '',
    card: {
      severity: 'info',
      title: first.header?.title ?? p.text ?? '',
      subtitle: first.header?.subtitle ?? null,
      source: null,
      iconUrl: null,
      text: texts.join('\n') || null,
      fields: fields.slice(0, 20),
      buttons: [],
    },
  };
}

// ---- notification preferences (doc 17 §10 matrix) ----

type Prefs = ChatState['prefs'][string];

function prefsOf(s: MockState, userId: string): Prefs {
  const c = chatState(s);
  return (c.prefs[userId] ??= {
    categories: NotificationCategory.options.map((category) => ({
      category,
      inApp: true,
      push: !['conversation_message', 'security', 'portal'].includes(category),
      email: ['share', 'vault', 'security', 'portal', 'mention', 'direct_reply', 'boards'].includes(
        category,
      ),
    })),
    digest: 'daily',
    quietHours: { from: '22:00', to: '08:00' },
  });
}

/** Security mail and the new-device vault notice cannot be turned off. */
function prefsView(p: Prefs) {
  const locked = (cat: NotificationCategory): ('inApp' | 'push' | 'email')[] =>
    cat === 'security' ? ['inApp', 'email'] : cat === 'vault' ? ['inApp'] : [];
  const all: NotificationChannel[] = ['inApp', 'desktop', 'push', 'email'];
  return {
    categories: p.categories.map((x) => ({ ...x, locked: locked(x.category) })),
    digest: p.digest,
    quietHours: p.quietHours,
    // As the server: a row nobody set follows its category; desktop follows the bell.
    groups: NOTIFICATION_GROUPS.map((g) => {
      const cat = p.categories.find((c) => c.category === g.category)!;
      const own = p.groups?.[g.key] ?? { ...cat, desktop: cat.inApp };
      const channels: NotificationChannel[] = 'channels' in g ? [...g.channels] : all;
      const lockedHere: NotificationChannel[] = (
        'locked' in g ? [...g.locked] : locked(g.category)
      ).filter((c) => channels.includes(c));
      const on = (c: NotificationChannel) =>
        lockedHere.includes(c) || (channels.includes(c) && own[c]);
      return {
        group: g.key,
        inApp: on('inApp'),
        desktop: on('desktop'),
        push: on('push'),
        email: on('email'),
        locked: lockedHere,
        channels,
      };
    }),
  };
}

// ---- resolvers ----

const PAGE_SIZE = 50;

function attachmentFolderFor(s: MockState, u: MockUser, conv: MockConversation) {
  const d = driveState(s);
  const mk = (spaceId: string, parentId: string | null, name: string) => {
    const existing = d.nodes.find(
      (n) =>
        n.spaceId === spaceId &&
        n.parentId === parentId &&
        n.type === 'folder' &&
        n.name === name &&
        !n.deletedAt,
    );
    if (existing) return existing.id;
    const id = newId();
    d.nodes.push({
      id,
      spaceId,
      parentId,
      type: 'folder',
      name,
      createdBy: u.id,
      updatedBy: u.id,
      createdAt: now(),
      updatedAt: now(),
      deletedAt: null,
      deletedBy: null,
      trashedWith: null,
    });
    return id;
  };
  if (conv.spaceId) {
    const ekler = mk(conv.spaceId, null, 'Ekler');
    const folderId = conv.attachmentsNodeId ?? mk(conv.spaceId, ekler, conv.name ?? 'Sohbet');
    conv.attachmentsNodeId = folderId;
    return { spaceId: conv.spaceId, folderId };
  }
  const personal = s.spaces.find((x) => x.kind === 'personal' && x.ownerUserId === u.id);
  if (!personal) throw new MockApiError('forbidden');
  return { spaceId: personal.id, folderId: mk(personal.id, null, 'Chat ekleri') };
}

function directWith(c: ChatState, a: string, b: string) {
  return c.conversations.find(
    (x) =>
      x.type === 'direct' &&
      rowsOf(c, x.id).some((m) => m.userId === a) &&
      rowsOf(c, x.id).some((m) => m.userId === b),
  );
}

/** Our direct chat with a remote person (one per pair), as the server makes it. */
function remoteDirect(s: MockState, u: MockUser, remote: RemoteUser): MockConversation {
  const c = chatState(s);
  const known = c.conversations.find(
    (x) =>
      x.type === 'direct' &&
      x.federation?.remoteMembers[0]?.address === remote.address &&
      rowsOf(c, x.id).some((m) => m.userId === u.id),
  );
  if (known) return known;
  const conv = newConversation(s, u, 'direct', { name: remote.name, members: [] });
  conv.federation = {
    homeDomain: MOCK_FEDERATION_DOMAIN,
    domains: [remote.domain],
    remoteMembers: [remote],
    active: true,
  };
  return conv;
}

function newConversation(
  s: MockState,
  u: MockUser,
  type: MockConversation['type'],
  opts: {
    name?: string | null;
    spaceId?: string | null;
    members: string[];
    private?: boolean;
  },
): MockConversation {
  const c = chatState(s);
  const conv: MockConversation = {
    id: newId(),
    type,
    spaceId: opts.spaceId ?? null,
    meetingId: null,
    name: opts.name ?? null,
    createdBy: u.id,
    createdAt: now(),
    lastSeq: 0,
    archivedAt: null,
    attachmentsNodeId: null,
    ...(opts.private ? { private: true } : {}),
  };
  c.conversations.push(conv);
  for (const uid of new Set([u.id, ...opts.members])) {
    c.members.push({
      conversationId: conv.id,
      userId: uid,
      ...(opts.private ? { role: uid === u.id ? ('owner' as const) : ('member' as const) } : {}),
      joinedAt: now(),
      historyFromSeq: null,
      pinnedAt: null,
      pinPosition: null,
      notify:
        type === 'direct' || type === 'group' ? 'all' : type === 'alert' ? 'critical' : 'mentions',
      mutedUntil: null,
      lastReadSeq: 0,
      readAt: now(),
    });
  }
  return conv;
}

function sendInto(
  s: MockState,
  u: MockUser,
  conv: MockConversation,
  body: {
    clientMsgId: string;
    text: string;
    replyToId?: string;
    attachmentNodeIds: string[];
    confirmMentionAll?: boolean;
    emote?: boolean;
    whisperTo?: string;
    gif?: MessageGif;
    refs?: MessageRef[];
  },
): MockMessage {
  const c = chatState(s);
  const dup = c.messages.find((m) => m.authorId === u.id && m.clientMsgId === body.clientMsgId);
  if (dup) return dup;
  if (!permissions(s, conv, u.id).write) {
    throw new MockApiError(conv.archivedAt ? 'chat_archived' : 'forbidden');
  }
  if (body.refs?.some((r) => mockRef(s, u, r).state !== 'ok')) {
    throw new MockApiError('chat_ref_no_access');
  }
  if (!body.text.trim() && body.attachmentNodeIds.length === 0 && !body.gif && !body.refs?.length) {
    throw new MockApiError('validation_failed', 'Empty message');
  }
  if (body.gif && (!gifActiveMock(s) || !isGiphyMediaUrl(body.gif.url))) {
    throw new MockApiError(gifActiveMock(s) ? 'invalid_target' : 'gif_disabled');
  }
  if (
    body.whisperTo &&
    (conv.type === 'direct' || body.whisperTo === u.id || !rowOf(c, conv.id, body.whisperTo))
  ) {
    throw new MockApiError('invalid_target');
  }
  const group = mentionsOf(body.text).some((m) => m.kind !== 'user');
  if (
    group &&
    rowsOf(c, conv.id).length >= CHAT_LIMITS.mentionAllConfirmMembers &&
    !body.confirmMentionAll
  ) {
    throw new MockApiError('chat_mention_all_confirm', undefined, {
      members: rowsOf(c, conv.id).length,
    });
  }
  const d = driveState(s);
  const attachments = body.attachmentNodeIds.map((nodeId) => {
    const n = d.nodes.find((x) => x.id === nodeId && !x.deletedAt);
    if (!n) throw new MockApiError('not_found', 'Attachment not found');
    const v = d.versions.filter((x) => x.nodeId === n.id).sort((a, b) => b.version - a.version)[0];
    const b = v ? d.blobs.find((x) => x.id === v.blobId) : undefined;
    const previewable = b && ['image', 'video', 'pdf', 'logo'].includes(b.art.kind);
    return {
      nodeId: n.id,
      name: n.name,
      mime: b?.mime ?? null,
      sizeBytes: b?.sizeBytes ?? 0,
      preview: previewable ? ('ready' as const) : ('none' as const),
      removed: false,
    };
  });
  const reply = body.replyToId
    ? c.messages.find((m) => m.id === body.replyToId && m.conversationId === conv.id)
    : undefined;
  const m = append(s, conv, {
    kind: 'user',
    authorId: u.id,
    webhookId: null,
    text: body.text,
    card: null,
    system: null,
    attachments,
    replyToId: reply?.id ?? null,
    reactions: [],
    clientMsgId: body.clientMsgId,
    pinnedAt: null,
    pinnedBy: null,
    editedAt: null,
    deletedAt: null,
    emote: body.emote === true,
    whisperTo: body.whisperTo ?? null,
    gif: body.gif ?? null,
    refs: body.refs ?? [],
  });
  if (!body.whisperTo) simulateReply(s, conv, u.id);
  return m;
}

function setReaction(s: MockState, u: MockUser, messageId: string, emoji: string, on: boolean) {
  const { m, c } = messageOf(s, u, messageId);
  if (m.deletedAt) throw new MockApiError('chat_message_not_editable');
  let r = m.reactions.find((x) => x.emoji === emoji);
  const has = r?.userIds.includes(u.id) ?? false;
  if (on && !has) {
    if (!r) {
      r = { emoji, userIds: [] };
      m.reactions.push(r);
    }
    r.userIds.push(u.id);
    const st = c.settings[u.id];
    if (st) st.recentEmojis = [emoji, ...st.recentEmojis.filter((e) => e !== emoji)].slice(0, 5);
  } else if (!on && has && r) {
    r.userIds = r.userIds.filter((x) => x !== u.id);
    m.reactions = m.reactions.filter((x) => x.userIds.length > 0);
  } else {
    return toMessage(s, m, u.id);
  }
  m.updatedAt = now();
  emitConversation(s, m.conversationId, () => ({
    type: 'reaction',
    conversationId: m.conversationId,
    messageId: m.id,
    emoji,
    userId: u.id,
    added: on,
  }));
  return toMessage(s, m, u.id);
}

function readResult(s: MockState, conv: MockConversation, row: MockChatMember) {
  return {
    conversationId: conv.id,
    lastReadSeq: row.lastReadSeq,
    ...counts(chatState(s), conv, row),
  };
}

/** A reference as this person may see it (cards are not in the mock's Drive). */
function mockRef(s: MockState, u: MockUser, ref: MessageRef): ResolvedRef {
  const d = driveState(s);
  const n = ref.kind === 'node' ? d.nodes.find((x) => x.id === ref.id) : undefined;
  if (!n) return { ...ref, state: 'deleted', item: null };
  if (n.deletedAt) {
    return { ...ref, state: myRole(s, n.spaceId, u.id) ? 'deleted' : 'no_access', item: null };
  }
  if (!nodeForUser(s, n.id, u.id)) return { ...ref, state: 'no_access', item: null };
  const space = s.spaces.find((x) => x.id === n.spaceId);
  const slug = space?.slug ?? '';
  const path =
    n.type === 'page'
      ? paths.page(n.id)
      : n.type === 'board'
        ? paths.board(n.id)
        : n.type === 'drawing'
          ? paths.drawing(n.id)
          : n.type === 'folder'
            ? paths.driveFolder(slug, n.id)
            : withQuery(n.parentId ? paths.driveFolder(slug, n.parentId) : paths.driveSpace(slug), {
                preview: n.id,
              });
  return {
    ...ref,
    state: 'ok',
    item: { type: n.type, title: n.name, path, mime: null, spaceName: space?.name ?? null },
  };
}

function emitRead(s: MockState, conv: MockConversation, row: MockChatMember) {
  const own = readResult(s, conv, row);
  emitConversation(s, conv.id, (uid) => {
    if (uid === row.userId) {
      return {
        type: 'read',
        conversationId: conv.id,
        userId: uid,
        lastReadSeq: row.lastReadSeq,
        unread: own.unread,
        unreadMentions: own.unreadMentions,
      };
    }
    return {
      type: 'read',
      conversationId: conv.id,
      userId: row.userId,
      lastReadSeq: row.lastReadSeq,
    };
  });
}

function addMembers(
  s: MockState,
  u: MockUser,
  conv: MockConversation,
  userIds: string[],
  history: 'none' | 'days7' | 'days30' | 'all',
) {
  const c = chatState(s);
  const fresh = userIds.filter((id) => !rowOf(c, conv.id, id) && userById(s, id));
  if (conv.private && conv.spaceId) {
    if (fresh.some((id) => !myRole(s, conv.spaceId!, id))) {
      throw new MockApiError('chat_not_in_space');
    }
  }
  const limit = conv.private ? CHAT_LIMITS.privateChannelMembers : CHAT_LIMITS.groupMembers;
  if (rowsOf(c, conv.id).length + fresh.length > limit) {
    throw new MockApiError('chat_group_full');
  }
  const since =
    history === 'days7'
      ? Date.now() - 7 * 24 * HOUR
      : history === 'days30'
        ? Date.now() - 30 * 24 * HOUR
        : null;
  const fromSeq =
    history === 'all'
      ? null
      : history === 'none'
        ? conv.lastSeq + 1
        : (c.messages
            .filter((m) => m.conversationId === conv.id && Date.parse(m.createdAt) >= (since ?? 0))
            .sort((a, b) => a.seq - b.seq)[0]?.seq ?? conv.lastSeq + 1);
  for (const id of fresh) {
    c.members.push({
      conversationId: conv.id,
      userId: id,
      joinedAt: now(),
      historyFromSeq: fromSeq,
      ...(conv.private ? { role: 'member' as const } : {}),
      pinnedAt: null,
      pinPosition: null,
      notify: conv.type === 'group' ? 'all' : 'mentions',
      mutedUntil: null,
      lastReadSeq: conv.lastSeq,
      readAt: now(),
    });
  }
  if (fresh.length) {
    systemLine(s, conv, { type: 'members_added', actorId: u.id, userIds: fresh });
    emitConvUpdated(s, conv);
  }
}

function membersOf(s: MockState, conv: MockConversation): ChatMember[] {
  const c = chatState(s);
  return rowsOf(c, conv.id)
    .map((r) => {
      const usr = userById(s, r.userId);
      if (!usr) return null;
      const om = s.members.find((m) => m.userId === r.userId);
      return {
        user: summary(usr),
        isGuest: om?.role === 'guest',
        spaceRole: conv.type === 'space' ? spaceRoleOf(s, conv, r.userId) : null,
        joinedAt: r.joinedAt,
        ...(conv.private ? { role: r.role ?? 'member' } : {}),
      };
    })
    .filter((x): x is ChatMember => x !== null);
}

export const chatResolvers = {
  createWsTicket: ({ s }) => {
    const u = requireUser(s);
    const c = chatState(s);
    const ticket = randomToken();
    const expiresAt = new Date(Date.now() + CHAT_LIMITS.wsTicketSeconds * 1000).toISOString();
    c.tickets = [
      ...c.tickets.filter((t) => Date.parse(t.expiresAt) > Date.now()),
      { ticket, userId: u.id, expiresAt },
    ];
    return { ticket, expiresAt, path: '/ws' as const };
  },

  getUnreads: ({ s }) => {
    const u = requireUser(s);
    const c = chatState(s);
    const conversations = c.members
      .filter((r) => r.userId === u.id)
      .map((r) => {
        const conv = convOf(c, r.conversationId);
        const last = lastMessage(s, c, conv, r);
        return {
          conversationId: conv.id,
          lastReadSeq: r.lastReadSeq,
          ...counts(c, conv, r),
          lastSeq: conv.lastSeq,
          lastMessageAt: last?.createdAt ?? null,
        };
      });
    const unreadConversations = conversations.filter((x) => x.unread > 0).length;
    return {
      conversations,
      unreadConversations,
      notificationsUnread: notificationCounts(s, u.id).unread,
    };
  },

  listConversations: ({ s, query }) => {
    const u = requireUser(s);
    const c = chatState(s);
    const q = query.q?.toLocaleLowerCase('tr');
    let list = c.members
      .filter((r) => r.userId === u.id)
      .filter((r) => r.clearedAtSeq == null || convOf(c, r.conversationId).lastSeq > r.clearedAtSeq)
      .filter((r) => {
        const out = convOf(c, r.conversationId).archivedAt !== null || !!r.archivedAt;
        return query.archived ? out : !out;
      })
      .map((r) => convOf(c, r.conversationId))
      // A direct chat without messages shows only to the person who opened it (4.17).
      .filter((cv) => cv.type !== 'direct' || cv.lastSeq > 0 || cv.createdBy === u.id)
      .map((cv) => toConversation(s, cv, u.id));
    if (q) list = list.filter((x) => x.title.toLocaleLowerCase('tr').includes(q));
    if (query.filter === 'unread') list = list.filter((x) => x.my.unread > 0);
    else if (query.filter) list = list.filter((x) => x.type === query.filter);
    list.sort((a, b) => {
      const pa = a.my.pinnedAt !== null;
      const pb = b.my.pinnedAt !== null;
      if (pa !== pb) return pa ? -1 : 1;
      if (pa) return (a.my.pinPosition ?? 0) - (b.my.pinPosition ?? 0);
      return (b.lastMessageAt ?? b.createdAt).localeCompare(a.lastMessageAt ?? a.createdAt);
    });
    const start = query.cursor ? Number(query.cursor) : 0;
    return {
      items: list.slice(start, start + query.limit),
      nextCursor: start + query.limit < list.length ? String(start + query.limit) : null,
    };
  },

  createConversation: ({ s, body }) => {
    const u = requireUser(s);
    const c = chatState(s);
    let conv: MockConversation;
    if (body.type === 'direct') {
      if (!userById(s, body.userId)) throw new MockApiError('not_found');
      conv =
        directWith(c, u.id, body.userId) ??
        newConversation(s, u, 'direct', { members: [body.userId] });
    } else if (body.type === 'group') {
      if (body.userIds.length + 1 > CHAT_LIMITS.groupMembers) {
        throw new MockApiError('chat_group_full');
      }
      conv = newConversation(s, u, 'group', { name: body.name, members: body.userIds });
      systemLine(s, conv, { type: 'created', actorId: u.id, userIds: body.userIds });
    } else if (body.type === 'space') {
      if (!atLeast(myRole(s, body.spaceId, u.id), 'editor')) throw new MockApiError('forbidden');
      const all = s.spaceMembers.filter((m) => m.spaceId === body.spaceId).map((m) => m.userId);
      const picked = body.userIds ?? [];
      if (body.private && picked.some((id) => !all.includes(id))) {
        throw new MockApiError('chat_not_in_space');
      }
      conv = newConversation(s, u, 'space', {
        name: body.name,
        spaceId: body.spaceId,
        members: body.private ? picked : all,
        private: body.private === true,
      });
    } else {
      const ids = body.spaceId
        ? s.spaceMembers.filter((m) => m.spaceId === body.spaceId).map((m) => m.userId)
        : body.userIds;
      conv = newConversation(s, u, 'alert', {
        name: body.name,
        spaceId: body.spaceId ?? null,
        members: ids,
      });
    }
    if ('emoji' in body && body.emoji) {
      if (!isReactionEmoji(body.emoji)) throw new MockApiError('chat_invalid_emoji');
      conv.emoji = body.emoji;
    }
    if ('message' in body && body.message) sendInto(s, u, conv, body.message);
    emitConvUpdated(s, conv);
    return toConversation(s, conv, u.id);
  },

  getConversation: ({ s, params }) => {
    const u = requireUser(s);
    const { conv } = access(s, u, params.conversationId!);
    return toConversation(s, conv, u.id);
  },

  updateConversation: ({ s, params, body }) => {
    const u = requireUser(s);
    const { conv } = access(s, u, params.conversationId!);
    const p = permissions(s, conv, u.id);
    if (body.name !== undefined) {
      if (!p.manage || conv.type === 'direct') throw new MockApiError('forbidden');
      conv.name = body.name;
      systemLine(s, conv, { type: 'renamed', actorId: u.id, name: body.name ?? undefined });
    }
    if (body.emoji !== undefined) {
      if (!p.manage || conv.type === 'direct') throw new MockApiError('forbidden');
      if (body.emoji !== null && !isReactionEmoji(body.emoji)) {
        throw new MockApiError('chat_invalid_emoji');
      }
      conv.emoji = body.emoji;
    }
    if (body.archived !== undefined) {
      if (!p.archive) throw new MockApiError('forbidden');
      conv.archivedAt = body.archived ? now() : null;
      systemLine(s, conv, { type: body.archived ? 'archived' : 'unarchived', actorId: u.id });
    }
    if (body.private !== undefined && body.private !== (conv.private ?? false)) {
      if (!p.changePrivacy || !conv.spaceId) throw new MockApiError('forbidden');
      const c = chatState(s);
      const inSpace = s.spaceMembers.filter((m) => m.spaceId === conv.spaceId).map((m) => m.userId);
      if (body.private) {
        // Everyone in the space now is a member; the caller owns it.
        addMembers(s, u, conv, inSpace, 'all');
        for (const r of rowsOf(c, conv.id)) r.role = r.userId === u.id ? 'owner' : 'member';
      } else {
        addMembers(s, u, conv, inSpace, 'all');
      }
      conv.private = body.private;
      systemLine(s, conv, { type: body.private ? 'made_private' : 'made_open', actorId: u.id });
    }
    emitConvUpdated(s, conv);
    return toConversation(s, conv, u.id);
  },

  linkConversationSpace: ({ s, params, body }) => {
    const u = requireUser(s);
    const { conv, c } = access(s, u, params.conversationId!);
    if (conv.type !== 'group') throw new MockApiError('forbidden');
    if (!atLeast(myRole(s, body.spaceId, u.id), 'admin')) throw new MockApiError('forbidden');
    conv.type = 'space';
    conv.spaceId = body.spaceId;
    conv.name ??= titleOf(s, c, conv, u.id);
    const ids = s.spaceMembers.filter((m) => m.spaceId === body.spaceId).map((m) => m.userId);
    for (const id of ids) {
      if (!rowOf(c, conv.id, id)) {
        c.members.push({
          conversationId: conv.id,
          userId: id,
          joinedAt: now(),
          historyFromSeq: null,
          pinnedAt: null,
          pinPosition: null,
          notify: 'mentions',
          mutedUntil: null,
          lastReadSeq: conv.lastSeq,
          readAt: now(),
        });
      }
    }
    systemLine(s, conv, { type: 'linked_space', actorId: u.id });
    emitConvUpdated(s, conv);
    return toConversation(s, conv, u.id);
  },

  updateMyConversation: ({ s, params, body }) => {
    const u = requireUser(s);
    const { conv, row, c } = access(s, u, params.conversationId!);
    if (body.pinned !== undefined) {
      if (body.pinned && !row.pinnedAt) {
        const pinned = c.members.filter((m) => m.userId === u.id && m.pinnedAt);
        if (pinned.length >= CHAT_LIMITS.pinnedConversations) {
          throw new MockApiError('chat_pin_limit');
        }
        row.pinnedAt = now();
        row.pinPosition = pinned.length;
      } else if (!body.pinned) {
        row.pinnedAt = null;
        row.pinPosition = null;
      }
    }
    if (body.notify !== undefined) row.notify = body.notify;
    if (body.mutedUntil !== undefined) row.mutedUntil = body.mutedUntil;
    if (body.archived !== undefined) row.archivedAt = body.archived ? now() : null;
    emitConvUpdated(s, conv, [u.id]);
    return toConversation(s, conv, u.id);
  },

  clearConversation: ({ s, params }) => {
    const u = requireUser(s);
    const { conv, row } = access(s, u, params.conversationId!);
    if (conv.type === 'space') throw new MockApiError('chat_delete_not_allowed');
    row.clearedAtSeq = conv.lastSeq;
    row.lastReadSeq = conv.lastSeq;
    row.archivedAt = null;
    emitTo([u.id], () => ({
      type: 'conversation.removed',
      conversationId: conv.id,
      reason: 'cleared',
    }));
    return {};
  },

  deleteConversation: ({ s, params }) => {
    const u = requireUser(s);
    const { conv, c } = access(s, u, params.conversationId!);
    if (conv.type === 'space' || conv.type === 'direct') {
      throw new MockApiError('chat_delete_not_allowed');
    }
    if (s.org?.settings.chatDeleteForEveryone === false) {
      throw new MockApiError('chat_delete_disabled');
    }
    if (!permissions(s, conv, u.id).deleteForEveryone) {
      throw new MockApiError('chat_delete_not_allowed');
    }
    const ids = rowsOf(c, conv.id).map((m) => m.userId);
    c.members = c.members.filter((m) => m.conversationId !== conv.id);
    c.messages = c.messages.filter((m) => m.conversationId !== conv.id);
    c.conversations = c.conversations.filter((x) => x.id !== conv.id);
    emitTo(ids, () => ({
      type: 'conversation.removed',
      conversationId: conv.id,
      reason: 'deleted',
    }));
    return {};
  },

  leaveConversation: ({ s, params }) => {
    const u = requireUser(s);
    const { conv, c } = access(s, u, params.conversationId!);
    if ((conv.type === 'space' && !conv.private) || conv.type === 'direct') {
      throw new MockApiError('forbidden');
    }
    systemLine(s, conv, { type: 'member_left', actorId: u.id });
    c.members = c.members.filter((m) => !(m.conversationId === conv.id && m.userId === u.id));
    emitTo([u.id], () => ({ type: 'conversation.removed', conversationId: conv.id }));
    emitConvUpdated(s, conv);
    return {};
  },

  reorderPinnedConversations: ({ s, body }) => {
    const u = requireUser(s);
    const c = chatState(s);
    body.conversationIds.forEach((id, i) => {
      const row = rowOf(c, id, u.id);
      if (row?.pinnedAt) row.pinPosition = i;
    });
    return {};
  },

  listConversationMembers: ({ s, params }) => {
    const u = requireUser(s);
    const { conv } = access(s, u, params.conversationId!);
    return { items: membersOf(s, conv) };
  },

  addConversationMembers: ({ s, params, body }) => {
    const u = requireUser(s);
    const { conv } = access(s, u, params.conversationId!);
    if (conv.type !== 'group' && conv.type !== 'alert' && !conv.private) {
      throw new MockApiError('forbidden');
    }
    if (!permissions(s, conv, u.id).manage) throw new MockApiError('forbidden');
    addMembers(s, u, conv, body.userIds, body.history);
    return { items: membersOf(s, conv) };
  },

  updateConversationMember: ({ s, params, body }) => {
    const u = requireUser(s);
    const { conv, c } = access(s, u, params.conversationId!);
    if (!conv.private) throw new MockApiError('bad_request');
    if (!permissions(s, conv, u.id).manage) throw new MockApiError('forbidden');
    const row = rowOf(c, conv.id, params.userId!);
    if (!row) throw new MockApiError('member_not_found');
    const owners = rowsOf(c, conv.id).filter((r) => r.role === 'owner');
    if (body.role === 'member' && owners.every((o) => o.userId === row.userId)) {
      throw new MockApiError('bad_request');
    }
    row.role = body.role;
    emitConvUpdated(s, conv);
    return { items: membersOf(s, conv) };
  },

  removeConversationMember: ({ s, params }) => {
    const u = requireUser(s);
    const { conv, c } = access(s, u, params.conversationId!);
    if (!permissions(s, conv, u.id).manage || (conv.type === 'space' && !conv.private)) {
      throw new MockApiError('forbidden');
    }
    const target = params.userId!;
    if (!rowOf(c, conv.id, target)) throw new MockApiError('not_found');
    c.members = c.members.filter((m) => !(m.conversationId === conv.id && m.userId === target));
    systemLine(s, conv, { type: 'member_removed', actorId: u.id, userIds: [target] });
    emitTo([target], () => ({ type: 'conversation.removed', conversationId: conv.id }));
    emitConvUpdated(s, conv);
    return {};
  },

  listReadReceipts: ({ s, params }) => {
    const u = requireUser(s);
    const { conv, c } = access(s, u, params.conversationId!);
    return {
      items: rowsOf(c, conv.id)
        .filter((r) => r.userId !== u.id)
        .map((r) => ({ userId: r.userId, lastReadSeq: r.lastReadSeq, at: r.readAt })),
    };
  },

  markConversationRead: ({ s, params, body }) => {
    const u = requireUser(s);
    const { conv, row } = access(s, u, params.conversationId!);
    const seq = Math.min(body.seq, conv.lastSeq);
    if (seq > row.lastReadSeq || row.markedUnread) {
      row.lastReadSeq = Math.max(row.lastReadSeq, seq);
      row.markedUnread = false;
      row.readAt = now();
      emitRead(s, conv, row);
    }
    return readResult(s, conv, row);
  },

  markConversationUnread: ({ s, params, body }) => {
    const u = requireUser(s);
    const { conv, row } = access(s, u, params.conversationId!);
    row.lastReadSeq = Math.max(0, Math.min(body.fromSeq - 1, conv.lastSeq));
    row.markedUnread = true;
    row.readAt = now();
    emitRead(s, conv, row);
    return readResult(s, conv, row);
  },

  listMessages: ({ s, params, query }) => {
    const u = requireUser(s);
    const { conv, row, c } = access(s, u, params.conversationId!);
    const all = c.messages
      .filter((m) => m.conversationId === conv.id && visibleTo(row, m))
      .sort((a, b) => a.seq - b.seq);
    const limit = query.limit ?? PAGE_SIZE;
    let items: MockMessage[];
    if (query.updatedAfter) {
      const t = Date.parse(query.updatedAfter);
      items = all
        .filter((m) => Date.parse(m.updatedAt) > t && m.updatedAt !== m.createdAt)
        .slice(-limit);
    } else if (query.afterSeq !== undefined) {
      items = all.filter((m) => m.seq > query.afterSeq!).slice(0, limit);
    } else if (query.beforeSeq !== undefined) {
      items = all.filter((m) => m.seq < query.beforeSeq!).slice(-limit);
    } else if (query.aroundSeq !== undefined) {
      const i = Math.max(
        0,
        all.findIndex((m) => m.seq >= query.aroundSeq!),
      );
      const startAt = Math.max(0, i - Math.floor(limit / 2));
      items = all.slice(startAt, startAt + limit);
    } else {
      items = all.slice(-limit);
    }
    const first = items[0]?.seq;
    const last = items.at(-1)?.seq;
    return {
      items: items.map((m) => toMessage(s, m, u.id)),
      hasMoreBefore: first !== undefined ? all.some((m) => m.seq < first) : false,
      hasMoreAfter: last !== undefined ? all.some((m) => m.seq > last) : false,
      lastSeq: conv.lastSeq,
    };
  },

  sendMessage: ({ s, params, body }) => {
    const u = requireUser(s);
    const { conv } = access(s, u, params.conversationId!);
    return toMessage(s, sendInto(s, u, conv, body), u.id);
  },

  // ---- Federation (roadmap 26) ----
  createRemoteConversation: ({ s, body }) => {
    const u = requireUser(s);
    const remote = remoteLookup(s, body.address);
    return toConversation(s, remoteDirect(s, u, remote), u.id);
  },
  addRemoteConversationMember: ({ s, params, body }) => {
    const u = requireUser(s);
    const { conv } = access(s, u, params.conversationId!);
    if (!permissions(s, conv, u.id).manage) throw new MockApiError('forbidden');
    if (conv.type !== 'group' && conv.type !== 'space') {
      throw new MockApiError('federation_not_allowed');
    }
    const remote = remoteLookup(s, body.address);
    conv.federation ??= {
      homeDomain: MOCK_FEDERATION_DOMAIN,
      domains: [],
      remoteMembers: [],
      active: true,
    };
    if (conv.federation.homeDomain !== MOCK_FEDERATION_DOMAIN) {
      throw new MockApiError('federation_not_allowed');
    }
    if (!conv.federation.domains.includes(remote.domain)) {
      conv.federation.domains.push(remote.domain);
    }
    if (!conv.federation.remoteMembers.some((m) => m.address === remote.address)) {
      conv.federation.remoteMembers.push(remote);
    }
    emitConvUpdated(s, conv);
    return toConversation(s, conv, u.id);
  },
  shareNodeRemote: ({ s, params, body }) => {
    const u = requireUser(s);
    const node = driveState(s).nodes.find((n) => n.id === params.nodeId && !n.deletedAt);
    if (!node) throw new MockApiError('not_found');
    const remote = remoteLookup(s, body.address);
    const conv = remoteDirect(s, u, remote);
    const url = `${window.location.origin}/s/${randomToken()}`;
    const text = body.note
      ? `${body.note}

${node.name}: ${url}`
      : `${node.name}: ${url}`;
    sendInto(s, u, conv, { clientMsgId: newId(), text, attachmentNodeIds: [] });
    const expiresAt = new Date(Date.now() + (body.expiresInDays ?? 30) * 86_400_000).toISOString();
    return { conversationId: conv.id, url, expiresAt };
  },

  updateMessage: ({ s, params, body }) => {
    const u = requireUser(s);
    const { m } = messageOf(s, u, params.messageId!);
    if (m.authorId !== u.id || m.deletedAt) throw new MockApiError('chat_message_not_editable');
    m.text = body.text;
    m.editedAt = now();
    m.updatedAt = m.editedAt;
    emitMessage(s, m, 'message.updated');
    return toMessage(s, m, u.id);
  },

  deleteMessage: ({ s, params }) => {
    const u = requireUser(s);
    const { m, conv } = messageOf(s, u, params.messageId!);
    if (m.authorId !== u.id && !permissions(s, conv, u.id).moderate) {
      throw new MockApiError('chat_message_not_editable');
    }
    m.deletedAt = now();
    m.updatedAt = m.deletedAt;
    m.pinnedAt = null;
    const d = driveState(s);
    for (const a of m.attachments) {
      const n = d.nodes.find((x) => x.id === a.nodeId);
      if (n && !n.deletedAt) {
        n.deletedAt = now();
        n.deletedBy = u.id;
        n.trashedWith = n.id;
      }
    }
    emitConversation(s, m.conversationId, () => ({
      type: 'message.deleted',
      conversationId: m.conversationId,
      messageId: m.id,
      seq: m.seq,
      deletedAt: m.deletedAt!,
    }));
    return toMessage(s, m, u.id);
  },

  addReaction: ({ s, params, body }) =>
    setReaction(s, requireUser(s), params.messageId!, body.emoji, true),
  removeReaction: ({ s, params, body }) =>
    setReaction(s, requireUser(s), params.messageId!, body.emoji, false),

  pinMessage: ({ s, params }) => {
    const u = requireUser(s);
    const { m, conv, c } = messageOf(s, u, params.messageId!);
    if (!permissions(s, conv, u.id).pin) throw new MockApiError('forbidden');
    if (!m.pinnedAt) {
      const count = c.messages.filter((x) => x.conversationId === conv.id && x.pinnedAt).length;
      if (count >= CHAT_LIMITS.pinnedMessages) throw new MockApiError('chat_pin_limit');
      m.pinnedAt = now();
      m.pinnedBy = u.id;
      m.updatedAt = m.pinnedAt;
      emitMessage(s, m, 'message.updated');
      systemLine(s, conv, { type: 'message_pinned', actorId: u.id, messageId: m.id });
    }
    return toMessage(s, m, u.id);
  },

  unpinMessage: ({ s, params }) => {
    const u = requireUser(s);
    const { m, conv } = messageOf(s, u, params.messageId!);
    if (!permissions(s, conv, u.id).pin) throw new MockApiError('forbidden');
    m.pinnedAt = null;
    m.pinnedBy = null;
    m.updatedAt = now();
    emitMessage(s, m, 'message.updated');
    return toMessage(s, m, u.id);
  },

  resolveChatRefs: ({ s, body }) => {
    const u = requireUser(s);
    return { items: body.refs.map((r) => mockRef(s, u, r)) };
  },

  searchChatRefs: ({ s, query }) => {
    const u = requireUser(s);
    const q = query.q.toLocaleLowerCase('tr');
    return {
      items: driveState(s)
        .nodes.filter((n) => n.name.toLocaleLowerCase('tr').includes(q))
        .map((n) => mockRef(s, u, { kind: 'node', id: n.id }))
        .filter((r) => r.state === 'ok')
        .slice(0, query.limit),
    };
  },

  claimMessage: ({ s, params }) => {
    const u = requireUser(s);
    const { m, conv } = messageOf(s, u, params.messageId!);
    if (!permissions(s, conv, u.id).write) throw new MockApiError('forbidden');
    if (m.kind !== 'webhook' || m.deletedAt) throw new MockApiError('invalid_target');
    m.claim = { userId: u.id, at: now() };
    m.updatedAt = now();
    emitMessage(s, m, 'message.updated');
    return toMessage(s, m, u.id);
  },

  unclaimMessage: ({ s, params }) => {
    const u = requireUser(s);
    const { m, conv } = messageOf(s, u, params.messageId!);
    if (m.claim && m.claim.userId !== u.id && !permissions(s, conv, u.id).moderate) {
      throw new MockApiError('forbidden');
    }
    m.claim = null;
    m.updatedAt = now();
    emitMessage(s, m, 'message.updated');
    return toMessage(s, m, u.id);
  },

  removeChatLinkPreview: ({ s, params }) => {
    const u = requireUser(s);
    const { m } = messageOf(s, u, params.messageId!);
    if (m.authorId !== u.id || m.kind !== 'user' || m.deletedAt) {
      throw new MockApiError('chat_message_not_editable');
    }
    m.linkPreview = null;
    m.updatedAt = now();
    emitMessage(s, m, 'message.updated');
    return toMessage(s, m, u.id);
  },

  listPinnedMessages: ({ s, params }) => {
    const u = requireUser(s);
    const { conv, row, c } = access(s, u, params.conversationId!);
    return {
      items: c.messages
        .filter((m) => m.conversationId === conv.id && m.pinnedAt && visibleTo(row, m))
        .sort((a, b) => (b.pinnedAt ?? '').localeCompare(a.pinnedAt ?? ''))
        .map((m) => ({
          message: toMessage(s, m, u.id),
          pinnedBy: summaryOf(s, m.pinnedBy),
          pinnedAt: m.pinnedAt!,
        })),
    };
  },

  searchMessages: ({ s, query }) => {
    const u = requireUser(s);
    const c = chatState(s);
    const q = query.q.toLocaleLowerCase('tr');
    const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const hits = c.messages
      .filter((m) => {
        const row = rowOf(c, m.conversationId, u.id);
        if (!row || !visibleTo(row, m) || m.deletedAt) return false;
        if (query.conversationId && m.conversationId !== query.conversationId) return false;
        if (query.fromUserId && m.authorId !== query.fromUserId) return false;
        if (query.hasFile && m.attachments.length === 0) return false;
        if (query.after && m.createdAt < query.after) return false;
        if (query.before && m.createdAt > query.before) return false;
        const hay = `${plain(s, m.text)} ${m.card?.title ?? ''} ${m.card?.subtitle ?? ''} ${m.attachments.map((a) => a.name).join(' ')}`;
        return hay.toLocaleLowerCase('tr').includes(q);
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const start = query.cursor ? Number(query.cursor) : 0;
    const pageItems = hits.slice(start, start + query.limit);
    return {
      items: pageItems.map((m) => {
        const conv = convOf(c, m.conversationId);
        const text = plain(s, m.text) || m.card?.title || m.attachments[0]?.name || '';
        const i = text.toLocaleLowerCase('tr').indexOf(q);
        const from = Math.max(0, i - 60);
        const cut = text.slice(from, from + 180);
        const j = i - from;
        const highlight =
          i >= 0
            ? `${from > 0 ? '…' : ''}${esc(cut.slice(0, j))}<mark>${esc(cut.slice(j, j + q.length))}</mark>${esc(cut.slice(j + q.length))}`
            : esc(cut);
        return {
          message: toMessage(s, m, u.id),
          conversation: { id: conv.id, type: conv.type, title: titleOf(s, c, conv, u.id) },
          highlight,
        };
      }),
      nextCursor: start + query.limit < hits.length ? String(start + query.limit) : null,
    };
  },

  getChatAttachmentFolder: ({ s, params }) => {
    const u = requireUser(s);
    const { conv } = access(s, u, params.conversationId!);
    if (!permissions(s, conv, u.id).write) throw new MockApiError('forbidden');
    return attachmentFolderFor(s, u, conv);
  },

  listChatFiles: ({ s, params, query }) => {
    const u = requireUser(s);
    const { conv, row, c } = access(s, u, params.conversationId!);
    const d = driveState(s);
    const files = c.messages
      .filter((m) => m.conversationId === conv.id && visibleTo(row, m) && !m.deletedAt)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .flatMap((m) =>
        m.attachments.map((a) => {
          const n = d.nodes.find((x) => x.id === a.nodeId);
          return {
            attachment: { ...a, name: n?.name ?? a.name, removed: !n || n.deletedAt !== null },
            messageId: m.id,
            seq: m.seq,
            author: summaryOf(s, m.authorId),
            createdAt: m.createdAt,
          };
        }),
      );
    const start = query.cursor ? Number(query.cursor) : 0;
    return {
      items: files.slice(start, start + query.limit),
      nextCursor: start + query.limit < files.length ? String(start + query.limit) : null,
      totalCount: files.length,
      totalBytes: files.reduce(
        (a, f) => a + (f.attachment.removed ? 0 : f.attachment.sizeBytes),
        0,
      ),
    };
  },

  getChatAttachmentUrl: ({ s, params, query, request }) => {
    const u = requireUser(s);
    const { m } = messageOf(s, u, params.messageId!);
    const a = m.attachments.find((x) => x.nodeId === params.nodeId);
    if (!a) throw new MockApiError('not_found');
    const d = driveState(s);
    const n = d.nodes.find((x) => x.id === a.nodeId);
    if (!n || n.deletedAt) throw new MockApiError('chat_attachment_removed');
    const v = d.versions.filter((x) => x.nodeId === n.id).sort((x, y) => y.version - x.version)[0];
    const b = v ? d.blobs.find((x) => x.id === v.blobId) : undefined;
    if (!b) throw new MockApiError('chat_attachment_removed');
    const origin = new URL(request.url).origin;
    const expiresAt = new Date(Date.now() + 5 * MIN).toISOString();
    const url = query.preview
      ? `${origin}/__mock/preview/${b.id}?kind=${query.preview}`
      : `${origin}/__mock/blobs/${b.id}?name=${encodeURIComponent(n.name)}${query.disposition === 'inline' ? '&inline=1' : ''}`;
    return { url, expiresAt, fileName: n.name, sizeBytes: b.sizeBytes, mime: b.mime };
  },

  getChatUserCard: ({ s, params }) => {
    const u = requireUser(s);
    const c = chatState(s);
    const target = userById(s, params.userId!);
    const om = s.members.find((m) => m.userId === params.userId);
    if (!target || !om) throw new MockApiError('not_found');
    const mySpaces = new Set(s.spaceMembers.filter((m) => m.userId === u.id).map((m) => m.spaceId));
    const sharedSpaces = s.spaceMembers
      .filter((m) => m.userId === target.id && mySpaces.has(m.spaceId))
      .map((m) => s.spaces.find((x) => x.id === m.spaceId))
      .filter((x): x is NonNullable<typeof x> => !!x && x.kind === 'shared' && !x.archivedAt)
      .map((x) => ({ id: x.id, name: x.name, color: x.color }));
    const sharedConversations = c.conversations
      .filter(
        (cv) =>
          rowOf(c, cv.id, u.id) &&
          rowOf(c, cv.id, target.id) &&
          !cv.archivedAt &&
          target.id !== u.id,
      )
      .map((cv) => ({ id: cv.id, type: cv.type, title: titleOf(s, c, cv, u.id) }));
    return {
      user: summary(target),
      orgRole: om.role,
      isGuest: om.role === 'guest',
      presence: presenceOf(s, target.id),
      timezone: c.settings[target.id]?.timezone ?? null,
      sharedSpaces,
      sharedConversations,
      directConversationId: directWith(c, u.id, target.id)?.id ?? null,
    };
  },

  getPresence: ({ s, body }) => {
    requireUser(s);
    return { items: body.userIds.filter((id) => userById(s, id)).map((id) => presenceOf(s, id)) };
  },

  getMyStatus: ({ s }) => {
    const u = requireUser(s);
    const c = chatState(s);
    return (c.statuses[u.id] ??= {
      visibility: 'online',
      visibilityUntil: null,
      message: null,
      autoMeeting: true,
    });
  },

  updateMyStatus: ({ s, body }) => {
    const u = requireUser(s);
    const c = chatState(s);
    const cur = (c.statuses[u.id] ??= {
      visibility: 'online',
      visibilityUntil: null,
      message: null,
      autoMeeting: true,
    });
    if (body.visibility !== undefined) cur.visibility = body.visibility;
    if (body.visibilityUntil !== undefined) cur.visibilityUntil = body.visibilityUntil;
    if (body.message !== undefined) cur.message = body.message;
    if (body.autoMeeting !== undefined) cur.autoMeeting = body.autoMeeting;
    emitPresence(s, u.id);
    return cur;
  },

  getChatSettings: ({ s }) => {
    const u = requireUser(s);
    const c = chatState(s);
    return (c.settings[u.id] ??= { readReceipts: true, timezone: null, recentEmojis: [] });
  },

  updateChatSettings: ({ s, body }) => {
    const u = requireUser(s);
    const c = chatState(s);
    const cur = (c.settings[u.id] ??= { readReceipts: true, timezone: null, recentEmojis: [] });
    if (body.timezone !== undefined) cur.timezone = body.timezone;
    return cur;
  },

  listNotifications: ({ s, query }) => {
    const u = requireUser(s);
    const c = chatState(s);
    wakeSnoozed(c);
    const list = c.notifications
      .filter((n) => n.userId === u.id)
      .filter((n) =>
        query.box === 'dismissed'
          ? n.dismissedAt !== null
          : query.box === 'snoozed'
            ? n.dismissedAt === null && n.snoozedUntil !== null
            : inbox(n),
      )
      .filter((n) => (query.source ? n.source === query.source : true))
      .filter((n) =>
        query.kind === 'mentions'
          ? n.category === 'mention'
          : query.kind === 'alerts'
            ? n.source === 'alerts'
            : query.kind === 'assigned'
              ? n.type.endsWith('.assigned')
              : true,
      )
      .filter((n) => (query.unreadOnly ? !n.readAt : true))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const start = query.cursor ? Number(query.cursor) : 0;
    return {
      items: list.slice(start, start + query.limit).map((n) => toNotification(s, n)),
      nextCursor: start + query.limit < list.length ? String(start + query.limit) : null,
    };
  },

  getNotificationCounts: ({ s }) => notificationCounts(s, requireUser(s).id),

  updateNotifications: ({ s, body }) => {
    const u = requireUser(s);
    const c = chatState(s);
    const rows = c.notifications.filter(
      (n) => n.userId === u.id && (body.all ? inbox(n) && !n.readAt : body.ids?.includes(n.id)),
    );
    const t = now();
    for (const n of rows) {
      if (body.action === 'read') n.readAt = t;
      else if (body.action === 'unread') n.readAt = null;
      else if (body.action === 'snooze') {
        n.snoozedUntil = body.until ?? null;
        n.readAt = t;
      } else if (body.action === 'dismiss') n.dismissedAt = t;
      else {
        n.dismissedAt = null;
        n.snoozedUntil = null;
      }
      n.updatedAt = t;
    }
    const out = notificationCounts(s, u.id);
    emitTo([u.id], () => ({ type: 'notifications.changed', unreadCount: out.unread }));
    return out;
  },

  getNotificationPrefs: ({ s }) => prefsView(prefsOf(s, requireUser(s).id)),

  updateNotificationPrefs: ({ s, body }) => {
    const p = prefsOf(s, requireUser(s).id);
    for (const change of body.categories ?? []) {
      const row = p.categories.find((x) => x.category === change.category);
      if (!row || change.category === 'security') continue;
      if (change.inApp !== undefined) row.inApp = change.inApp;
      if (change.push !== undefined) row.push = change.push;
      if (change.email !== undefined) row.email = change.email;
    }
    for (const change of body.groups ?? []) {
      const cur = prefsView(p).groups.find((g) => g.group === change.group)!;
      p.groups = {
        ...p.groups,
        [change.group]: {
          inApp: change.inApp ?? cur.inApp,
          desktop: change.desktop ?? cur.desktop,
          push: change.push ?? cur.push,
          email: change.email ?? cur.email,
        },
      };
    }
    if (body.digest !== undefined) p.digest = body.digest;
    if (body.quietHours !== undefined) p.quietHours = body.quietHours;
    return prefsView(p);
  },

  registerPushDevice: ({ s, body }) => {
    requireUser(s);
    return {
      id: newId(),
      platform: body.platform,
      appVersion: body.appVersion ?? null,
      lastSeenAt: now(),
      disabledAt: null,
    };
  },
  unregisterPushDevice: ({ s }) => {
    requireUser(s);
    return {};
  },
  listPushDevices: ({ s }) => {
    requireUser(s);
    return { items: [] };
  },

  listIncomingWebhooks: ({ s, params, request }) => {
    const u = requireUser(s);
    const { conv, c } = access(s, u, params.conversationId!);
    if (!permissions(s, conv, u.id).manageWebhooks) throw new MockApiError('forbidden');
    return {
      items: c.webhooks
        .filter((w) => w.conversationId === conv.id)
        .map((w) => toWebhook(s, w, request)),
    };
  },

  createIncomingWebhook: ({ s, params, body, request }) => {
    const u = requireUser(s);
    const { conv, c } = access(s, u, params.conversationId!);
    if (!permissions(s, conv, u.id).manageWebhooks) throw new MockApiError('forbidden');
    const h: MockWebhook = {
      id: newId(),
      conversationId: conv.id,
      name: body.name,
      avatarUrl: null,
      key: randomToken(24),
      rateLimit: CHAT_LIMITS.webhookPerMinute,
      lastUsedAt: null,
      mutedUntil: null,
      disabledAt: null,
      createdBy: u.id,
      createdAt: now(),
      provider: body.provider ?? null,
      events: body.provider ? (body.events ?? [...WEBHOOK_PROVIDER_EVENTS[body.provider]]) : [],
      textSeverity: body.textSeverity ?? null,
    };
    c.webhooks.push(h);
    systemLine(s, conv, { type: 'webhook_added', actorId: u.id, name: h.name });
    emitConvUpdated(s, conv);
    return {
      webhook: toWebhook(s, h, request),
      url: hookUrl(request, h, false),
      secret: h.provider ? randomToken(24) : null,
    };
  },

  updateIncomingWebhook: ({ s, params, body, request }) => {
    const u = requireUser(s);
    const { h } = webhookOf(s, u, params.webhookId!);
    if (body.name !== undefined) h.name = body.name;
    if (body.textSeverity !== undefined) h.textSeverity = body.textSeverity;
    if (body.mutedUntil !== undefined) h.mutedUntil = body.mutedUntil;
    if (body.disabled !== undefined) h.disabledAt = body.disabled ? now() : null;
    if (body.events !== undefined) {
      if (!h.provider) throw new MockApiError('bad_request');
      h.events = body.events;
    }
    return toWebhook(s, h, request);
  },

  deleteIncomingWebhook: ({ s, params }) => {
    const u = requireUser(s);
    const { h, c, conv } = webhookOf(s, u, params.webhookId!);
    c.webhooks = c.webhooks.filter((x) => x.id !== h.id);
    emitConvUpdated(s, conv);
    return {};
  },

  regenerateIncomingWebhookKey: ({ s, params, request }) => {
    const u = requireUser(s);
    const { h } = webhookOf(s, u, params.webhookId!);
    h.key = randomToken(24);
    return {
      webhook: toWebhook(s, h, request),
      url: hookUrl(request, h, false),
      secret: h.provider ? randomToken(24) : null,
    };
  },

  listWebhookDeliveries: ({ s, params, query }) => {
    const u = requireUser(s);
    const { h, c } = webhookOf(s, u, params.webhookId!);
    const week = Date.now() - 7 * 24 * HOUR;
    const list = c.deliveries
      .filter((d) => d.webhookId === h.id && Date.parse(d.receivedAt) >= week)
      .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
    const start = query.cursor ? Number(query.cursor) : 0;
    return {
      items: list.slice(start, start + query.limit).map(({ webhookId: _w, ...d }) => d),
      nextCursor: start + query.limit < list.length ? String(start + query.limit) : null,
    };
  },

  createPoll: ({ s, params, body }) => {
    const u = requireUser(s);
    const { conv } = access(s, u, params.conversationId!);
    const m = sendInto(s, u, conv, {
      clientMsgId: body.clientMsgId,
      text: body.question,
      attachmentNodeIds: [],
    });
    m.poll ??= {
      id: newId(),
      question: body.question,
      options: body.options,
      multiple: body.multiple,
      closedAt: null,
      createdBy: u.id,
      votes: [],
    };
    emitMessage(s, m, 'message.updated');
    return toMessage(s, m, u.id);
  },

  votePoll: ({ s, params, body }) => {
    const u = requireUser(s);
    const { m, poll } = pollOf(s, u, params.pollId!);
    if (poll.closedAt) throw new MockApiError('conflict', 'Poll closed');
    const chosen = [...new Set(body.options)];
    if (chosen.some((o) => o >= poll.options.length) || (!poll.multiple && chosen.length > 1)) {
      throw new MockApiError('validation_failed', 'Invalid option');
    }
    poll.votes = [
      ...poll.votes.filter((v) => v.userId !== u.id),
      ...chosen.map((option) => ({ userId: u.id, option })),
    ];
    m.updatedAt = now();
    emitMessage(s, m, 'message.updated');
    return toMessage(s, m, u.id);
  },

  closePoll: ({ s, params }) => {
    const u = requireUser(s);
    const { m, poll, conv } = pollOf(s, u, params.pollId!);
    if (poll.createdBy !== u.id && !permissions(s, conv, u.id).moderate) {
      throw new MockApiError('forbidden');
    }
    if (poll.closedAt) throw new MockApiError('conflict', 'Poll closed');
    poll.closedAt = now();
    m.updatedAt = poll.closedAt;
    emitMessage(s, m, 'message.updated');
    return toMessage(s, m, u.id);
  },

  listChatReminders: ({ s }) => {
    const u = requireUser(s);
    const items = remindersOf(s)
      .filter((r) => r.userId === u.id && !r.firedAt)
      .sort((a, b) => a.remindAt.localeCompare(b.remindAt))
      .map(({ userId: _u, ...r }) => r);
    return { items };
  },

  createChatReminder: ({ s, body }) => {
    const u = requireUser(s);
    access(s, u, body.conversationId);
    if (Date.parse(body.remindAt) < Date.now() - MIN) {
      throw new MockApiError('validation_failed', 'Reminder time is in the past');
    }
    const r: MockReminder = {
      id: newId(),
      userId: u.id,
      conversationId: body.conversationId,
      text: body.text,
      remindAt: body.remindAt,
      firedAt: null,
      createdAt: now(),
    };
    remindersOf(s).push(r);
    return [r].map(({ userId: _u, ...out }) => out)[0]!;
  },

  deleteChatReminder: ({ s, params }) => {
    const u = requireUser(s);
    const list = remindersOf(s);
    const i = list.findIndex((r) => r.id === params.reminderId && r.userId === u.id);
    if (i < 0) throw new MockApiError('not_found');
    list.splice(i, 1);
    return {};
  },

  listScheduledMessages: ({ s, params }) => {
    const u = requireUser(s);
    access(s, u, params.conversationId!);
    const items = scheduledOf(s)
      .filter(
        (x) =>
          x.conversationId === params.conversationId &&
          x.authorId === u.id &&
          x.status === 'scheduled',
      )
      .sort((a, b) => a.sendAt.localeCompare(b.sendAt))
      .map((x) => scheduledView(s, x));
    return { items };
  },
  createScheduledMessage: ({ s, params, body }) => {
    const u = requireUser(s);
    const { conv } = access(s, u, params.conversationId!);
    if (!permissions(s, conv, u.id).write) throw new MockApiError('forbidden');
    if (Date.parse(body.sendAt) < Date.now() - MIN) {
      throw new MockApiError('validation_failed', 'Send time is in the past');
    }
    if (!body.text.trim() && body.attachmentNodeIds.length === 0 && !body.refs?.length) {
      throw new MockApiError('validation_failed', 'Empty message');
    }
    const at = now();
    const x: MockScheduled = {
      id: newId(),
      conversationId: conv.id,
      authorId: u.id,
      text: body.text,
      replyToId: body.replyToId ?? null,
      attachmentNodeIds: body.attachmentNodeIds,
      sendAt: body.sendAt,
      status: 'scheduled',
      messageId: null,
      createdAt: at,
      updatedAt: at,
    };
    scheduledOf(s).push(x);
    return scheduledView(s, x);
  },
  updateScheduledMessage: ({ s, params, body }) => {
    const u = requireUser(s);
    const x = ownScheduled(s, u, params.scheduledId!);
    if (body.text !== undefined) x.text = body.text;
    if (body.sendAt !== undefined) x.sendAt = body.sendAt;
    x.updatedAt = now();
    return scheduledView(s, x);
  },
  deleteScheduledMessage: ({ s, params }) => {
    const u = requireUser(s);
    ownScheduled(s, u, params.scheduledId!).status = 'cancelled';
    return {};
  },
  sendScheduledMessageNow: ({ s, params }) => {
    const u = requireUser(s);
    const x = ownScheduled(s, u, params.scheduledId!);
    const { conv } = access(s, u, x.conversationId);
    const m = sendInto(s, u, conv, {
      clientMsgId: x.id,
      text: x.text,
      ...(x.replyToId ? { replyToId: x.replyToId } : {}),
      attachmentNodeIds: x.attachmentNodeIds,
    });
    x.status = 'sent';
    x.messageId = m.id;
    return toMessage(s, m, u.id);
  },

  getMessageInfo: ({ s, params }) => {
    const u = requireUser(s);
    const { m, c } = messageOf(s, u, params.messageId!);
    if (m.authorId !== u.id) throw new MockApiError('forbidden');
    const rows = rowsOf(c, m.conversationId).filter(
      (r) =>
        r.userId !== u.id &&
        (!m.whisperTo || r.userId === m.whisperTo) &&
        (r.historyFromSeq === null || r.historyFromSeq <= m.seq),
    );
    const seenRows = rows.filter((r) => r.lastReadSeq >= m.seq);
    const seen = seenRows.flatMap((r) => {
      const p = summaryOf(s, r.userId);
      return p ? [{ user: p, at: r.readAt ?? null }] : [];
    });
    const notSeen = rows
      .filter((r) => r.lastReadSeq < m.seq)
      .flatMap((r) => {
        const p = summaryOf(s, r.userId);
        return p ? [p] : [];
      });
    return {
      messageId: m.id,
      total: rows.length,
      seenCount: seen.length,
      seen,
      notSeen,
    };
  },
  trendingGifs: ({ s, query }) => gifPage(s, 'trend', query.offset, query.limit),
  searchGifs: ({ s, query }) => gifPage(s, query.q, query.offset, query.limit),
  getGifSettings: ({ s }) => gifSettingsView(s),
  updateGifSettings: ({ s, body }) => {
    requireUser(s);
    const c = chatState(s);
    const cur = c.gif ?? {
      enabled: false,
      apiKey: null,
      rating: 'g' as const,
      lang: 'tr',
      keyTier: 'beta' as const,
      used: 0,
    };
    c.gif = {
      enabled: body.enabled ?? cur.enabled,
      apiKey: body.apiKey !== undefined ? body.apiKey : cur.apiKey,
      rating: body.rating ?? cur.rating,
      lang: body.lang ?? cur.lang,
      keyTier: body.keyTier ?? cur.keyTier ?? 'beta',
      used: cur.used ?? 0,
    };
    return gifSettingsView(s);
  },
  testGifSettings: ({ s }) => {
    const g = chatState(s).gif;
    return g?.apiKey
      ? { ok: true, count: 5, error: null }
      : { ok: false, count: 0, error: 'no_key' };
  },
} satisfies Resolvers<ChatEndpoint>;

/** GIFs are on in the mock org: enabled with a key (the bootstrap lists chat.gif then). */
export function gifActiveMock(s: MockState): boolean {
  // Read without seeding: the bootstrap must not create the chat seed (its Drive folders).
  const g = (s as WithChat).chat?.gif;
  return Boolean(g?.enabled && g.apiKey);
}

function gifSettingsView(s: MockState) {
  const g = chatState(s).gif;
  return {
    enabled: g?.enabled ?? false,
    apiKey: {
      set: Boolean(g?.apiKey),
      hint: g?.apiKey ? `…${g.apiKey.slice(-4)}` : null,
      updatedAt: null,
    },
    rating: g?.rating ?? 'g',
    lang: g?.lang ?? 'tr',
    active: gifActiveMock(s),
    keyTier: g?.keyTier ?? 'beta',
    usage: {
      used: g?.used ?? 0,
      limit: (g?.keyTier ?? 'beta') === 'beta' ? GIF_BUDGET.beta : null,
      resetsAt: new Date(Math.ceil(Date.now() / 3_600_000) * 3_600_000).toISOString(),
    },
  };
}

/** Made-up GIPHY results (media.giphy.com URLs, never fetched in tests). */
function gifPage(s: MockState, seed: string, offset: number, limit: number) {
  if (!gifActiveMock(s)) throw new MockApiError('gif_disabled');
  const total = 60;
  const items = Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, i) => {
    const id = `${seed}-${offset + i}`.replace(/[^a-z0-9-]/gi, '');
    return {
      id,
      title: `${seed} ${offset + i + 1}`,
      previewUrl: `https://media.giphy.com/media/${id}/200w.gif`,
      previewWidth: 200,
      previewHeight: 150,
      url: `https://media.giphy.com/media/${id}/giphy.gif`,
      width: 480,
      height: 360,
      stillUrl: `https://media.giphy.com/media/${id}/200w_s.gif`,
    };
  });
  return { items, nextOffset: offset + items.length < total ? offset + items.length : null };
}

function scheduledOf(s: MockState): MockScheduled[] {
  const c = chatState(s);
  c.scheduled ??= [];
  return c.scheduled;
}

function ownScheduled(s: MockState, u: MockUser, id: string) {
  const x = scheduledOf(s).find((y) => y.id === id && y.authorId === u.id);
  if (!x) throw new MockApiError('not_found');
  if (x.status !== 'scheduled') throw new MockApiError('conflict', 'Not scheduled');
  return x;
}

function scheduledView(s: MockState, x: MockScheduled): ScheduledMessage {
  const d = driveState(s);
  return {
    id: x.id,
    conversationId: x.conversationId,
    text: x.text,
    replyToId: x.replyToId,
    attachments: x.attachmentNodeIds.flatMap((id) => {
      const n = d.nodes.find((y) => y.id === id);
      return n
        ? [
            {
              nodeId: n.id,
              name: n.name,
              mime: null,
              sizeBytes: 0,
              preview: 'none' as const,
              removed: n.deletedAt !== null,
            },
          ]
        : [];
    }),
    sendAt: x.sendAt,
    status: x.status,
    error: null,
    messageId: x.messageId,
    createdAt: x.createdAt,
    updatedAt: x.updatedAt,
  };
}

// ---- incoming webhooks: POST /api/hooks/:id?key= ----

const hookHandler = http.post('*/api/hooks/:webhookId', async ({ request, params }) => {
  const s = db();
  const c = chatState(s);
  const started = Date.now();
  const h = c.webhooks.find((x) => x.id === params.webhookId);
  const key = new URL(request.url).searchParams.get('key');
  const raw = await request.text();
  const log = (status: number, error: string | null, messageId: string | null = null) => {
    if (!h) return;
    c.deliveries.push({
      id: newId(),
      webhookId: h.id,
      receivedAt: now(),
      status,
      sizeBytes: raw.length,
      ip: '127.0.0.1',
      latencyMs: Date.now() - started,
      error,
      bodyExcerpt: error ? raw.slice(0, 300) : null,
      messageId,
    });
    save();
  };
  const fail = (status: number, code: string) => {
    log(status, code);
    return HttpResponse.json({ code, message: code }, { status });
  };
  if (!h || key !== h.key) {
    return HttpResponse.json(
      { code: 'webhook_key_invalid', message: 'webhook_key_invalid' },
      { status: 401 },
    );
  }
  if (h.disabledAt) return fail(403, 'webhook_disabled');
  if (raw.length > CHAT_LIMITS.webhookBodyBytes) return fail(413, 'webhook_payload_too_large');
  const minute = c.deliveries.filter(
    (d) => d.webhookId === h.id && Date.now() - Date.parse(d.receivedAt) < MIN && d.status < 400,
  );
  if (minute.length >= h.rateLimit) {
    log(429, 'rate_limited');
    return HttpResponse.json(
      { code: 'rate_limited', message: 'rate_limited' },
      { status: 429, headers: { 'Retry-After': '30' } },
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return fail(400, 'webhook_payload_invalid');
  }
  let text: string;
  let card: MockMessage['card'];
  const own = HookPayload.safeParse(json);
  if (own.success) {
    text = own.data.text ?? '';
    card = own.data.card
      ? {
          ...own.data.card,
          subtitle: own.data.card.subtitle ?? null,
          source: own.data.card.source ?? h.name,
          iconUrl: own.data.card.iconUrl ?? null,
          text: own.data.card.text ?? null,
        }
      : null;
  } else {
    const g = GoogleChatPayload.safeParse(json);
    if (!g.success || (!g.data.text && !g.data.cardsV2?.length)) {
      return fail(400, 'webhook_payload_invalid');
    }
    ({ text, card } = fromGoogleChat(g.data));
  }
  const conv = c.conversations.find((x) => x.id === h.conversationId);
  if (!conv) return fail(404, 'not_found');
  h.lastUsedAt = now();
  const muted = h.mutedUntil !== null && Date.parse(h.mutedUntil) > Date.now();
  const m = append(s, conv, {
    kind: 'webhook',
    authorId: null,
    webhookId: h.id,
    text,
    card:
      muted && card
        ? { ...card, severity: card.severity === 'critical' ? 'warning' : card.severity }
        : card,
    ...(!card && h.textSeverity ? { severity: h.textSeverity } : {}),
    system: null,
    attachments: [],
    replyToId: null,
    reactions: [],
    clientMsgId: null,
    pinnedAt: null,
    pinnedBy: null,
    editedAt: null,
    deletedAt: null,
  });
  log(200, null, m.id);
  return HttpResponse.json({ messageId: m.id, seq: m.seq });
});

// ---- /ws gateway ----

const gateway = ws.link(/\/ws(\?.*)?$/);

const wsHandler = gateway.addEventListener('connection', ({ client }) => {
  const s = db();
  const c = chatState(s);
  const ticket = client.url.searchParams.get('ticket');
  const t = c.tickets.find((x) => x.ticket === ticket && Date.parse(x.expiresAt) > Date.now());
  if (!t) {
    client.close(4401, 'ws_ticket_invalid');
    return;
  }
  c.tickets = c.tickets.filter((x) => x !== t);
  const conn: Connection = { userId: t.userId, send: (e) => client.send(JSON.stringify(e)) };
  connections.add(conn);
  const p = (c.presence[t.userId] ??= { state: 'online', auto: null, lastSeenAt: now() });
  p.state = 'online';
  p.lastSeenAt = now();
  conn.send({
    type: 'ready',
    userId: t.userId,
    orgId: s.org?.id ?? t.userId,
    serverTime: now(),
    heartbeatSeconds: CHAT_LIMITS.heartbeatSeconds,
  });
  emitPresence(s, t.userId);
  client.addEventListener('message', (ev) => {
    if (typeof ev.data !== 'string') return;
    let raw: unknown;
    try {
      raw = JSON.parse(ev.data);
    } catch {
      return;
    }
    const parsed = WsClientEvent.safeParse(raw);
    if (!parsed.success) return;
    const e = parsed.data;
    const st = db();
    const cs = chatState(st);
    if (e.type === 'heartbeat') {
      const pr = (cs.presence[t.userId] ??= { state: 'online', auto: null, lastSeenAt: now() });
      const next = e.active ? 'online' : 'away';
      pr.lastSeenAt = now();
      if (pr.state !== next && pr.state !== 'busy' && pr.state !== 'dnd') {
        pr.state = next;
        emitPresence(st, t.userId);
      }
    } else if (e.type === 'typing') {
      if (!rowOf(cs, e.conversationId, t.userId)) return;
      const expiresAt = new Date(Date.now() + CHAT_LIMITS.typingSeconds * 1000).toISOString();
      emitConversation(st, e.conversationId, (uid) =>
        uid === t.userId
          ? null
          : { type: 'typing', conversationId: e.conversationId, userId: t.userId, expiresAt },
      );
    }
  });
  client.addEventListener('close', () => {
    connections.delete(conn);
  });
});

export const chatRawHandlers = [hookHandler, wsHandler];

/** Tests: drop sockets between cases. */
export function resetChatConnections(): void {
  connections.clear();
}

export { CONV };
