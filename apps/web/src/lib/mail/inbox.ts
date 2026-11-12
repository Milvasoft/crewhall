import {
  type MailConversationsQuery,
  type MailInboxPerson,
  type MailInboxWsEvent,
} from '@crewhall/shared';
import { infiniteQueryOptions, queryOptions, type QueryClient } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { api } from '@/lib/api';

/** Shared inbox (sonraki-isler.md "Ortak gelen kutusu"): queries, live events, replying marks. */

export type InboxFilter = Pick<MailConversationsQuery, 'status'> & {
  assignee?: 'me' | 'none';
  tag?: string;
  q?: string;
};

export const inboxKeys = {
  all: ['mail', 'inboxes'] as const,
  list: ['mail', 'inboxes', 'list'] as const,
  conversations: (inboxId: string) => ['mail', 'inboxes', inboxId, 'conversations'] as const,
  filtered: (inboxId: string, f: InboxFilter) =>
    ['mail', 'inboxes', inboxId, 'conversations', f] as const,
  conversation: (inboxId: string, id: string, remoteImages: boolean) =>
    ['mail', 'inboxes', inboxId, 'conversation', id, remoteImages] as const,
  conversationAll: (inboxId: string, id: string) =>
    ['mail', 'inboxes', inboxId, 'conversation', id] as const,
  canned: (inboxId: string) => ['mail', 'inboxes', inboxId, 'canned'] as const,
  tags: (inboxId: string) => ['mail', 'inboxes', inboxId, 'tags'] as const,
};

export const mailInboxesQuery = queryOptions({
  queryKey: inboxKeys.list,
  queryFn: ({ signal }) => api.call('mailInboxes', { signal }),
  staleTime: 30_000,
});

export const conversationsQuery = (inboxId: string, f: InboxFilter) =>
  infiniteQueryOptions({
    queryKey: inboxKeys.filtered(inboxId, f),
    queryFn: ({ signal, pageParam }) =>
      api.call('mailInboxConversations', {
        params: { inboxId },
        query: {
          status: f.status,
          limit: 50,
          ...(f.assignee ? { assignee: f.assignee } : {}),
          ...(f.tag ? { tag: f.tag } : {}),
          ...(f.q ? { q: f.q } : {}),
          ...(pageParam ? { cursor: pageParam } : {}),
        },
        signal,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    staleTime: 15_000,
    // Live events keep it current; this covers a socket that is down.
    refetchInterval: 5 * 60_000,
  });

export const conversationQuery = (inboxId: string, id: string, remoteImages: boolean) =>
  queryOptions({
    queryKey: inboxKeys.conversation(inboxId, id, remoteImages),
    queryFn: ({ signal }) =>
      api.call('mailInboxConversation', {
        params: { inboxId, conversationId: id },
        query: remoteImages ? { remoteImages: 'true' } : {},
        signal,
      }),
    staleTime: 30_000,
  });

export const cannedQuery = (inboxId: string) =>
  queryOptions({
    queryKey: inboxKeys.canned(inboxId),
    queryFn: ({ signal }) => api.call('mailCannedResponses', { params: { inboxId }, signal }),
    staleTime: 60_000,
  });

export const tagsQuery = (inboxId: string) =>
  queryOptions({
    queryKey: inboxKeys.tags(inboxId),
    queryFn: ({ signal }) => api.call('mailInboxTags', { params: { inboxId }, signal }),
    staleTime: 60_000,
  });

/* ---------------------------------- "replying now" marks ------------------------------- */

/** Others writing a reply, per conversation; a mark lapses without a heartbeat (server: 15 s). */
const MARK_MS = 20_000;
const marks = new Map<string, Map<string, { person: MailInboxPerson; until: number }>>();
const listeners = new Set<() => void>();
let version = 0;
const changed = () => {
  version += 1;
  for (const l of listeners) l();
};

export function setReplyingMarks(conversationId: string, people: MailInboxPerson[]) {
  const m = new Map<string, { person: MailInboxPerson; until: number }>();
  for (const p of people) m.set(p.id, { person: p, until: Date.now() + MARK_MS });
  marks.set(conversationId, m);
  changed();
}

function replyingNow(conversationId: string, me: string | undefined): MailInboxPerson[] {
  const m = marks.get(conversationId);
  if (!m) return [];
  const now = Date.now();
  return [...m.values()].filter((x) => x.until > now && x.person.id !== me).map((x) => x.person);
}

/** People writing a reply in this conversation right now (not counting the caller). */
export function useReplying(conversationId: string, me: string | undefined) {
  useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      const timer = setInterval(changed, 5_000);
      return () => {
        listeners.delete(cb);
        clearInterval(timer);
      };
    },
    () => version,
  );
  return replyingNow(conversationId, me);
}

/** `mail.inbox.*` from the WebSocket. */
export function handleInboxEvent(client: QueryClient, e: MailInboxWsEvent): void {
  if (e.type === 'mail.inbox.replying') {
    const m = marks.get(e.conversationId) ?? new Map();
    if (e.active) m.set(e.user.id, { person: e.user, until: Date.now() + MARK_MS });
    else m.delete(e.user.id);
    marks.set(e.conversationId, m);
    changed();
    return;
  }
  void client.invalidateQueries({ queryKey: inboxKeys.list });
  void client.invalidateQueries({ queryKey: inboxKeys.conversations(e.inboxId) });
  void client.invalidateQueries({ queryKey: inboxKeys.tags(e.inboxId) });
  if (e.conversationId) {
    void client.invalidateQueries({
      queryKey: inboxKeys.conversationAll(e.inboxId, e.conversationId),
    });
  }
}
