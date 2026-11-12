import { type QueryOf } from '@crewhall/shared';
import { queryOptions } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { type Conversation, type Message } from './types';

/** Query keys and options for chat; cache updates from the socket live in ./cache. */

export type NotificationListQuery = Omit<QueryOf<'listNotifications'>, 'cursor' | 'limit'>;
export type SearchQuery = Omit<QueryOf<'searchMessages'>, 'cursor' | 'limit'>;

export const chatKeys = {
  all: ['chat'] as const,
  conversations: ['chat', 'conversations'] as const,
  archived: ['chat', 'conversations', 'archived'] as const,
  conversation: (id: string) => ['chat', 'conversation', id] as const,
  messages: (id: string) => ['chat', 'messages', id] as const,
  members: (id: string) => ['chat', 'members', id] as const,
  reads: (id: string) => ['chat', 'reads', id] as const,
  pinned: (id: string) => ['chat', 'pinned', id] as const,
  files: (id: string) => ['chat', 'files', id] as const,
  webhooks: (id: string) => ['chat', 'webhooks', id] as const,
  deliveries: (webhookId: string) => ['chat', 'deliveries', webhookId] as const,
  search: (q: object) => ['chat', 'search', q] as const,
  userCard: (userId: string) => ['chat', 'users', userId] as const,
  settings: ['me', 'chat-settings'] as const,
  myStatus: ['me', 'status'] as const,
  notifications: ['notifications'] as const,
  notificationList: (q: NotificationListQuery) => ['notifications', 'list', q] as const,
  notificationCounts: ['notifications', 'counts'] as const,
  notificationPrefs: ['me', 'notification-prefs'] as const,
  unreads: ['me', 'unreads'] as const,
};

/**
 * Loaded messages of one chat, ascending by seq. The window normally ends at the newest
 * message; after a jump to an old message (search, pinned) `hasNewer` is true and live
 * messages wait until the person returns to the end.
 */
export interface MessageWindow {
  items: Message[];
  hasMore: boolean;
  hasNewer: boolean;
}

export const PAGE = 50;

export const conversationsQuery = queryOptions({
  queryKey: chatKeys.conversations,
  queryFn: async ({ signal }) => {
    const items: Conversation[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 5; i++) {
      const page = await api.call('listConversations', { query: { limit: 200, cursor }, signal });
      items.push(...page.items);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return items;
  },
  staleTime: 60_000,
});

/** "Arşiv" (H19): archived for everyone or by me; fetched when the filter is on. */
export const archivedConversationsQuery = queryOptions({
  queryKey: chatKeys.archived,
  queryFn: async ({ signal }) =>
    (await api.call('listConversations', { query: { limit: 200, archived: 'true' }, signal }))
      .items,
  staleTime: 30_000,
});

export const conversationQuery = (id: string) =>
  queryOptions({
    queryKey: chatKeys.conversation(id),
    queryFn: ({ signal }) =>
      api.call('getConversation', { params: { conversationId: id }, signal }),
    staleTime: 60_000,
  });

export const messagesQuery = (id: string) =>
  queryOptions({
    queryKey: chatKeys.messages(id),
    queryFn: async ({ signal }): Promise<MessageWindow> => {
      const page = await api.call('listMessages', {
        params: { conversationId: id },
        query: { limit: PAGE },
        signal,
      });
      return { items: page.items, hasMore: page.hasMoreBefore, hasNewer: false };
    },
    // The socket keeps it current; reconnects catch up with afterSeq and updatedAfter.
    staleTime: Infinity,
    gcTime: 10 * 60_000,
  });

export const membersQuery = (id: string) =>
  queryOptions({
    queryKey: chatKeys.members(id),
    queryFn: async ({ signal }) =>
      (await api.call('listConversationMembers', { params: { conversationId: id }, signal })).items,
    staleTime: 60_000,
  });

export const readsQuery = (id: string) =>
  queryOptions({
    queryKey: chatKeys.reads(id),
    queryFn: async ({ signal }) =>
      (await api.call('listReadReceipts', { params: { conversationId: id }, signal })).items,
    staleTime: Infinity,
  });

export const pinnedQuery = (id: string) =>
  queryOptions({
    queryKey: chatKeys.pinned(id),
    queryFn: async ({ signal }) =>
      (await api.call('listPinnedMessages', { params: { conversationId: id }, signal })).items,
  });

export const filesQuery = (id: string) =>
  queryOptions({
    queryKey: chatKeys.files(id),
    queryFn: ({ signal }) =>
      api.call('listChatFiles', { params: { conversationId: id }, query: { limit: 100 }, signal }),
  });

export const webhooksQuery = (id: string) =>
  queryOptions({
    queryKey: chatKeys.webhooks(id),
    queryFn: async ({ signal }) =>
      (await api.call('listIncomingWebhooks', { params: { conversationId: id }, signal })).items,
    refetchInterval: 30_000,
  });

export const deliveriesQuery = (webhookId: string) =>
  queryOptions({
    queryKey: chatKeys.deliveries(webhookId),
    queryFn: ({ signal }) =>
      api.call('listWebhookDeliveries', { params: { webhookId }, query: { limit: 100 }, signal }),
    refetchInterval: 15_000,
  });

export const searchQuery = (q: SearchQuery) =>
  queryOptions({
    queryKey: chatKeys.search(q),
    queryFn: ({ signal }) => api.call('searchMessages', { query: { ...q, limit: 50 }, signal }),
    enabled: q.q.trim().length > 0,
  });

export const userCardQuery = (userId: string) =>
  queryOptions({
    queryKey: chatKeys.userCard(userId),
    queryFn: ({ signal }) => api.call('getChatUserCard', { params: { userId }, signal }),
    staleTime: 60_000,
  });

export const chatSettingsQuery = queryOptions({
  queryKey: chatKeys.settings,
  queryFn: ({ signal }) => api.call('getChatSettings', { signal }),
  staleTime: 5 * 60_000,
});

export const myStatusQuery = queryOptions({
  queryKey: chatKeys.myStatus,
  queryFn: ({ signal }) => api.call('getMyStatus', { signal }),
  staleTime: 5 * 60_000,
});

export const notificationsQuery = (q: NotificationListQuery) =>
  queryOptions({
    queryKey: chatKeys.notificationList(q),
    queryFn: ({ signal }) => api.call('listNotifications', { query: { ...q, limit: 100 }, signal }),
    staleTime: 30_000,
  });

export const notificationCountsQuery = queryOptions({
  queryKey: chatKeys.notificationCounts,
  queryFn: ({ signal }) => api.call('getNotificationCounts', { signal }),
  staleTime: 30_000,
});

export const notificationPrefsQuery = queryOptions({
  queryKey: chatKeys.notificationPrefs,
  queryFn: ({ signal }) => api.call('getNotificationPrefs', { signal }),
});

/** Rail badge (conversations with unread messages); kept current by the socket. */
export const unreadsQuery = queryOptions({
  queryKey: chatKeys.unreads,
  queryFn: ({ signal }) => api.call('getUnreads', { signal }),
  staleTime: 60_000,
});
