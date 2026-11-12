import { type QueryClient } from '@tanstack/react-query';
import { chatKeys, type MessageWindow } from './queries';
import { type Conversation, type Message, type MessagePreview, type PinnedEntry } from './types';

/** Pure cache updates shared by the socket handler, writes and the outbox. */

/** Ascending by seq, one entry per seq (the later copy wins: edits, deletes). */
export function mergeMessages(items: Message[], incoming: Message[]): Message[] {
  if (incoming.length === 0) return items;
  const bySeq = new Map<number, Message>();
  for (const m of items) bySeq.set(m.seq, m);
  for (const m of incoming) {
    const old = bySeq.get(m.seq);
    // An older copy (late event after a fresher HTTP answer) never wins.
    if (old && Date.parse(old.updatedAt) > Date.parse(m.updatedAt)) continue;
    bySeq.set(m.seq, m);
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/** Seq after which something is missing in a sorted list (from `fromSeq` on), or null. */
export function firstGap(items: Message[], fromSeq: number): number | null {
  let expected = fromSeq + 1;
  for (const m of items) {
    if (m.seq < expected) continue;
    if (m.seq > expected) return expected - 1;
    expected++;
  }
  return null;
}

export function previewOf(m: Message, excerpt: string): MessagePreview {
  return {
    seq: m.seq,
    kind: m.kind,
    authorId: m.author?.id ?? null,
    authorName: m.author?.name ?? m.webhook?.name ?? null,
    excerpt: m.deletedAt ? null : excerpt.slice(0, 200),
    hasAttachments: m.attachments.length > 0,
    deleted: m.deletedAt !== null,
    createdAt: m.createdAt,
  };
}

/** Pinned chats first (by position), then the rest by last message, newest first. */
export function sortConversations(list: Conversation[]): Conversation[] {
  const t = (c: Conversation) => (c.lastMessageAt ? Date.parse(c.lastMessageAt) : 0);
  return [...list].sort((a, b) => {
    const pa = a.my.pinnedAt !== null;
    const pb = b.my.pinnedAt !== null;
    if (pa !== pb) return pa ? -1 : 1;
    if (pa && pb) {
      const d = (a.my.pinPosition ?? 999) - (b.my.pinPosition ?? 999);
      if (d !== 0) return d;
    }
    return t(b) - t(a) || Date.parse(b.createdAt) - Date.parse(a.createdAt);
  });
}

export function upsertConversation(qc: QueryClient, conv: Conversation): void {
  qc.setQueryData<Conversation[]>(chatKeys.conversations, (list) => {
    if (!list) return list;
    const rest = list.filter((c) => c.id !== conv.id);
    return sortConversations(conv.archivedAt ? rest : [...rest, conv]);
  });
  qc.setQueryData(chatKeys.conversation(conv.id), conv);
}

export function removeConversation(qc: QueryClient, id: string): void {
  qc.setQueryData<Conversation[]>(chatKeys.conversations, (list) =>
    list?.filter((c) => c.id !== id),
  );
  qc.removeQueries({ queryKey: chatKeys.conversation(id) });
  qc.removeQueries({ queryKey: chatKeys.messages(id) });
}

export function findConversation(qc: QueryClient, id: string): Conversation | undefined {
  return (
    qc.getQueryData<Conversation[]>(chatKeys.conversations)?.find((c) => c.id === id) ??
    qc.getQueryData<Conversation>(chatKeys.conversation(id))
  );
}

export function patchConversation(
  qc: QueryClient,
  id: string,
  fn: (c: Conversation) => Conversation,
): boolean {
  let found = false;
  qc.setQueryData<Conversation[]>(chatKeys.conversations, (list) => {
    if (!list) return list;
    const next = list.map((c) => {
      if (c.id !== id) return c;
      found = true;
      return fn(c);
    });
    return found ? sortConversations(next) : list;
  });
  qc.setQueryData<Conversation>(chatKeys.conversation(id), (c) => (c ? fn(c) : c));
  return found;
}

export function getWindow(qc: QueryClient, id: string): MessageWindow | undefined {
  return qc.getQueryData<MessageWindow>(chatKeys.messages(id));
}

/** Adds or replaces messages in a loaded window; returns the window's newest seq before. */
export function putMessages(qc: QueryClient, id: string, msgs: Message[]): number | null {
  let before: number | null = null;
  qc.setQueryData<MessageWindow>(chatKeys.messages(id), (w) => {
    if (!w) return w;
    before = w.items.at(-1)?.seq ?? 0;
    // While parked on old history, only replace what is on screen.
    const usable = w.hasNewer ? msgs.filter((m) => w.items.some((x) => x.seq === m.seq)) : msgs;
    return { ...w, items: mergeMessages(w.items, usable) };
  });
  return before;
}

export function patchMessage(
  qc: QueryClient,
  convId: string,
  messageId: string,
  fn: (m: Message) => Message,
): void {
  qc.setQueryData<MessageWindow>(chatKeys.messages(convId), (w) =>
    w ? { ...w, items: w.items.map((m) => (m.id === messageId ? fn(m) : m)) } : w,
  );
  qc.setQueryData<PinnedEntry[]>(chatKeys.pinned(convId), (list) =>
    list?.map((p) => (p.message.id === messageId ? { ...p, message: fn(p.message) } : p)),
  );
}

/** Incremental reaction event: one person added or removed one emoji. */
export function applyReaction(
  m: Message,
  emoji: string,
  userId: string,
  added: boolean,
  meId: string,
): Message {
  const list = [...m.reactions];
  const i = list.findIndex((r) => r.emoji === emoji);
  const cur = i >= 0 ? list[i] : undefined;
  const has = cur?.userIds.includes(userId) ?? false;
  if (added === has && (cur || !added)) return m;
  if (added) {
    const next = cur
      ? {
          ...cur,
          count: cur.count + 1,
          userIds: [...cur.userIds, userId].slice(0, 20),
          mine: cur.mine || userId === meId,
        }
      : { emoji, count: 1, userIds: [userId], mine: userId === meId };
    if (i >= 0) list[i] = next;
    else list.push(next);
  } else if (cur) {
    const count = cur.count - 1;
    if (count <= 0) list.splice(i, 1);
    else {
      list[i] = {
        ...cur,
        count,
        userIds: cur.userIds.filter((u) => u !== userId),
        mine: userId === meId ? false : cur.mine,
      };
    }
  }
  return { ...m, reactions: list };
}

function mentionsMe(m: Message, meId: string): boolean {
  return m.mentions.some((x) => x.kind !== 'user' || x.userId === meId);
}

/** A new message reached the chat: list preview, order and unread counters. */
export function noteNewMessage(
  qc: QueryClient,
  m: Message,
  meId: string,
  opts: { reading: boolean; excerpt: string },
): boolean {
  const mine = m.author?.id === meId;
  return patchConversation(qc, m.conversationId, (c) => {
    if (m.seq < c.lastSeq) return c;
    const isNew = m.seq > c.lastSeq;
    const bump = isNew && !mine && !opts.reading && m.kind !== 'system';
    return {
      ...c,
      lastSeq: m.seq,
      lastMessageAt: m.createdAt,
      lastMessage: previewOf(m, opts.excerpt),
      my: {
        ...c.my,
        ...(mine ? { lastReadSeq: m.seq, unread: 0, unreadMentions: 0 } : {}),
        ...(bump
          ? {
              unread: c.my.unread + 1,
              unreadMentions: c.my.unreadMentions + (mentionsMe(m, meId) ? 1 : 0),
            }
          : {}),
      },
    };
  });
}

/** My read position moved: counts from the server when known, else worked out locally. */
export function noteMyRead(
  qc: QueryClient,
  convId: string,
  seq: number,
  meId: string,
  counts?: { unread: number; unreadMentions: number },
): void {
  const w = getWindow(qc, convId);
  patchConversation(qc, convId, (c) => {
    if (counts) {
      return { ...c, my: { ...c.my, lastReadSeq: seq, ...counts } };
    }
    if (seq <= c.my.lastReadSeq) return c;
    let unread = 0;
    let unreadMentions = 0;
    if (seq < c.lastSeq) {
      const firstLoaded = w?.items[0]?.seq ?? Infinity;
      if (w && firstLoaded <= seq + 1 && !w.hasNewer) {
        for (const m of w.items) {
          if (m.seq <= seq || m.author?.id === meId || m.kind === 'system') continue;
          unread++;
          if (mentionsMe(m, meId)) unreadMentions++;
        }
      } else {
        unread = Math.min(c.my.unread, c.lastSeq - seq);
        unreadMentions = Math.min(c.my.unreadMentions, unread);
      }
    }
    return { ...c, my: { ...c.my, lastReadSeq: seq, unread, unreadMentions, markedUnread: false } };
  });
}

/** Rail badge: chats with unread messages; muted ones only count mentions. */
export function unreadConversations(list: Conversation[] | undefined, now: number): number {
  if (!list) return 0;
  return list.filter((c) => {
    const muted =
      c.my.notify === 'none' || (c.my.mutedUntil !== null && Date.parse(c.my.mutedUntil) > now);
    return muted ? c.my.unreadMentions > 0 : c.my.unread > 0;
  }).length;
}
