import { queryKeys } from '@crewhall/api-client';
import { type QueryClient } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { config } from '@/config';
import { api, isApiError } from '@/lib/api';
import { activeMeetingsKey } from '@/lib/meet/active';
import { handleBoardsEvent } from '@/lib/boards/realtime';
import { handleInboxEvent } from '@/lib/mail/inbox';
import { handleMailEvent } from '@/lib/mail/realtime';
import { callKeys, handleCallEvent } from '@/lib/meet/calls';
import { membersQuery } from '@/lib/queries';
import { handleTablesEvent } from '@/lib/tables/api';
import {
  applyReaction,
  findConversation,
  getWindow,
  noteMyRead,
  noteNewMessage,
  patchConversation,
  patchMessage,
  putMessages,
  removeConversation,
  upsertConversation,
} from './cache';
import { excerptOf, rememberPeople } from './names';
import { bindOutbox, setOutboxOnline } from './outbox';
import { soundForMessage } from './sound';
import { chatKeys, type MessageWindow } from './queries';
import { ChatSocket, type SocketState } from './socket';
import {
  clearTyping,
  getVisibleConversation,
  idleSeconds,
  isActive,
  isLooking,
  noteTyping,
  setPresence,
  subscribeVisibleConversation,
} from './stores';
import { type Message, type ReadReceipt, type WsServerEvent } from './types';

/**
 * Glue between the socket and the query cache: applies events, fills seq gaps with
 * ?afterSeq, catches up after a reconnect (GET /me/unreads first, then the open chats, then
 * edits with ?updatedAfter) and sends read positions one second after they become visible.
 */

let socket: ChatSocket | null = null;
let qc: QueryClient | null = null;
let meId = '';
let watched: string[] = [];

export function wsUrl(ticket: string, path: string): string {
  const base = new URL(config.apiUrl);
  base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  base.pathname = path;
  base.search = `?ticket=${encodeURIComponent(ticket)}`;
  return base.toString();
}

// Visible and focused: a window behind others is not someone at the chat (stores.isLooking).
const focused = isLooking;

let chatOn = true;

/**
 * `chat`: false when the org turned chat off; the socket still carries notifications and Drive
 * events, but no chat data is loaded or watched.
 */
export function startChatRuntime(
  client: QueryClient,
  userId: string,
  opts: { chat: boolean } = { chat: true },
): () => void {
  stopChatRuntime();
  qc = client;
  meId = userId;
  chatOn = opts.chat;
  bindOutbox(client, userId);
  const s = new ChatSocket({
    getTicket: async () => {
      const t = await api.call('createWsTicket');
      return { ticket: t.ticket, path: t.path };
    },
    url: wsUrl,
    onEvent: handleEvent,
    onOpen: (reconnected) => {
      setOutboxOnline(true);
      s.sendHeartbeat();
      if (watched.length) s.send({ type: 'presence.watch', userIds: watched });
      if (reconnected) void catchUp();
    },
    isFatal: (e) => isApiError(e, 'unauthenticated'),
    isActive,
    getIdleSeconds: idleSeconds,
    isFocused: focused,
    // H8: the server skips notifications from the chat that is open in a visible tab.
    getActiveConversation: () => (chatOn ? getVisibleConversation() : null),
  });
  socket = s;
  const unsub = s.subscribe(() => {
    if (s.getState().status !== 'open') setOutboxOnline(false);
  });
  const onOnline = () => s.retryNow();
  const onVisibility = () => s.sendHeartbeat();
  window.addEventListener('online', onOnline);
  document.addEventListener('visibilitychange', onVisibility);
  // Switching to another window tells the server at once: notifications from the open chat
  // come again (H8) and a push is no longer held for this session.
  window.addEventListener('focus', onVisibility);
  window.addEventListener('blur', onVisibility);
  // Opening or leaving a chat tells the server at once, not at the next 25 s beat.
  const unsubVisible = subscribeVisibleConversation(() => s.sendHeartbeat());
  s.start();
  void watchOrgPresence();
  if (import.meta.env.DEV) {
    // Manual reconnect checks (design 4.18): __crewhallChat.outage(10000) in the console.
    Object.assign(window, { __crewhallChat: { outage: (ms: number) => s.simulateOutage(ms) } });
  }
  return () => {
    window.removeEventListener('online', onOnline);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('focus', onVisibility);
    window.removeEventListener('blur', onVisibility);
    unsubVisible();
    unsub();
    if (socket === s) stopChatRuntime();
  };
}

export function stopChatRuntime(): void {
  socket?.stop();
  socket = null;
  for (const r of reads.values()) if (r.timer) clearTimeout(r.timer);
  reads.clear();
  typingSent.clear();
}

/** Presence of the org's people (the palette, cards and lists all show it). */
async function watchOrgPresence(): Promise<void> {
  const client = qc;
  if (!client || !chatOn) return;
  try {
    const members = await client.fetchQuery(membersQuery({ status: 'active' }));
    rememberPeople(members.items.map((m) => m.user));
    watched = members.items.map((m) => m.user.id).slice(0, 200);
    if (watched.length === 0) return;
    socket?.send({ type: 'presence.watch', userIds: watched });
    const snap = await api.call('getPresence', { body: { userIds: watched } });
    setPresence(snap.items);
  } catch {
    /* presence dots stay empty until events arrive */
  }
}

// ---- socket state for the UI (4.18 banner) ----

const IDLE: SocketState = { status: 'idle', attempt: 0, retryAt: null, everOpened: false };

export function useSocketState(): SocketState {
  return useSyncExternalStore(
    (l) => socket?.subscribe(l) ?? (() => undefined),
    () => socket?.getState() ?? IDLE,
    () => IDLE,
  );
}

export function retrySocketNow(): void {
  socket?.retryNow();
}

// ---- events ----

function isReading(conversationId: string): boolean {
  return getVisibleConversation() === conversationId && isLooking();
}

function noteMessage(client: QueryClient, m: Message): boolean {
  if (m.author) rememberPeople([m.author]);
  return noteNewMessage(client, m, meId, {
    reading: isReading(m.conversationId),
    excerpt: excerptOf(m),
  });
}

/** Events are the same for everyone, so `mine` on reactions comes from the user ids. */
function withMine(m: Message): Message {
  if (!m.reactions.length) return m;
  return { ...m, reactions: m.reactions.map((r) => ({ ...r, mine: r.userIds.includes(meId) })) };
}

export function handleEvent(raw: WsServerEvent): void {
  const client = qc;
  if (!client) return;
  const e =
    raw.type === 'message.created' || raw.type === 'message.updated'
      ? { ...raw, message: withMine(raw.message) }
      : raw;
  switch (e.type) {
    case 'ready':
      // A call may have started ringing while the socket was (re)connecting (H7).
      void client.invalidateQueries({ queryKey: callKeys.incoming });
      return;
    case 'error':
      return;
    case 'message.created': {
      const m = e.message;
      const before = putMessages(client, e.conversationId, [m]);
      const w = getWindow(client, e.conversationId);
      if (before !== null && w && !w.hasNewer && m.seq > before + 1) {
        void fillAfter(e.conversationId, before);
      }
      if (m.author) clearTyping(e.conversationId, m.author.id);
      soundForMessage(client, m, meId);
      const known = noteMessage(client, m);
      if (!known) void client.invalidateQueries({ queryKey: chatKeys.conversations });
      if (m.attachments.length) {
        void client.invalidateQueries({ queryKey: chatKeys.files(e.conversationId) });
      }
      if (m.kind === 'system' && m.system?.type === 'message_pinned') {
        void client.invalidateQueries({ queryKey: chatKeys.pinned(e.conversationId) });
      }
      return;
    }
    case 'message.updated': {
      putMessages(client, e.conversationId, [e.message]);
      patchMessage(client, e.conversationId, e.message.id, () => e.message);
      void client.invalidateQueries({ queryKey: chatKeys.pinned(e.conversationId) });
      const c = findConversation(client, e.conversationId);
      if (c?.lastSeq === e.message.seq) noteMessage(client, e.message);
      return;
    }
    case 'message.deleted':
      patchMessage(client, e.conversationId, e.messageId, (m) => ({
        ...m,
        text: '',
        card: null,
        mentions: [],
        attachments: [],
        reactions: [],
        deletedAt: e.deletedAt,
        updatedAt: e.deletedAt,
      }));
      patchConversation(client, e.conversationId, (c) =>
        c.lastMessage?.seq === e.seq
          ? { ...c, lastMessage: { ...c.lastMessage, excerpt: null, deleted: true } }
          : c,
      );
      return;
    case 'reaction':
      patchMessage(client, e.conversationId, e.messageId, (m) =>
        applyReaction(m, e.emoji, e.userId, e.added, meId),
      );
      return;
    case 'read':
      if (e.userId === meId) {
        noteMyRead(
          client,
          e.conversationId,
          e.lastReadSeq,
          meId,
          e.unread !== undefined
            ? { unread: e.unread, unreadMentions: e.unreadMentions ?? 0 }
            : undefined,
        );
        return;
      }
      // Receipts still loading: refetch rather than drop the event (the fetch may predate it).
      if (client.getQueryState(chatKeys.reads(e.conversationId))?.status !== 'success') {
        void client.invalidateQueries({ queryKey: chatKeys.reads(e.conversationId) });
        return;
      }
      client.setQueryData<ReadReceipt[]>(chatKeys.reads(e.conversationId), (list) => {
        if (!list) return list;
        const rest = list.filter((r) => r.userId !== e.userId);
        return [
          ...rest,
          { userId: e.userId, lastReadSeq: e.lastReadSeq, at: new Date().toISOString() },
        ];
      });
      return;
    case 'typing':
      if (e.userId !== meId) {
        const ttl = Math.min(Math.max(Date.parse(e.expiresAt) - Date.now(), 500), 5000);
        noteTyping(e.conversationId, e.userId, Number.isFinite(ttl) ? ttl : undefined);
      }
      return;
    case 'presence':
      setPresence([e.presence]);
      void client.invalidateQueries({ queryKey: chatKeys.userCard(e.presence.userId) });
      return;
    case 'conversation.updated':
      upsertConversation(client, e.conversation);
      return;
    case 'conversation.removed':
      removeConversation(client, e.conversationId);
      return;
    case 'notification':
    case 'notifications.changed':
      client.setQueryData(chatKeys.notificationCounts, (c: { unread: number } | undefined) =>
        c ? { ...c, unread: e.unreadCount } : c,
      );
      void client.invalidateQueries({ queryKey: chatKeys.notifications });
      // A new announcement (roadmap 19) shows on the home card and the rail badge.
      if (e.type === 'notification' && e.notification.type.startsWith('announcement.')) {
        void client.invalidateQueries({ queryKey: ['announcements'] });
      }
      return;
    case 'node.updated':
      void client.invalidateQueries({ queryKey: queryKeys.nodes(e.spaceId) });
      void client.invalidateQueries({ queryKey: queryKeys.node(e.nodeId) });
      return;
    case 'link.status':
      void client.invalidateQueries({ queryKey: queryKeys.surfaces });
      return;
    case 'surface.changed':
      void client.invalidateQueries({ queryKey: queryKeys.surface(e.surfaceId) });
      void client.invalidateQueries({ queryKey: queryKeys.surfaces, exact: true });
      return;
    case 'board.changed':
    case 'drawing.thumbnail':
      handleBoardsEvent(client, e);
      return;
    case 'call.ringing':
    case 'call.updated':
      handleCallEvent(client, e, meId);
      return;
    case 'meet.active':
      void client.invalidateQueries({ queryKey: activeMeetingsKey });
      return;
    case 'mail.changed':
      handleMailEvent(client, e);
      return;
    case 'mail.inbox.changed':
    case 'mail.inbox.replying':
      handleInboxEvent(client, e);
      return;
    case 'tables.changed':
      handleTablesEvent(client, e);
      return;
    case 'resync':
      void catchUp();
      return;
  }
}

// ---- gaps and reconnects ----

const filling = new Map<string, Promise<void>>();

/** Fetches everything after `afterSeq` (doc 17 §6: the client fills seq gaps itself). */
export function fillAfter(conversationId: string, afterSeq: number): Promise<void> {
  const running = filling.get(conversationId);
  if (running) return running.then(() => fillAfterNow(conversationId));
  const p = (async () => {
    let from = afterSeq;
    for (let i = 0; i < 20 && qc; i++) {
      const page = await api.call('listMessages', {
        params: { conversationId },
        query: { afterSeq: from, limit: 200 },
      });
      if (page.items.length === 0) break;
      putMessages(qc, conversationId, page.items);
      const last = page.items.at(-1);
      if (last) noteMessage(qc, last);
      from = last?.seq ?? from;
      if (!page.hasMoreAfter) break;
    }
  })()
    .catch(() => undefined)
    .finally(() => filling.delete(conversationId));
  filling.set(conversationId, p);
  return p;
}

/** After a running fill: fill again from wherever the window ends now. */
function fillAfterNow(conversationId: string): Promise<void> {
  const w = qc ? getWindow(qc, conversationId) : undefined;
  if (!w || w.hasNewer) return Promise.resolve();
  return fillAfter(conversationId, w.items.at(-1)?.seq ?? 0);
}

/** Edits, deletes and reactions that happened while the socket was down. */
async function refreshUpdated(conversationId: string, w: MessageWindow): Promise<void> {
  const client = qc;
  if (!client || w.items.length === 0) return;
  const since = w.items.reduce(
    (a, m) => (m.updatedAt > a ? m.updatedAt : a),
    w.items[0]!.updatedAt,
  );
  try {
    const page = await api.call('listMessages', {
      params: { conversationId },
      query: { updatedAfter: since, limit: 200 },
    });
    putMessages(client, conversationId, page.items);
  } catch {
    /* next reconnect tries again */
  }
}

/** Reconnected (or told to resync): unread counters, then missed messages of open chats. */
export async function catchUp(): Promise<void> {
  const client = qc;
  if (!client) return;
  if (!chatOn) {
    void client.invalidateQueries({ queryKey: chatKeys.notifications });
    return;
  }
  try {
    const u = await api.call('getUnreads');
    client.setQueryData(chatKeys.unreads, u);
    let unknown = false;
    for (const row of u.conversations) {
      const found = patchConversation(client, row.conversationId, (c) => ({
        ...c,
        lastSeq: Math.max(c.lastSeq, row.lastSeq),
        lastMessageAt: row.lastMessageAt ?? c.lastMessageAt,
        my: {
          ...c.my,
          lastReadSeq: row.lastReadSeq,
          unread: row.unread,
          unreadMentions: row.unreadMentions,
        },
      }));
      if (!found) unknown = true;
    }
    if (unknown) void client.invalidateQueries({ queryKey: chatKeys.conversations });
    client.setQueryData(chatKeys.notificationCounts, (c: { unread: number } | undefined) =>
      c ? { ...c, unread: u.notificationsUnread } : c,
    );
  } catch {
    void client.invalidateQueries({ queryKey: chatKeys.conversations });
  }
  const windows = client.getQueriesData<MessageWindow>({ queryKey: ['chat', 'messages'] });
  await Promise.all(
    windows.map(async ([key, w]) => {
      const id = key[2];
      if (typeof id !== 'string' || !w || w.hasNewer) return;
      await fillAfter(id, w.items.at(-1)?.seq ?? 0);
      await refreshUpdated(id, w);
    }),
  );
  void client.invalidateQueries({ queryKey: ['chat', 'reads'] });
  void client.invalidateQueries({ queryKey: chatKeys.notifications });
  void watchOrgPresence();
}

// ---- read positions (1 s after visible, only forward) ----

const READ_DELAY_MS = 1000;
const reads = new Map<
  string,
  { sent: number; pending: number; timer: ReturnType<typeof setTimeout> | null }
>();

/**
 * Chats marked unread on purpose: the open pane does not read them back until the chat is
 * opened again (releaseUnreadHold on the pane's mount).
 */
const heldUnread = new Set<string>();

export function reportVisibleSeq(conversationId: string, seq: number): void {
  const client = qc;
  if (!client || heldUnread.has(conversationId)) return;
  const conv = findConversation(client, conversationId);
  const r = reads.get(conversationId) ?? { sent: 0, pending: 0, timer: null };
  reads.set(conversationId, r);
  const floor = Math.max(r.sent, conv?.my.lastReadSeq ?? 0);
  if (seq <= floor || seq <= r.pending) return;
  r.pending = seq;
  r.timer ??= setTimeout(() => void sendRead(conversationId), READ_DELAY_MS);
}

async function sendRead(conversationId: string): Promise<void> {
  const r = reads.get(conversationId);
  if (!r || !qc) return;
  r.timer = null;
  if (!isReading(conversationId)) {
    // Hidden tab or another chat: the next visible report starts over.
    r.pending = 0;
    return;
  }
  const seq = r.pending;
  if (seq <= r.sent) return;
  r.sent = seq;
  noteMyRead(qc, conversationId, seq, meId);
  try {
    const res = await api.call('markConversationRead', {
      params: { conversationId },
      body: { seq },
    });
    noteMyRead(qc, conversationId, res.lastReadSeq, meId, {
      unread: res.unread,
      unreadMentions: res.unreadMentions,
    });
  } catch {
    r.sent = 0; // the next visible seq retries
  }
}

/** "Okunmadı olarak işaretle" moves the position back; let reads start over from there. */
export function resetReadPosition(conversationId: string): void {
  const r = reads.get(conversationId);
  if (r?.timer) clearTimeout(r.timer);
  reads.delete(conversationId);
}

/** Marked unread: stays so while it is on screen, until the chat is opened again. */
export function holdUnread(conversationId: string): void {
  heldUnread.add(conversationId);
  resetReadPosition(conversationId);
}

/** The chat was opened: reading it counts again. */
export function releaseUnreadHold(conversationId: string): void {
  heldUnread.delete(conversationId);
}

// ---- typing ----

const TYPING_EVERY_MS = 2500;
const typingSent = new Map<string, number>();

export function sendTyping(conversationId: string): void {
  if (!isReading(conversationId)) return;
  const last = typingSent.get(conversationId) ?? 0;
  if (Date.now() - last < TYPING_EVERY_MS) return;
  if (socket?.send({ type: 'typing', conversationId })) {
    typingSent.set(conversationId, Date.now());
  }
}

// ---- old history and jumps ----

export async function loadOlder(conversationId: string): Promise<void> {
  const client = qc;
  const w = client ? getWindow(client, conversationId) : undefined;
  if (!client || !w || !w.hasMore) return;
  const first = w.items[0]?.seq;
  if (first === undefined) return;
  const page = await api.call('listMessages', {
    params: { conversationId },
    query: { beforeSeq: first, limit: 50 },
  });
  client.setQueryData<MessageWindow>(chatKeys.messages(conversationId), (cur) => {
    if (!cur) return cur;
    const bySeq = new Map(cur.items.map((m) => [m.seq, m]));
    for (const m of page.items) if (!bySeq.has(m.seq)) bySeq.set(m.seq, m);
    return {
      ...cur,
      hasMore: page.hasMoreBefore,
      items: [...bySeq.values()].sort((a, b) => a.seq - b.seq),
    };
  });
}

/** Makes sure `seq` is loaded: older pages when close, otherwise a window around it. */
export async function ensureLoaded(conversationId: string, seq: number): Promise<void> {
  const client = qc;
  if (!client) return;
  const w = getWindow(client, conversationId);
  if (w?.items.some((m) => m.seq === seq)) return;
  const first = w?.items[0]?.seq ?? Infinity;
  if (w && !w.hasNewer && first - seq <= 150) {
    for (let i = 0; i < 5; i++) {
      const cur = getWindow(client, conversationId);
      const f = cur?.items[0]?.seq;
      if (f === undefined || f <= seq || !cur?.hasMore) break;
      await loadOlder(conversationId);
    }
    return;
  }
  const page = await api.call('listMessages', {
    params: { conversationId },
    query: { aroundSeq: seq, limit: 50 },
  });
  client.setQueryData<MessageWindow>(chatKeys.messages(conversationId), {
    items: page.items,
    hasMore: page.hasMoreBefore,
    hasNewer: page.hasMoreAfter,
  });
}

/** "Son mesajlara git": drop a parked window and load the newest page again. */
export async function jumpToLatest(conversationId: string): Promise<void> {
  const client = qc;
  if (!client) return;
  const page = await api.call('listMessages', {
    params: { conversationId },
    query: { limit: 50 },
  });
  client.setQueryData<MessageWindow>(chatKeys.messages(conversationId), {
    items: page.items,
    hasMore: page.hasMoreBefore,
    hasNewer: false,
  });
}

/** Tests: drive the cache without a socket. */
export function bindRuntimeForTests(client: QueryClient, userId: string): void {
  qc = client;
  meId = userId;
  bindOutbox(client, userId);
}
