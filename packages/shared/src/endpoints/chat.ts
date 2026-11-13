import { def, Empty, items, type EndpointDef } from '../endpoint-def';
import { page } from '../schemas/common';
import { DownloadUrl } from '../schemas/drive';
import {
  AddConversationMembers,
  AttachmentFolder,
  AttachmentUrlQuery,
  ChatFilesPage,
  ChatMember,
  UpdateConversationMember,
  ChatReminder,
  ChatSettings,
  CreateChatReminder,
  CreatePoll,
  GifPage,
  GifSearchQuery,
  GifSettings,
  GifTestResult,
  GifTrendingQuery,
  CreateScheduledMessage,
  ChatUserCard,
  Conversation,
  CreateConversation,
  CreateIncomingWebhook,
  ResolveChatRefs,
  ResolvedRefs,
  SearchChatRefsQuery,
  IncomingWebhook,
  IncomingWebhookSecret,
  LinkConversationSpace,
  ListConversationsQuery,
  ListMessagesQuery,
  ListNotificationsQuery,
  MarkRead,
  MarkUnread,
  Message,
  MessageInfo,
  MessagePage,
  MessageSearchHit,
  Notification,
  NotificationCounts,
  NotificationPrefs,
  PinnedMessage,
  Presence,
  PresenceQuery,
  PushDevice,
  ReactionInput,
  ReadReceipt,
  ReadResult,
  RegisterPushDevice,
  ReorderPinned,
  SearchMessagesQuery,
  SendMessage,
  UnregisterPushDevice,
  MutePushDevice,
  Unreads,
  UpdateChatSettings,
  UpdateGifSettings,
  UpdateConversation,
  UpdateIncomingWebhook,
  UpdateMessage,
  UpdateMyConversation,
  UpdateNotificationPrefs,
  UpdateNotifications,
  UpdateUserStatus,
  ScheduledMessage,
  UpdateScheduledMessage,
  UserStatus,
  VotePoll,
  WebhookDelivery,
  WsTicket,
} from '../schemas/chat';
import { PageQuery } from '../schemas/common';

/**
 * Chat module contract (design 04, 19.13-19.17; doc 17 §4, §6, §10).
 * Only the chat backend session edits this file; see docs/contracts/moduller.md.
 *
 * Writes go over HTTP; every change is also pushed over `/ws` (WsServerEvent in
 * schemas/chat). Outside this table: CHAT_RAW_PATHS in schemas/chat.
 */
export const chatEndpoints = {
  // ---- Realtime -----------------------------------------------------------------------
  /** One-time ticket for `/ws?ticket=`, valid 30 s (browsers can't set headers on WS). */
  createWsTicket: def({
    method: 'POST',
    path: '/api/v1/ws/ticket',
    auth: 'session',
    response: WsTicket,
  }),
  /** First call after a reconnect; then fetch open conversations with ?afterSeq=. */
  getUnreads: def({
    method: 'GET',
    path: '/api/v1/me/unreads',
    auth: 'session',
    response: Unreads,
  }),

  // ---- Conversations ------------------------------------------------------------------
  listConversations: def({
    method: 'GET',
    path: '/api/v1/chat/conversations',
    auth: 'session',
    query: ListConversationsQuery,
    response: page(Conversation),
  }),
  /**
   * Direct: returns the existing conversation if there is one. With `message` the first
   * message is sent in the same transaction (design 4.7: it exists from the first message).
   */
  createConversation: def({
    method: 'POST',
    path: '/api/v1/chat/conversations',
    auth: 'session',
    body: CreateConversation,
    response: Conversation,
  }),
  getConversation: def({
    method: 'GET',
    path: '/api/v1/chat/conversations/:conversationId',
    auth: 'session',
    response: Conversation,
  }),
  /** Rename (groups, space and alert conversations) or archive (space Owner/Admin). */
  updateConversation: def({
    method: 'PATCH',
    path: '/api/v1/chat/conversations/:conversationId',
    auth: 'session',
    body: UpdateConversation,
    response: Conversation,
  }),
  /** "Space'e bağla" (4.6): the group becomes a space conversation. */
  linkConversationSpace: def({
    method: 'POST',
    path: '/api/v1/chat/conversations/:conversationId/link-space',
    auth: 'session',
    body: LinkConversationSpace,
    response: Conversation,
  }),
  /** The caller's pin, notification level and mute for this conversation. */
  updateMyConversation: def({
    method: 'PATCH',
    path: '/api/v1/chat/conversations/:conversationId/me',
    auth: 'session',
    body: UpdateMyConversation,
    response: Conversation,
  }),
  /** Leave a group or alert conversation (space conversations follow the space). */
  leaveConversation: def({
    method: 'DELETE',
    path: '/api/v1/chat/conversations/:conversationId/me',
    auth: 'session',
    response: Empty,
  }),
  /**
   * "Benim için sil" (H19): the conversation leaves my list and its messages so far are
   * hidden from me only; a new message brings it back, clean. Not for space conversations.
   */
  clearConversation: def({
    method: 'POST',
    path: '/api/v1/chat/conversations/:conversationId/me/clear',
    auth: 'session',
    response: Empty,
  }),
  /**
   * "Herkes için sil" (H19): group owner or org admin (meeting chats: moderator or admin),
   * when the org allows it; messages and attachments go for everyone. 403
   * chat_delete_not_allowed / chat_delete_disabled; direct and space chats cannot be deleted.
   */
  deleteConversation: def({
    method: 'DELETE',
    path: '/api/v1/chat/conversations/:conversationId',
    auth: 'session',
    response: Empty,
  }),
  reorderPinnedConversations: def({
    method: 'PUT',
    path: '/api/v1/chat/pinned',
    auth: 'session',
    body: ReorderPinned,
    response: Empty,
  }),
  listConversationMembers: def({
    method: 'GET',
    path: '/api/v1/chat/conversations/:conversationId/members',
    auth: 'session',
    response: items(ChatMember),
  }),
  /**
   * Groups, alert conversations and private space channels (each added person must be in the
   * space); open space conversations take members from the space.
   */
  addConversationMembers: def({
    method: 'POST',
    path: '/api/v1/chat/conversations/:conversationId/members',
    auth: 'session',
    body: AddConversationMembers,
    response: items(ChatMember),
  }),
  removeConversationMember: def({
    method: 'DELETE',
    path: '/api/v1/chat/conversations/:conversationId/members/:userId',
    auth: 'session',
    response: Empty,
  }),
  /** Private channels: owner or member (channel owners and space admins; one owner stays). */
  updateConversationMember: def({
    method: 'PATCH',
    path: '/api/v1/chat/conversations/:conversationId/members/:userId',
    auth: 'session',
    body: UpdateConversationMember,
    response: items(ChatMember),
  }),
  /** Others' read positions ("Görüldü", avatars under the last read message). */
  listReadReceipts: def({
    method: 'GET',
    path: '/api/v1/chat/conversations/:conversationId/reads',
    auth: 'session',
    response: items(ReadReceipt),
  }),
  /** Forward only (GREATEST); other devices get a `read` event. */
  markConversationRead: def({
    method: 'POST',
    path: '/api/v1/chat/conversations/:conversationId/read',
    auth: 'session',
    body: MarkRead,
    response: ReadResult,
  }),
  markConversationUnread: def({
    method: 'POST',
    path: '/api/v1/chat/conversations/:conversationId/unread',
    auth: 'session',
    body: MarkUnread,
    response: ReadResult,
  }),

  // ---- Messages -----------------------------------------------------------------------
  listMessages: def({
    method: 'GET',
    path: '/api/v1/chat/conversations/:conversationId/messages',
    auth: 'session',
    query: ListMessagesQuery,
    response: MessagePage,
  }),
  /** Idempotent by clientMsgId; mentions come from `<@id>`, `<@all>`, `<@here>` tokens. */
  sendMessage: def({
    method: 'POST',
    path: '/api/v1/chat/conversations/:conversationId/messages',
    auth: 'session',
    body: SendMessage,
    response: Message,
  }),
  /** Own messages only. */
  updateMessage: def({
    method: 'PATCH',
    path: '/api/v1/chat/messages/:messageId',
    auth: 'session',
    body: UpdateMessage,
    response: Message,
  }),
  /** Own messages; space Admin and up also others'. Attachments go to the trash. */
  deleteMessage: def({
    method: 'DELETE',
    path: '/api/v1/chat/messages/:messageId',
    auth: 'session',
    response: Message,
  }),
  addReaction: def({
    method: 'POST',
    path: '/api/v1/chat/messages/:messageId/reactions',
    auth: 'session',
    body: ReactionInput,
    response: Message,
  }),
  removeReaction: def({
    method: 'POST',
    path: '/api/v1/chat/messages/:messageId/reactions/remove',
    auth: 'session',
    body: ReactionInput,
    response: Message,
  }),
  /** At most 50 per conversation; writes a system line (4.10). */
  /** "Mesaj bilgisi": only for the caller's own messages (403 otherwise). */
  getMessageInfo: def({
    method: 'GET',
    path: '/api/v1/chat/messages/:messageId/info',
    auth: 'session',
    response: MessageInfo,
  }),
  pinMessage: def({
    method: 'POST',
    path: '/api/v1/chat/messages/:messageId/pin',
    auth: 'session',
    response: Message,
  }),
  unpinMessage: def({
    method: 'DELETE',
    path: '/api/v1/chat/messages/:messageId/pin',
    auth: 'session',
    response: Message,
  }),
  /** Cards of internal references, per viewer, in the order asked. Never fails on one item. */
  resolveChatRefs: def({
    method: 'POST',
    path: '/api/v1/chat/refs/resolve',
    auth: 'session',
    body: ResolveChatRefs,
    response: ResolvedRefs,
  }),
  /** The `[[` picker of the composer: Drive items, pages, boards, drawings and cards. */
  searchChatRefs: def({
    method: 'GET',
    path: '/api/v1/chat/refs/search',
    auth: 'session',
    query: SearchChatRefsQuery,
    response: ResolvedRefs,
  }),
  /**
   * "Ben bakıyorum" on a webhook or integration card (members who can write). Taking it over
   * from someone else is allowed; everyone sees who is on it.
   */
  claimMessage: def({
    method: 'POST',
    path: '/api/v1/chat/messages/:messageId/claim',
    auth: 'session',
    response: Message,
  }),
  /** Let go: the one who took it, or a moderator. */
  unclaimMessage: def({
    method: 'DELETE',
    path: '/api/v1/chat/messages/:messageId/claim',
    auth: 'session',
    response: Message,
  }),
  /**
   * The author takes the link preview card off their message; it does not come back (also not
   * after an edit). Returns the message without `linkPreview`.
   */
  removeChatLinkPreview: def({
    method: 'DELETE',
    path: '/api/v1/chat/messages/:messageId/link-preview',
    auth: 'session',
    response: Message,
  }),
  listPinnedMessages: def({
    method: 'GET',
    path: '/api/v1/chat/conversations/:conversationId/pins',
    auth: 'session',
    response: items(PinnedMessage),
  }),
  /** Only conversations the caller can read, and only the history shared with them. */
  searchMessages: def({
    method: 'GET',
    path: '/api/v1/chat/search',
    auth: 'session',
    query: SearchMessagesQuery,
    response: page(MessageSearchHit),
  }),

  // ---- Slash commands (roadmap 23) --------------------------------------------------
  /** `/poll`: a poll message in the conversation (write permission). */
  createPoll: def({
    method: 'POST',
    path: '/api/v1/chat/conversations/:conversationId/polls',
    auth: 'session',
    body: CreatePoll,
    response: Message,
  }),
  /** Replaces the caller's votes; everyone sees the new counts (message.updated). */
  votePoll: def({
    method: 'POST',
    path: '/api/v1/chat/polls/:pollId/votes',
    auth: 'session',
    body: VotePoll,
    response: Message,
  }),
  /** Its author or a moderator; 409 conflict when already closed. */
  closePoll: def({
    method: 'POST',
    path: '/api/v1/chat/polls/:pollId/close',
    auth: 'session',
    response: Message,
  }),
  /** The caller's reminders still waiting, soonest first. */
  listChatReminders: def({
    method: 'GET',
    path: '/api/v1/chat/reminders',
    auth: 'session',
    response: items(ChatReminder),
  }),
  /** `/remind`: fired by the worker (chat.reminders, every minute) as a notification. */
  createChatReminder: def({
    method: 'POST',
    path: '/api/v1/chat/reminders',
    auth: 'session',
    body: CreateChatReminder,
    response: ChatReminder,
  }),
  deleteChatReminder: def({
    method: 'DELETE',
    path: '/api/v1/chat/reminders/:reminderId',
    auth: 'session',
    response: Empty,
  }),

  // ---- Scheduled messages ------------------------------------------------------------
  /** The caller's messages still waiting in this conversation, soonest first. */
  listScheduledMessages: def({
    method: 'GET',
    path: '/api/v1/chat/conversations/:conversationId/scheduled',
    auth: 'session',
    response: items(ScheduledMessage),
  }),
  /** Checked like sendMessage now and again when due (membership, write right). */
  createScheduledMessage: def({
    method: 'POST',
    path: '/api/v1/chat/conversations/:conversationId/scheduled',
    auth: 'session',
    body: CreateScheduledMessage,
    response: ScheduledMessage,
  }),
  updateScheduledMessage: def({
    method: 'PATCH',
    path: '/api/v1/chat/scheduled/:scheduledId',
    auth: 'session',
    body: UpdateScheduledMessage,
    response: ScheduledMessage,
  }),
  /** Cancels it (status cancelled). */
  deleteScheduledMessage: def({
    method: 'DELETE',
    path: '/api/v1/chat/scheduled/:scheduledId',
    auth: 'session',
    response: Empty,
  }),
  /** "Şimdi gönder": posts it at once and returns the message. */
  sendScheduledMessageNow: def({
    method: 'POST',
    path: '/api/v1/chat/scheduled/:scheduledId/send',
    auth: 'session',
    response: Message,
  }),

  // ---- GIF (GIPHY) ------------------------------------------------------------------
  /** GIPHY trending through the server (the org's key, rating and language). 409 gif_disabled. */
  trendingGifs: def({
    method: 'GET',
    path: '/api/v1/chat/gifs/trending',
    auth: 'session',
    query: GifTrendingQuery,
    response: GifPage,
  }),
  /** GIPHY search through the server; per-person rate limit, short result cache. */
  searchGifs: def({
    method: 'GET',
    path: '/api/v1/chat/gifs/search',
    auth: 'session',
    query: GifSearchQuery,
    response: GifPage,
  }),
  /** Yönetim › Entegrasyonlar › GIF (org.update_settings). */
  getGifSettings: def({
    method: 'GET',
    path: '/api/v1/org/gif',
    auth: 'session',
    response: GifSettings,
  }),
  updateGifSettings: def({
    method: 'PATCH',
    path: '/api/v1/org/gif',
    auth: 'session',
    body: UpdateGifSettings,
    response: GifSettings,
  }),
  /** One trending request with the stored key: is it working? */
  testGifSettings: def({
    method: 'POST',
    path: '/api/v1/org/gif/test',
    auth: 'session',
    response: GifTestResult,
  }),

  // ---- Attachments --------------------------------------------------------------------
  /**
   * Upload target for attachments (created on first use): Space › Ekler › <conversation>,
   * or the sender's Kişisel › Chat ekleri. Upload with createUpload, then send the node ids.
   */
  getChatAttachmentFolder: def({
    method: 'POST',
    path: '/api/v1/chat/conversations/:conversationId/attachment-folder',
    auth: 'session',
    response: AttachmentFolder,
  }),
  /** "Dosyalar" tab (4.9), newest first. */
  listChatFiles: def({
    method: 'GET',
    path: '/api/v1/chat/conversations/:conversationId/files',
    auth: 'session',
    query: PageQuery,
    response: ChatFilesPage,
  }),
  /**
   * Signed URL for an attachment, checked by conversation membership (the file may live in
   * the sender's personal space). 410 chat_attachment_removed when deleted in Drive.
   */
  getChatAttachmentUrl: def({
    method: 'GET',
    path: '/api/v1/chat/messages/:messageId/attachments/:nodeId',
    auth: 'session',
    query: AttachmentUrlQuery,
    response: DownloadUrl,
  }),

  // ---- People, presence, status -------------------------------------------------------
  getChatUserCard: def({
    method: 'GET',
    path: '/api/v1/chat/users/:userId',
    auth: 'session',
    response: ChatUserCard,
  }),
  /** Snapshot; changes then arrive as `presence` events for watched people. */
  getPresence: def({
    method: 'POST',
    path: '/api/v1/chat/presence',
    auth: 'session',
    body: PresenceQuery,
    response: items(Presence),
  }),
  getMyStatus: def({
    method: 'GET',
    path: '/api/v1/me/status',
    auth: 'session',
    response: UserStatus,
  }),
  updateMyStatus: def({
    method: 'PATCH',
    path: '/api/v1/me/status',
    auth: 'session',
    body: UpdateUserStatus,
    response: UserStatus,
  }),
  getChatSettings: def({
    method: 'GET',
    path: '/api/v1/me/chat-settings',
    auth: 'session',
    response: ChatSettings,
  }),
  updateChatSettings: def({
    method: 'PATCH',
    path: '/api/v1/me/chat-settings',
    auth: 'session',
    body: UpdateChatSettings,
    response: ChatSettings,
  }),

  // ---- Notifications ------------------------------------------------------------------
  listNotifications: def({
    method: 'GET',
    path: '/api/v1/notifications',
    auth: 'session',
    query: ListNotificationsQuery,
    response: page(Notification),
  }),
  getNotificationCounts: def({
    method: 'GET',
    path: '/api/v1/notifications/counts',
    auth: 'session',
    response: NotificationCounts,
  }),
  /** Read, unread, snooze, dismiss, restore; one or many rows (19.17). */
  updateNotifications: def({
    method: 'POST',
    path: '/api/v1/notifications/bulk',
    auth: 'session',
    body: UpdateNotifications,
    response: NotificationCounts,
  }),
  getNotificationPrefs: def({
    method: 'GET',
    path: '/api/v1/me/notification-prefs',
    auth: 'session',
    response: NotificationPrefs,
  }),
  updateNotificationPrefs: def({
    method: 'PATCH',
    path: '/api/v1/me/notification-prefs',
    auth: 'session',
    body: UpdateNotificationPrefs,
    response: NotificationPrefs,
  }),
  /** Mobile, after login and on token change; the same token moves to the new user. */
  registerPushDevice: def({
    method: 'POST',
    path: '/api/v1/me/push-devices',
    auth: 'session',
    body: RegisterPushDevice,
    response: PushDevice,
  }),
  /** "Bu cihazda bildirim alma": this device gets no push until mutedUntil (null: again). */
  mutePushDevice: def({
    method: 'POST',
    path: '/api/v1/me/push-devices/mute',
    auth: 'session',
    body: MutePushDevice,
    response: PushDevice,
  }),
  /** Mobile, on sign-out. */
  unregisterPushDevice: def({
    method: 'POST',
    path: '/api/v1/me/push-devices/unregister',
    auth: 'session',
    body: UnregisterPushDevice,
    response: Empty,
  }),
  listPushDevices: def({
    method: 'GET',
    path: '/api/v1/me/push-devices',
    auth: 'session',
    response: items(PushDevice),
  }),

  // ---- Incoming webhooks (4.11-4.14) --------------------------------------------------
  listIncomingWebhooks: def({
    method: 'GET',
    path: '/api/v1/chat/conversations/:conversationId/webhooks',
    auth: 'session',
    response: items(IncomingWebhook),
  }),
  /** The full URL is in this answer only (the server keeps a hash). */
  createIncomingWebhook: def({
    method: 'POST',
    path: '/api/v1/chat/conversations/:conversationId/webhooks',
    auth: 'session',
    body: CreateIncomingWebhook,
    response: IncomingWebhookSecret,
  }),
  updateIncomingWebhook: def({
    method: 'PATCH',
    path: '/api/v1/chat/webhooks/:webhookId',
    auth: 'session',
    body: UpdateIncomingWebhook,
    response: IncomingWebhook,
  }),
  deleteIncomingWebhook: def({
    method: 'DELETE',
    path: '/api/v1/chat/webhooks/:webhookId',
    auth: 'session',
    response: Empty,
  }),
  /** New key; the old URL stops working at once. */
  regenerateIncomingWebhookKey: def({
    method: 'POST',
    path: '/api/v1/chat/webhooks/:webhookId/regenerate',
    auth: 'session',
    response: IncomingWebhookSecret,
  }),
  /** Last 7 days, newest first (4.14). */
  listWebhookDeliveries: def({
    method: 'GET',
    path: '/api/v1/chat/webhooks/:webhookId/deliveries',
    auth: 'session',
    query: PageQuery,
    response: page(WebhookDelivery),
  }),
} as const satisfies Record<string, EndpointDef>;
