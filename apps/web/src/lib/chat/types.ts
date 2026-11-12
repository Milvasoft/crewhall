import { type ResponseOf } from '@crewhall/shared';

/** Chat shapes from the contract (packages/shared/src/schemas/chat.ts), in one import spot. */
export type {
  AlertCard,
  AlertSeverity,
  ChatFile,
  ChatMember,
  Conversation,
  ConversationType,
  HistoryShare,
  IncomingWebhook,
  Message,
  MessageAttachment,
  MessagePage,
  MessagePreview,
  Notification,
  NotificationSource,
  NotifyLevel,
  Presence,
  PresenceState,
  QuotedMessage,
  ReactionSummary,
  StatusVisibility,
  SystemEvent,
  UserStatus,
  WsClientEvent,
  WsServerEvent,
} from '@crewhall/shared';

export type PinnedEntry = ResponseOf<'listPinnedMessages'>['items'][number];
export type UserCard = ResponseOf<'getChatUserCard'>;
export type SearchHit = ResponseOf<'searchMessages'>['items'][number];
export type Delivery = ResponseOf<'listWebhookDeliveries'>['items'][number];
export type ReadReceipt = ResponseOf<'listReadReceipts'>['items'][number];
export type NotificationCounts = ResponseOf<'getNotificationCounts'>;
export type ChatSettings = ResponseOf<'getChatSettings'>;
