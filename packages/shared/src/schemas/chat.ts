import { z } from 'zod';
import { BoardsWsEvent } from './boards';
import { TablesWsEvent } from './tables';
import { MailWsEvent } from './mail';
import { MailInboxWsEvent } from './mail-inbox';
import { MeetWsEvent } from './meet';
import { Id, Timestamp } from './common';
import { ConversationFederation, RemoteUser } from './federation';
import { Disposition, PreviewKind, PreviewState } from './drive';
import { OrgRole, UserSummary } from './org';
import { LinkHealth, SurfaceChangedEvent } from './quick';
import { SpaceColor, SpaceRole } from './space';

/**
 * Chat, presence and notifications (design 04, 19.13-19.17; doc 17 §4, §6, §10).
 * Writes go over HTTP, reads come over the WebSocket (`/ws`, events at the bottom).
 */

/** Routes outside the endpoint table: the WebSocket and incoming webhooks (POST ?key=). */
export const CHAT_RAW_PATHS = {
  ws: '/ws',
  incomingHook: '/api/hooks/:webhookId',
} as const;

// ---- Limits ---------------------------------------------------------------------------

export const CHAT_LIMITS = {
  messageChars: 8000,
  attachmentsPerMessage: 10,
  /** Group conversations: 3-50 people (design 4.6). */
  groupMembers: 50,
  /** Private space channels (Teams-like): people added by hand, each also in the space. */
  privateChannelMembers: 250,
  pinnedMessages: 50,
  pinnedConversations: 15,
  /** @all asks for confirmation from this many members on (design 4.4). */
  mentionAllConfirmMembers: 20,
  /** "12 kişi gördü" instead of avatars above this size (design 04 rules). */
  readAvatarsMax: 20,
  typingSeconds: 3,
  heartbeatSeconds: 25,
  wsTicketSeconds: 30,
  webhookPerMinute: 60,
  webhookBodyBytes: 32 * 1024,
} as const;

// ---- Conversations --------------------------------------------------------------------

/** `alert` gathers incoming webhook messages; `meeting` and `card` are opened by their modules. */
export const ConversationType = z.enum(['direct', 'group', 'space', 'meeting', 'alert', 'card']);
export type ConversationType = z.infer<typeof ConversationType>;

/** Per-member notification level; `critical` only matters in alert conversations. */
export const NotifyLevel = z.enum(['all', 'critical', 'mentions', 'none']);
export type NotifyLevel = z.infer<typeof NotifyLevel>;

export const MessageKind = z.enum(['user', 'webhook', 'system']);
export type MessageKind = z.infer<typeof MessageKind>;

/** Last message line in the conversation list. */
export const MessagePreview = z.object({
  seq: z.number().int(),
  kind: MessageKind,
  authorId: Id.nullable(),
  /** Author's or webhook's name; null for system lines. */
  authorName: z.string().nullable(),
  /** Plain text, mentions as names, at most 200 characters; null when deleted. */
  excerpt: z.string().nullable(),
  hasAttachments: z.boolean(),
  deleted: z.boolean(),
  createdAt: Timestamp,
});
export type MessagePreview = z.infer<typeof MessagePreview>;

/** The caller's own row in conversation_members and read_states. */
export const MyConversationState = z.object({
  /** Pinned conversations sort by `pinPosition` above the rest (at most 15). */
  pinnedAt: Timestamp.nullable(),
  pinPosition: z.number().int().nullable(),
  notify: NotifyLevel,
  mutedUntil: Timestamp.nullable(),
  lastReadSeq: z.number().int(),
  unread: z.number().int(),
  unreadMentions: z.number().int(),
  /** "Okunmadı olarak işaretle" is on: counted as unread until a message is read again. */
  markedUnread: z.boolean().optional(),
  /** Messages before this seq are not shared with the caller (added without history). */
  historyFromSeq: z.number().int().nullable(),
  /** Personal archive (H19): out of the list, back from the "Arşiv" filter; null = not archived. */
  archivedAt: Timestamp.nullable().optional(),
  /** "Benim için sil": messages up to this seq are hidden from the caller only. */
  clearedAtSeq: z.number().int().nullable().optional(),
});
export type MyConversationState = z.infer<typeof MyConversationState>;

/** What the caller may do here; the server checks again on every request. */
export const ConversationPermissions = z.object({
  write: z.boolean(),
  /** Rename, add or remove people, link to a space. */
  manage: z.boolean(),
  pin: z.boolean(),
  /** Delete other people's messages (space Admin and up). */
  moderate: z.boolean(),
  manageWebhooks: z.boolean(),
  archive: z.boolean(),
  /** "Benim için sil" (H19): everyone except in space conversations. */
  clearForMe: z.boolean().optional(),
  /**
   * "Herkes için sil" (H19): group owner or org admin (meeting chats: moderator or admin),
   * while the org allows it; never in direct or space conversations.
   */
  deleteForEveryone: z.boolean().optional(),
  /**
   * Space channels: make it private or open it to the whole space (private channels: their
   * owners; open ones: whoever opened it; both: the space's admins). Absent from older servers.
   */
  changePrivacy: z.boolean().optional(),
});

export const Conversation = z.object({
  id: Id,
  type: ConversationType,
  /** Set for space conversations (membership follows the space) and space-bound alert ones. */
  spaceId: Id.nullable(),
  spaceName: z.string().nullable(),
  spaceColor: SpaceColor.nullable(),
  meetingId: Id.nullable(),
  /** The stored name; null for direct and unnamed groups. */
  name: z.string().nullable(),
  /** Channel emoji (group, space, alert chats); null shows the letter or icon placeholder. */
  emoji: z.string().nullable().optional(),
  /**
   * Space channels (and space-bound alert ones): true when only the people added see it
   * (members are listed and managed like a group's, each must be in the space); false when
   * the whole space sees it. Absent for other conversations and from older servers.
   */
  private: z.boolean().optional(),
  /** Display title: the name, the other person (direct) or members' first names ("Selin, Can"). */
  title: z.string(),
  avatarUrl: z.url().nullable(),
  /** The other person in a direct conversation. */
  peer: UserSummary.nullable(),
  memberCount: z.number().int(),
  lastSeq: z.number().int(),
  lastMessageAt: Timestamp.nullable(),
  lastMessage: MessagePreview.nullable(),
  /** Drive folder holding this conversation's attachments ("Ekler"), when one exists. */
  attachmentsNodeId: Id.nullable(),
  hasWebhooks: z.boolean(),
  archivedAt: Timestamp.nullable(),
  createdBy: Id.nullable(),
  createdAt: Timestamp,
  my: MyConversationState,
  permissions: ConversationPermissions,
  /** Shared with other installations (federation); absent for local conversations. */
  federation: ConversationFederation.nullable().optional(),
});
export type Conversation = z.infer<typeof Conversation>;

export const ConversationFilter = z.enum(['unread', 'direct', 'group', 'space', 'meeting']);

/** Pinned first (by position), then by last message, newest first. */
export const ListConversationsQuery = z.object({
  filter: ConversationFilter.optional(),
  /** Title search (sidebar filter). */
  q: z.string().max(100).optional(),
  archived: z.stringbool().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export const ChatMember = z.object({
  user: UserSummary,
  isGuest: z.boolean(),
  /** Space conversations: the space role; elsewhere null (every member is equal). */
  spaceRole: SpaceRole.nullable(),
  joinedAt: Timestamp,
  /** Private channels: owners add and remove people; absent elsewhere. */
  role: z.enum(['owner', 'member']).optional(),
});
export type ChatMember = z.infer<typeof ChatMember>;

export const ChatMemberRole = z.enum(['owner', 'member']);
export type ChatMemberRole = z.infer<typeof ChatMemberRole>;

/** Private channels: make someone an owner or a plain member (owners and space admins). */
export const UpdateConversationMember = z.object({ role: ChatMemberRole });

/** How much history a person added to a group sees (design 4.8, default 7 days). */
export const HistoryShare = z.enum(['none', 'days7', 'days30', 'all']);
export type HistoryShare = z.infer<typeof HistoryShare>;

export const AddConversationMembers = z.object({
  userIds: z.array(Id).min(1).max(CHAT_LIMITS.groupMembers),
  history: HistoryShare.default('days7'),
});

// ---- Message content ------------------------------------------------------------------

export const AlertSeverity = z.enum(['critical', 'warning', 'success', 'info']);
export type AlertSeverity = z.infer<typeof AlertSeverity>;

/**
 * Card of a webhook message (Crewhall format). Google Chat cardsV2 bodies are converted to
 * this; widgets without an equivalent become text fields.
 */
export const AlertCard = z.object({
  severity: AlertSeverity.default('info'),
  title: z.string().max(300),
  subtitle: z.string().max(300).nullish(),
  /** Source app shown with the bot badge ("Seq", "Uptime Kuma"). */
  source: z.string().max(100).nullish(),
  iconUrl: z.url().nullish(),
  text: z.string().max(4000).nullish(),
  fields: z
    .array(z.object({ label: z.string().max(100), value: z.string().max(1000) }))
    .max(20)
    .default([]),
  buttons: z
    .array(z.object({ text: z.string().max(80), url: z.url() }))
    .max(5)
    .default([]),
});
export type AlertCard = z.infer<typeof AlertCard>;

/** Lines the server writes into the flow; clients render them from i18n by `type`. */
export const SystemEvent = z.object({
  type: z.enum([
    'created',
    'renamed',
    'members_added',
    'member_removed',
    'member_left',
    'linked_space',
    'message_pinned',
    'webhook_added',
    'archived',
    'unarchived',
    // Written by the meet module (design 13.12).
    'meeting_started',
    'meeting_ended',
    'recording_started',
    'recording_ready',
    // Calls (H7): nobody answered (missed, declined, cancelled) / a call that took place.
    'call_missed',
    'call_ended',
    // A space channel made private (people added by hand) or opened to the whole space.
    'made_private',
    'made_open',
  ]),
  actorId: Id.nullable(),
  userIds: z.array(Id).optional(),
  name: z.string().optional(),
  messageId: Id.optional(),
  /** Meeting lines: the meeting, the recording's Drive file, how long it lasted. */
  meetingId: Id.optional(),
  nodeId: Id.optional(),
  durationSeconds: z.number().int().nonnegative().optional(),
  /** Call lines: a video call (otherwise voice). */
  video: z.boolean().optional(),
  /**
   * `call_missed` lines: why nobody answered. Declined ("Reddet"), busy ("Meşgulüm" or already in a
   * call), cancelled by the caller, or not answered in time. Missing on older lines: missed.
   */
  callOutcome: z.enum(['missed', 'declined', 'busy', 'cancelled']).optional(),
});
export type SystemEvent = z.infer<typeof SystemEvent>;

export const MentionKind = z.enum(['user', 'all', 'here']);

/**
 * Mentions are written into `text` as tokens: `<@userId>`, `<@all>`, `<@here>`. The server
 * resolves them and returns the list; clients render tokens as yellow tags.
 */
export const Mention = z.object({
  kind: MentionKind,
  userId: Id.nullable(),
});

export const MessageAttachment = z.object({
  nodeId: Id,
  name: z.string(),
  mime: z.string().nullable(),
  sizeBytes: z.number().int(),
  preview: PreviewState,
  /** The node was deleted in Drive: "Dosya kaldırıldı" (design 4.9). */
  removed: z.boolean(),
});
export type MessageAttachment = z.infer<typeof MessageAttachment>;

export const QuotedMessage = z.object({
  id: Id,
  seq: z.number().int(),
  author: UserSummary.nullable(),
  webhookName: z.string().nullable(),
  /** The original was written by a meeting guest, who has no account (Message.guestAuthor). */
  guestAuthor: z.object({ name: z.string() }).nullable().optional(),
  /** Shortened plain text; null when the original was deleted ("Bu mesaj silindi"). */
  excerpt: z.string().nullable(),
  hasAttachments: z.boolean(),
  deleted: z.boolean(),
});
export type QuotedMessage = z.infer<typeof QuotedMessage>;

export const ReactionSummary = z.object({
  emoji: z.string(),
  count: z.number().int(),
  /** First 20 who reacted, for the tooltip. */
  userIds: z.array(Id),
  mine: z.boolean(),
  /** Names of people on other installations who reacted (federation; first 20). */
  remoteNames: z.array(z.string()).optional(),
});
export type ReactionSummary = z.infer<typeof ReactionSummary>;

export const MessageVia = z.object({
  /** `plugin`: a plugin command or tool posted it for the person (roadmap: plugins). */
  kind: z.enum(['mcp', 'api', 'plugin']),
  /** Client, token or plugin name, e.g. "Claude Code · Dizüstü". */
  client: z.string(),
});
export type MessageVia = z.infer<typeof MessageVia>;

// ---- GIF (GIPHY) ----------------------------------------------------------------------

/** GIF images may only come from GIPHY's media CDN (https://media*.giphy.com/...). */
export const GIPHY_MEDIA_HOST = /^media\d*\.giphy\.com$/;

export function isGiphyMediaUrl(url: string): boolean {
  // No URL global in this package: the scheme, host and path checked by pattern, no userinfo.
  const m = /^https:\/\/([^/?#@:]+)(\/[^\s@]*)?$/.exec(url);
  return m !== null && GIPHY_MEDIA_HOST.test(m[1]!.toLowerCase());
}

/** A GIF in a message; the image loads from GIPHY's CDN (nothing is copied to Drive). */
export const MessageGif = z.object({
  provider: z.literal('giphy'),
  id: z.string().min(1).max(64),
  /** Shown in the message (GIPHY "downsized"/"original"), media*.giphy.com only. */
  url: z.url().max(500),
  /** A still or small preview for reduced motion and lists, when GIPHY gave one. */
  previewUrl: z.url().max(500).nullable().optional(),
  width: z.number().int().min(1).max(4000),
  height: z.number().int().min(1).max(4000),
  title: z.string().max(200).default(''),
});
export type MessageGif = z.infer<typeof MessageGif>;

export const GifRating = z.enum(['g', 'pg', 'pg-13', 'r']);
export type GifRating = z.infer<typeof GifRating>;

/** One search or trending result, already reduced to what clients need. */
export const GifResult = z.object({
  id: z.string(),
  title: z.string(),
  /** Grid preview (fixed_width): small and quick. */
  previewUrl: z.url(),
  previewWidth: z.number().int(),
  previewHeight: z.number().int(),
  /** Sent in the message (downsized or original). */
  url: z.url(),
  width: z.number().int(),
  height: z.number().int(),
  /** A still frame for reduced motion, when present. */
  stillUrl: z.url().nullable(),
});
export type GifResult = z.infer<typeof GifResult>;

export const GIF_LIMITS = { pageSize: 25, maxLimit: 50, queryChars: 50, minQuery: 2 } as const;

/** GIPHY keys: a beta key allows about 100 requests an hour; production keys far more. */
export const GifKeyTier = z.enum(['beta', 'production']);
export type GifKeyTier = z.infer<typeof GifKeyTier>;
/** GIPHY calls an org may make in an hour with a beta key (cached results are free). */
export const GIF_BUDGET = { beta: 90 } as const;

export const GifTrendingQuery = z.object({
  offset: z.coerce.number().int().min(0).max(4999).default(0),
  limit: z.coerce.number().int().min(1).max(GIF_LIMITS.maxLimit).default(GIF_LIMITS.pageSize),
});
export const GifSearchQuery = GifTrendingQuery.extend({
  q: z.string().trim().min(GIF_LIMITS.minQuery).max(GIF_LIMITS.queryChars),
});

/** `nextOffset` null: no more results. */
export const GifPage = z.object({
  items: z.array(GifResult),
  nextOffset: z.number().int().nullable(),
});
export type GifPage = z.infer<typeof GifPage>;

/** Yönetim › Entegrasyonlar › GIF (GIPHY): the org's own GIPHY key (never read back). */
export const GifSettings = z.object({
  enabled: z.boolean(),
  apiKey: z.object({
    set: z.boolean(),
    hint: z.string().nullable(),
    updatedAt: Timestamp.nullable(),
  }),
  rating: GifRating,
  /** GIPHY language code (tr, en, …) for searches. */
  lang: z.string(),
  /** Enabled and a key is set: GIFs work in chat. */
  active: z.boolean(),
  /** Beta keys get an hourly budget of GIPHY calls (GIF_BUDGET.beta); production none. */
  keyTier: GifKeyTier,
  /** GIPHY calls this hour (cached results are free) and the limit (null: no limit). */
  usage: z.object({
    used: z.number().int(),
    limit: z.number().int().nullable(),
    resetsAt: Timestamp,
  }),
});
export type GifSettings = z.infer<typeof GifSettings>;

export const UpdateGifSettings = z.object({
  enabled: z.boolean().optional(),
  /** null removes the key. */
  apiKey: z.string().trim().min(10).max(200).nullable().optional(),
  rating: GifRating.optional(),
  lang: z
    .string()
    .regex(/^[a-z]{2}(-[A-Z]{2})?$/)
    .optional(),
  keyTier: GifKeyTier.optional(),
});
export type UpdateGifSettings = z.infer<typeof UpdateGifSettings>;

/** "Test": one trending request with the stored key. */
export const GifTestResult = z.object({
  ok: z.boolean(),
  count: z.number().int(),
  /** GIPHY's status (401/403: wrong key, 429: quota) or a network error. */
  error: z.string().nullable(),
});
export type GifTestResult = z.infer<typeof GifTestResult>;

// ---- Slash commands (roadmap 23) ------------------------------------------------------

export const POLL_LIMITS = {
  questionChars: 300,
  optionChars: 200,
  minOptions: 2,
  maxOptions: 10,
} as const;

export const PollOption = z.object({
  index: z.number().int(),
  text: z.string(),
  count: z.number().int(),
  /** Everyone who chose it (polls are not anonymous); clients derive "mine" from it. */
  userIds: z.array(Id),
});
export type PollOption = z.infer<typeof PollOption>;

export const Poll = z.object({
  id: Id,
  question: z.string(),
  options: z.array(PollOption),
  /** Several options per person; otherwise one. */
  multiple: z.boolean(),
  /** Closed by its author (or a moderator): no more votes, results stay. */
  closedAt: Timestamp.nullable(),
  voterCount: z.number().int(),
  createdBy: Id.nullable(),
});
export type Poll = z.infer<typeof Poll>;

/**
 * Internal reference ("şuna bak"): a message points at a Drive item, page, board, drawing or
 * card without a public link or a share. The message holds only ids (events carry one shared
 * view of it); `resolveChatRefs` answers per viewer, so a title never reaches someone who may
 * not see the item.
 */
export const MESSAGE_REF_LIMITS = { perMessage: 5, resolveBatch: 50, searchResults: 12 } as const;
export const MessageRefKind = z.enum(['node', 'card']);
export type MessageRefKind = z.infer<typeof MessageRefKind>;
export const MessageRef = z.object({ kind: MessageRefKind, id: Id });
export type MessageRef = z.infer<typeof MessageRef>;

export const RefItemType = z.enum(['folder', 'file', 'page', 'board', 'drawing', 'card']);
export type RefItemType = z.infer<typeof RefItemType>;

/**
 * `no_access`: the viewer may not see it; nothing about it is told, not even its type.
 * `deleted`: in the trash or gone, told only to people who could see it (or when no row is left).
 */
export const RefState = z.enum(['ok', 'no_access', 'deleted']);
export type RefState = z.infer<typeof RefState>;

export const ResolvedRef = z.object({
  kind: MessageRefKind,
  id: Id,
  state: RefState,
  /** Only with `ok`. */
  item: z
    .object({
      type: RefItemType,
      title: z.string(),
      /** In-app address (paths.ts); web and desktop go there, mobile maps it to its screens. */
      path: z.string(),
      mime: z.string().nullable(),
      /** The space it lives in. */
      spaceName: z.string().nullable(),
    })
    .nullable(),
});
export type ResolvedRef = z.infer<typeof ResolvedRef>;

export const ResolveChatRefs = z.object({
  refs: z.array(MessageRef).min(1).max(MESSAGE_REF_LIMITS.resolveBatch),
});
export const ResolvedRefs = z.object({ items: z.array(ResolvedRef) });
export type ResolvedRefs = z.infer<typeof ResolvedRefs>;

/** Only what the caller can see; an empty `q` lists what they opened recently. */
export const SearchChatRefsQuery = z.object({
  q: z.string().trim().max(200).default(''),
  limit: z.coerce.number().int().min(1).max(MESSAGE_REF_LIMITS.searchResults).default(8),
});

/**
 * Preview card of the first external address in a message (kararlar.md 2026-11-13): read by
 * the worker after sending, never blocking it. `imageUrl` is https only; clients load it
 * without a referrer.
 */
export const MessageLinkPreview = z.object({
  url: z.string().max(2000),
  title: z.string().max(200).nullable(),
  description: z.string().max(400).nullable(),
  siteName: z.string().max(100).nullable(),
  imageUrl: z.string().max(2000).nullable(),
});
export type MessageLinkPreview = z.infer<typeof MessageLinkPreview>;

export const Message = z.object({
  id: Id,
  conversationId: Id,
  /** Strictly increasing per conversation; a gap means missed messages (fetch ?afterSeq=). */
  seq: z.number().int(),
  kind: MessageKind,
  author: UserSummary.nullable(),
  webhook: z.object({ id: Id, name: z.string(), avatarUrl: z.url().nullable() }).nullable(),
  /** With mention tokens; empty when deleted. */
  text: z.string(),
  mentions: z.array(Mention),
  card: AlertCard.nullable(),
  system: SystemEvent.nullable(),
  /**
   * Sent on the author's behalf by an MCP client or an API token (doc 17 §13): the UI marks
   * it "Claude ile · <client>". The author is still the person.
   */
  via: MessageVia.nullable().optional(),
  /** Written by a person on another installation (federation); `author` is then null. */
  remoteAuthor: RemoteUser.nullable().optional(),
  /** Written by a meeting guest, who has no account; `author` is then null. */
  guestAuthor: z.object({ name: z.string() }).nullable().optional(),
  /**
   * Posted by an automation rule (roadmap 17): `author` is null, `webhook` carries the rule's
   * name for older clients; the UI shows the "Otomasyon" bot with the rule name under it.
   */
  automation: z.object({ ruleId: Id, ruleName: z.string() }).nullable().optional(),
  /** `/me`: an action line ("* Ayşe kahve almaya gitti"); `text` is the action. */
  emote: z.boolean().optional(),
  /**
   * `/whisper`: only the author and this person see it (others never receive it: their
   * seqs simply skip it).
   */
  whisperTo: UserSummary.nullable().optional(),
  /** `/poll`: the poll this message carries (`text` is its question). */
  poll: Poll.nullable().optional(),
  /** A GIF from GIPHY (the org's key); `text` may be empty. */
  gif: MessageGif.nullable().optional(),
  /** Internal references, ids only: cards come from `resolveChatRefs`; `text` may be empty. */
  refs: z.array(MessageRef).optional(),
  /**
   * Preview card of the first external link; null or absent while there is none, while it is
   * being read, or after the author removed it (removeChatLinkPreview).
   */
  linkPreview: MessageLinkPreview.nullable().optional(),
  /** "Ben bakıyorum" on a webhook card: who took it and when. */
  claim: z.object({ user: UserSummary, at: Timestamp }).nullable().optional(),
  /**
   * A webhook's text without a card: the severity its webhook gives it ("Kartsız mesajın
   * önemi"). Null or absent: read from the text (messageSeverity).
   */
  severity: AlertSeverity.nullable().optional(),
  attachments: z.array(MessageAttachment),
  replyTo: QuotedMessage.nullable(),
  reactions: z.array(ReactionSummary),
  clientMsgId: Id.nullable(),
  pinnedAt: Timestamp.nullable(),
  editedAt: Timestamp.nullable(),
  deletedAt: Timestamp.nullable(),
  createdAt: Timestamp,
  /** Changes on edit, delete, reaction and pin; drives `?updatedAfter=` catch-up. */
  updatedAt: Timestamp,
});
export type Message = z.infer<typeof Message>;

export const SendMessage = z.object({
  /** Client-generated; resending the same id returns the first message (no duplicates). */
  clientMsgId: Id,
  text: z.string().max(CHAT_LIMITS.messageChars).default(''),
  replyToId: Id.optional(),
  /** Files already uploaded into the folder from `getChatAttachmentFolder`. */
  attachmentNodeIds: z.array(Id).max(CHAT_LIMITS.attachmentsPerMessage).default([]),
  /** Needed for `<@all>`/`<@here>` from 20 members on, else 409 chat_mention_all_confirm. */
  confirmMentionAll: z.boolean().optional(),
  /** Send anyway after 409 dlp_warning (a DLP rule asked for confirmation). */
  dlpAck: z.boolean().optional(),
  /** `/me`: send as an action line. */
  emote: z.boolean().optional(),
  /** `/whisper`: only this member (and the author) sees it; no attachments, no @all. */
  whisperTo: Id.optional(),
  /** A GIF picked from searchGifs/trendingGifs (media*.giphy.com only, GIFs on for the org). */
  gif: MessageGif.optional(),
  /**
   * Internal references; the sender must be able to see each (else 403 chat_ref_no_access).
   * Not in chats shared with another installation, whose people could not open them.
   */
  refs: z.array(MessageRef).max(MESSAGE_REF_LIMITS.perMessage).optional(),
});
export type SendMessage = z.infer<typeof SendMessage>;

const pollText = (max: number) => z.string().trim().min(1).max(max);

/** `/poll`: posts a poll message (idempotent by clientMsgId like sendMessage). */
export const CreatePoll = z.object({
  clientMsgId: Id,
  question: pollText(POLL_LIMITS.questionChars),
  options: z
    .array(pollText(POLL_LIMITS.optionChars))
    .min(POLL_LIMITS.minOptions)
    .max(POLL_LIMITS.maxOptions),
  multiple: z.boolean().default(false),
});
export type CreatePoll = z.infer<typeof CreatePoll>;

/** The caller's whole choice (replaces earlier votes); empty takes the vote back. */
export const VotePoll = z.object({
  options: z
    .array(
      z
        .number()
        .int()
        .min(0)
        .max(POLL_LIMITS.maxOptions - 1),
    )
    .max(POLL_LIMITS.maxOptions),
});
export type VotePoll = z.infer<typeof VotePoll>;

export const REMINDER_LIMITS = { textChars: 500, maxDays: 365, pending: 100 } as const;

/** `/remind`: a notification (bell, push, e-mail per preferences) to its owner at `remindAt`. */
export const ChatReminder = z.object({
  id: Id,
  conversationId: Id,
  text: z.string(),
  remindAt: Timestamp,
  firedAt: Timestamp.nullable(),
  createdAt: Timestamp,
});
export type ChatReminder = z.infer<typeof ChatReminder>;

/** The client parses "15dk toplantı" / "yarın 9:00 …" (parseReminder) and sends the time. */
export const CreateChatReminder = z.object({
  text: z.string().trim().max(REMINDER_LIMITS.textChars).default(''),
  remindAt: Timestamp,
  /** The conversation it was set in; the notification opens it (member only). */
  conversationId: Id,
});
export type CreateChatReminder = z.infer<typeof CreateChatReminder>;

// ---- Scheduled messages ("Daha sonra gönder", /zamanla) --------------------------------

export const SCHEDULE_LIMITS = { pending: 100, maxDays: 365 } as const;

export const ScheduledMessageStatus = z.enum(['scheduled', 'sent', 'cancelled', 'failed']);
export type ScheduledMessageStatus = z.infer<typeof ScheduledMessageStatus>;

/** A message the caller wrote to go out later; posted then as a normal message. */
export const ScheduledMessage = z.object({
  id: Id,
  conversationId: Id,
  /** With mention tokens, like Message.text. */
  text: z.string(),
  replyToId: Id.nullable(),
  attachments: z.array(MessageAttachment),
  refs: z.array(MessageRef).optional(),
  sendAt: Timestamp,
  status: ScheduledMessageStatus,
  /** Why it was not sent (failed): not_member, not_allowed, … */
  error: z.string().nullable(),
  /** The message it became (sent). */
  messageId: Id.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type ScheduledMessage = z.infer<typeof ScheduledMessage>;

/** Same fields as SendMessage plus the time; at most a year ahead, 100 waiting per person. */
export const CreateScheduledMessage = z.object({
  text: z.string().max(CHAT_LIMITS.messageChars).default(''),
  replyToId: Id.optional(),
  attachmentNodeIds: z.array(Id).max(CHAT_LIMITS.attachmentsPerMessage).default([]),
  refs: z.array(MessageRef).max(MESSAGE_REF_LIMITS.perMessage).optional(),
  confirmMentionAll: z.boolean().optional(),
  sendAt: Timestamp,
});
export type CreateScheduledMessage = z.infer<typeof CreateScheduledMessage>;

/** Only while it is still scheduled. */
export const UpdateScheduledMessage = z.object({
  text: z.string().max(CHAT_LIMITS.messageChars).optional(),
  sendAt: Timestamp.optional(),
});
export type UpdateScheduledMessage = z.infer<typeof UpdateScheduledMessage>;

export const UpdateMessage = z.object({
  text: z.string().min(1).max(CHAT_LIMITS.messageChars),
  /** Save anyway after 409 dlp_warning. */
  dlpAck: z.boolean().optional(),
});

export const ReactionInput = z.object({ emoji: z.string().min(1).max(32) });

/** One emoji per reaction, ZWJ sequences and skin tones included (S1). */
export const REACTION_MAX_CODE_POINTS = 10;
const EMOJI = /\p{Extended_Pictographic}|\p{Emoji_Presentation}|\p{Regional_Indicator}/u;
const EMOJI_PART =
  /^(?:\p{Extended_Pictographic}|\p{Emoji_Presentation}|\p{Emoji_Modifier}|\p{Emoji_Component})$/u;
const KEYCAP = /^[0-9#*]\uFE0F?\u20E3$/u;
const graphemes =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;

/**
 * Is `s` a single emoji grapheme? Adding any other reaction answers 400
 * `chat_invalid_reaction` (checked by the server; clients may use it to filter input).
 */
export function isReactionEmoji(s: string): boolean {
  const points = [...s];
  if (points.length === 0 || points.length > REACTION_MAX_CODE_POINTS) return false;
  if (graphemes && [...graphemes.segment(s)].length !== 1) return false;
  if (KEYCAP.test(s)) return true;
  return EMOJI.test(s) && points.every((p) => EMOJI_PART.test(p));
}

/**
 * One mode per call: `afterSeq` (catch-up, ascending), `beforeSeq` (scroll back),
 * `aroundSeq` (jump to a message) or `updatedAfter` (edits/deletes/reactions since then).
 * No mode: the latest page. Items are always in ascending seq.
 */
export const ListMessagesQuery = z.object({
  afterSeq: z.coerce.number().int().min(0).optional(),
  beforeSeq: z.coerce.number().int().min(1).optional(),
  aroundSeq: z.coerce.number().int().min(1).optional(),
  updatedAfter: Timestamp.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const MessagePage = z.object({
  items: z.array(Message),
  hasMoreBefore: z.boolean(),
  hasMoreAfter: z.boolean(),
  lastSeq: z.number().int(),
});
export type MessagePage = z.infer<typeof MessagePage>;

// ---- Read state -----------------------------------------------------------------------

/** The client sends the largest visible seq after a 1 s pause; the server only moves forward. */
export const MarkRead = z.object({ seq: z.number().int().min(0) });
/** "Okunmadı olarak işaretle": unread from this message on (may move backwards). */
export const MarkUnread = z.object({ fromSeq: z.number().int().min(1) });

export const ReadResult = z.object({
  conversationId: Id,
  lastReadSeq: z.number().int(),
  unread: z.number().int(),
  unreadMentions: z.number().int(),
});
export type ReadResult = z.infer<typeof ReadResult>;

/** "Mesaj bilgisi" (own messages only): who saw it and first when, who has not yet. */
export const MessageInfo = z.object({
  messageId: Id,
  /** People it was for (not the author; not people added later without that history). */
  total: z.number().int(),
  seenCount: z.number().int(),
  /** Newest first; `at` null when they saw it before the first time was recorded. */
  seen: z.array(z.object({ user: UserSummary, at: Timestamp.nullable() })),
  /** Everyone is listed: the read receipts setting does not hide anyone here (user decision). */
  notSeen: z.array(UserSummary),
});
export type MessageInfo = z.infer<typeof MessageInfo>;

/** Others' read positions; empty when the caller turned read receipts off. */
export const ReadReceipt = z.object({
  userId: Id,
  lastReadSeq: z.number().int(),
  at: Timestamp,
});
export type ReadReceipt = z.infer<typeof ReadReceipt>;

/** `GET /me/unreads`: the first call after a reconnect (doc 17 §6). */
export const Unreads = z.object({
  conversations: z.array(
    ReadResult.extend({ lastSeq: z.number().int(), lastMessageAt: Timestamp.nullable() }),
  ),
  /** Rail badge: conversations with unread messages (muted ones only count mentions). */
  unreadConversations: z.number().int(),
  notificationsUnread: z.number().int(),
});
export type Unreads = z.infer<typeof Unreads>;

// ---- Conversation inputs ----------------------------------------------------------------

export const CreateConversation = z.discriminatedUnion('type', [
  /** Returns the existing conversation when there is one (design 4.7). */
  z.object({ type: z.literal('direct'), userId: Id, message: SendMessage.optional() }),
  z.object({
    type: z.literal('group'),
    userIds: z
      .array(Id)
      .min(2)
      .max(CHAT_LIMITS.groupMembers - 1),
    name: z.string().min(1).max(80).optional(),
    emoji: z.string().max(32).optional(),
    message: SendMessage.optional(),
  }),
  z.object({
    type: z.literal('space'),
    spaceId: Id,
    name: z.string().min(1).max(80),
    emoji: z.string().max(32).optional(),
    message: SendMessage.optional(),
    /**
     * Private channel: only the creator (owner) and `userIds` see it, each a space member
     * (else 409 chat_not_in_space). Off or absent: the whole space sees it.
     */
    private: z.boolean().optional(),
    userIds: z
      .array(Id)
      .max(CHAT_LIMITS.privateChannelMembers - 1)
      .optional(),
  }),
  /** Alert conversation: space-bound (membership from the space) or with listed people. */
  z.object({
    type: z.literal('alert'),
    name: z.string().min(1).max(80),
    emoji: z.string().max(32).optional(),
    spaceId: Id.optional(),
    userIds: z
      .array(Id)
      .max(CHAT_LIMITS.groupMembers - 1)
      .default([]),
  }),
]);
export type CreateConversation = z.infer<typeof CreateConversation>;

export const UpdateConversation = z.object({
  /** null clears the name of a group (back to member names). */
  name: z.string().min(1).max(80).nullable().optional(),
  archived: z.boolean().optional(),
  /** One emoji (the reaction rule, else 400 chat_invalid_emoji); null removes it. */
  emoji: z.string().max(32).nullable().optional(),
  /**
   * Space channels: true makes it private (everyone in the space now is added, then people can
   * be removed), false opens it to the whole space. Channel owners and space admins.
   */
  private: z.boolean().optional(),
});

/** "Space'e bağla": a group becomes a space conversation; history and attachments stay. */
export const LinkConversationSpace = z.object({ spaceId: Id });

export const UpdateMyConversation = z.object({
  pinned: z.boolean().optional(),
  notify: NotifyLevel.optional(),
  /** "Sessize al 1 sa"; null unmutes. */
  mutedUntil: Timestamp.nullable().optional(),
  /** Personal archive (H19); the conversation-wide archive is `UpdateConversation.archived`. */
  archived: z.boolean().optional(),
});

export const ReorderPinned = z.object({
  conversationIds: z.array(Id).max(CHAT_LIMITS.pinnedConversations),
});

// ---- Attachments, pins, search ----------------------------------------------------------

/** Where to upload (Drive createUpload) before sending: space › Ekler › chat, or Kişisel › Chat ekleri. */
export const AttachmentFolder = z.object({ spaceId: Id, folderId: Id });
export type AttachmentFolder = z.infer<typeof AttachmentFolder>;

export const ChatFile = z.object({
  attachment: MessageAttachment,
  messageId: Id,
  seq: z.number().int(),
  author: UserSummary.nullable(),
  createdAt: Timestamp,
});
export type ChatFile = z.infer<typeof ChatFile>;

export const ChatFilesPage = z.object({
  items: z.array(ChatFile),
  nextCursor: z.string().nullable(),
  totalCount: z.number().int(),
  totalBytes: z.number().int(),
});
export type ChatFilesPage = z.infer<typeof ChatFilesPage>;

export const AttachmentUrlQuery = z.object({
  disposition: Disposition.optional(),
  /** Asks for a preview image instead of the file. */
  preview: PreviewKind.optional(),
});

export const PinnedMessage = z.object({
  message: Message,
  pinnedBy: UserSummary.nullable(),
  pinnedAt: Timestamp,
});
export type PinnedMessage = z.infer<typeof PinnedMessage>;

export const SearchMessagesQuery = z.object({
  q: z.string().min(1).max(200),
  conversationId: Id.optional(),
  fromUserId: Id.optional(),
  hasFile: z.stringbool().optional(),
  after: Timestamp.optional(),
  before: Timestamp.optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const MessageSearchHit = z.object({
  message: Message,
  conversation: z.object({
    id: Id,
    type: ConversationType,
    title: z.string(),
    emoji: z.string().nullable().optional(),
  }),
  /** Excerpt with matches wrapped in `<mark>…</mark>` (the only markup; everything else escaped). */
  highlight: z.string(),
});
export type MessageSearchHit = z.infer<typeof MessageSearchHit>;

// ---- Presence and status (19.13, 19.15) -------------------------------------------------

/** What the person chose; `invisible` looks offline to others. */
export const StatusVisibility = z.enum(['online', 'busy', 'dnd', 'away', 'invisible']);
export type StatusVisibility = z.infer<typeof StatusVisibility>;

/**
 * Presence rules (Teams-like). A device is active while its last input is under idleMinutes old
 * and it is not locked (mobile: in the foreground); the person shows the most active device.
 * Order: invisible (offline) > dnd > in a meeting (busy, auto) > chosen busy > chosen away >
 * activity (online / away) > offline offlineGraceSeconds after the last connection closed.
 */
export const PRESENCE_LIMITS = { idleMinutes: 15, offlineGraceSeconds: 30 } as const;

export const PresenceDevice = z.enum(['web', 'desktop', 'mobile']);
export type PresenceDevice = z.infer<typeof PresenceDevice>;

/** What others see: the union of all devices, choice and automatic states applied. */
export const PresenceState = z.enum(['online', 'away', 'busy', 'dnd', 'offline']);
export type PresenceState = z.infer<typeof PresenceState>;

export const StatusMessage = z.object({
  text: z.string().min(1).max(100),
  emoji: z.string().max(32).nullable(),
  expiresAt: Timestamp.nullable(),
});

export const UserStatus = z.object({
  visibility: StatusVisibility,
  /** The chosen visibility (busy, dnd, away, invisible) until then; null keeps it until changed. */
  visibilityUntil: Timestamp.nullable(),
  message: StatusMessage.nullable(),
  /** "Toplantıdayken otomatik Toplantıda". */
  autoMeeting: z.boolean(),
});
export type UserStatus = z.infer<typeof UserStatus>;

export const UpdateUserStatus = z.object({
  visibility: StatusVisibility.optional(),
  visibilityUntil: Timestamp.nullable().optional(),
  message: StatusMessage.nullable().optional(),
  autoMeeting: z.boolean().optional(),
});

export const Presence = z.object({
  userId: Id,
  state: PresenceState,
  /** Automatic state on top of the chosen one (meet module). */
  auto: z.enum(['meeting', 'screen_share']).nullable(),
  message: StatusMessage.nullable(),
  /** Last input on any device; for people offline, when they were last active. */
  lastSeenAt: Timestamp.nullable(),
  /** The device the state comes from (the most active one); null when offline. */
  device: PresenceDevice.nullable().optional(),
  /** When the chosen busy / dnd / away ends; null when it does not end on its own. */
  until: Timestamp.nullable().optional(),
});
export type Presence = z.infer<typeof Presence>;

export const PresenceQuery = z.object({ userIds: z.array(Id).min(1).max(200) });

/** Person card (19.13): shared spaces are those both people belong to. */
export const ChatUserCard = z.object({
  user: UserSummary,
  orgRole: OrgRole,
  isGuest: z.boolean(),
  presence: Presence,
  timezone: z.string().nullable(),
  sharedSpaces: z.array(z.object({ id: Id, name: z.string(), color: SpaceColor })),
  sharedConversations: z.array(z.object({ id: Id, type: ConversationType, title: z.string() })),
  directConversationId: Id.nullable(),
});
export type ChatUserCard = z.infer<typeof ChatUserCard>;

// ---- Reports to the org's admins (API 54, capability chat.reports) ----------------------

/** Why a message or a person was reported ("Yöneticiye bildir"). */
export const ChatReportReason = z.enum([
  'harassment',
  'hate',
  'spam',
  'inappropriate',
  'violence',
  'self_harm',
  'other',
]);
export type ChatReportReason = z.infer<typeof ChatReportReason>;

export const ChatReportStatus = z.enum(['open', 'resolved', 'dismissed']);
export type ChatReportStatus = z.infer<typeof ChatReportStatus>;

/** Body of reportChatMessage and reportUser. */
export const CreateChatReport = z.object({
  reason: ChatReportReason,
  note: z.string().trim().max(1000).optional(),
});
export type CreateChatReport = z.infer<typeof CreateChatReport>;

/**
 * What the reporter gets back. Reporting the same message or person again while the earlier
 * report is still open returns that report (no second notification).
 */
export const ChatReportReceipt = z.object({ id: Id, status: ChatReportStatus });
export type ChatReportReceipt = z.infer<typeof ChatReportReceipt>;

/** Yönetim › Bildirilen içerik: one report as the org's admins see it. */
export const ChatReport = z.object({
  id: Id,
  kind: z.enum(['message', 'user']),
  status: ChatReportStatus,
  reason: ChatReportReason,
  note: z.string().nullable(),
  /** Null once the account is gone. */
  reporter: UserSummary.nullable(),
  /** The reported person, or the message's author. */
  reportedUser: UserSummary.nullable(),
  /** Message reports: the text as it was when reported, so admins see it without joining. */
  message: z
    .object({
      id: Id.nullable(),
      conversationId: Id.nullable(),
      conversationType: ConversationType.nullable(),
      /** Channel or group name; null for direct messages and removed conversations. */
      conversationTitle: z.string().nullable(),
      seq: z.number().int().nullable(),
      excerpt: z.string(),
      /** Deleted since the report (or the conversation is gone). */
      deleted: z.boolean(),
      /** Web path that opens the message for those who can read it. */
      url: z.string().nullable(),
    })
    .nullable(),
  resolvedBy: UserSummary.nullable(),
  resolvedAt: Timestamp.nullable(),
  createdAt: Timestamp,
});
export type ChatReport = z.infer<typeof ChatReport>;

export const ListChatReportsQuery = z.object({
  /** Missing: every status, newest first. */
  status: ChatReportStatus.optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListChatReportsQuery = z.infer<typeof ListChatReportsQuery>;

/** Close a report: handled (resolved) or nothing to do (dismissed); `open` reopens it. */
export const ResolveChatReport = z.object({ status: ChatReportStatus });
export type ResolveChatReport = z.infer<typeof ResolveChatReport>;

export const ChatSettings = z.object({
  /**
   * @deprecated Always true: reads are never hidden (user decision, 2026-10-29). Kept so older
   * clients still parse the settings.
   */
  readReceipts: z.boolean(),
  /** IANA zone for quiet hours, digest time and the person card. */
  timezone: z.string().nullable(),
  /** Last five distinct reactions, for the hover toolbar. */
  recentEmojis: z.array(z.string()),
});
export type ChatSettings = z.infer<typeof ChatSettings>;
export const UpdateChatSettings = z.object({
  /** @deprecated Accepted and ignored. */
  readReceipts: z.boolean().optional(),
  timezone: z.string().min(1).max(64).nullable().optional(),
});

// ---- Notifications (doc 17 §10, 19.17) --------------------------------------------------

/** Rows of the preferences matrix (doc 17 §10). */
export const NotificationCategory = z.enum([
  'mention',
  'direct_reply',
  'conversation_message',
  'alert',
  'share',
  'boards',
  'meetings',
  'links',
  'vault',
  'security',
  'portal',
  'announcements',
]);
export type NotificationCategory = z.infer<typeof NotificationCategory>;

/** Source filter of the notification centre. */
export const NotificationSource = z.enum([
  'chat',
  'pages',
  'boards',
  'meetings',
  'drive',
  'vault',
  'alerts',
  'account',
  'announcements',
]);
export type NotificationSource = z.infer<typeof NotificationSource>;

/**
 * Known types; other modules add theirs in the same `<module>.<event>` form.
 * Clients render titles from i18n (`web.chat.notifications.<type>`) with `data`.
 */
export const NOTIFICATION_TYPES = [
  'chat.mention',
  'chat.direct',
  'chat.reply',
  'chat.message',
  'chat.alert',
  'chat.webhook_failing',
  'chat.reminder',
  'chat.scheduled_failed',
  'drive.shared',
  'space.added',
  'link.down',
  'link.up',
  'announcement.published',
  'kudos.received',
  /**
   * An MCP client, the AI or a plugin asks the person to approve an action (also e-mailed);
   * the url opens the approval. Read once it is approved, rejected or expired.
   */
  'approval.requested',
  /** API 54: someone reported a message or a person; sent to the org's owners and admins. */
  'chat.report',
] as const;

export const NotificationTarget = z.object({
  type: z.enum([
    'message',
    'conversation',
    'node',
    'link',
    'card',
    'meeting',
    'space',
    'webhook',
    'announcement',
    'event',
    'approval',
    /** API 31: a plugin's notification (`plugin.notification`); `id` is the installation. */
    'plugin',
    /** API 54: a chat report for the org's admins (`chat.report`); `id` is the report. */
    'report',
  ]),
  id: Id,
  conversationId: Id.nullable(),
  seq: z.number().int().nullable(),
  spaceId: Id.nullable(),
});

export const Notification = z.object({
  id: Id,
  type: z.string().regex(/^[a-z]+\.[a-z_]+$/),
  /**
   * Show an OS notification for it (desktop app, browser). API 33: false for a plugin the person
   * keeps off the desktop. API 34: the person's desktop channel for this kind of notification,
   * not in quiet hours or Do not disturb. Missing (older servers): the usual rules.
   */
  desktop: z.boolean().optional(),
  category: NotificationCategory,
  source: NotificationSource,
  actor: UserSummary.nullable(),
  target: NotificationTarget,
  /** Flat values for the i18n text: conversationTitle, excerpt, severity, nodeName… */
  data: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  /** Rows sharing a group key merge ("5 yeni mention"). */
  count: z.number().int(),
  /** Web path that opens the message, node or card. */
  url: z.string(),
  readAt: Timestamp.nullable(),
  snoozedUntil: Timestamp.nullable(),
  dismissedAt: Timestamp.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Notification = z.infer<typeof Notification>;

export const ListNotificationsQuery = z.object({
  box: z.enum(['inbox', 'snoozed', 'dismissed']).default('inbox'),
  source: NotificationSource.optional(),
  /** Tabs: Bahsetmeler, Atananlar, Alarmlar. */
  kind: z.enum(['mentions', 'assigned', 'alerts']).optional(),
  unreadOnly: z.stringbool().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

export const NotificationCounts = z.object({
  unread: z.number().int(),
  snoozed: z.number().int(),
  bySource: z.record(NotificationSource, z.number().int()),
});
export type NotificationCounts = z.infer<typeof NotificationCounts>;

/** Bulk actions of 19.17; `all: true` applies to every unread inbox row. */
export const UpdateNotifications = z
  .object({
    ids: z.array(Id).max(500).optional(),
    all: z.boolean().optional(),
    action: z.enum(['read', 'unread', 'snooze', 'dismiss', 'restore']),
    /** For `snooze`: back in the inbox, unread, at this time. */
    until: Timestamp.optional(),
  })
  .refine((v) => (v.ids?.length ?? 0) > 0 || v.all === true, { message: 'ids or all' })
  .refine((v) => v.action !== 'snooze' || v.until !== undefined, { message: 'until' });

export const DigestFrequency = z.enum(['off', 'hourly', 'daily']);

/**
 * Where a notification can reach the person. `desktop`: an OS notification from the desktop app
 * or the browser (Notification.desktop); `email`: the digest.
 */
export const NotificationChannel = z.enum(['inApp', 'desktop', 'push', 'email']);
export type NotificationChannel = z.infer<typeof NotificationChannel>;

/**
 * Rows of the preferences page: every notification type belongs to one (notificationGroupOf). A
 * row the person never set follows the older category it was sent under, so clients that only
 * know categories keep working. Types: exact names, or `prefix.*`; exact names win.
 */
export const NOTIFICATION_GROUPS = [
  { key: 'chat_direct', types: ['chat.direct'], category: 'direct_reply', module: 'chat' },
  { key: 'chat_mention', types: ['chat.mention'], category: 'mention', module: 'chat' },
  { key: 'chat_reply', types: ['chat.reply'], category: 'direct_reply', module: 'chat' },
  {
    key: 'chat_messages',
    types: ['chat.message'],
    category: 'conversation_message',
    module: 'chat',
  },
  /** Critical alert messages: through quiet hours; the bell cannot be turned off. */
  {
    key: 'chat_alerts',
    types: ['chat.alert'],
    category: 'alert',
    module: 'chat',
    locked: ['inApp'],
  },
  {
    key: 'chat_reminders',
    types: ['chat.reminder', 'chat.scheduled_failed'],
    category: 'mention',
    module: 'chat',
  },
  /** API 54: chat reports; a row only for those who review them (chat.review_reports). */
  {
    key: 'chat_reports',
    types: ['chat.report'],
    category: 'alert',
    module: 'chat',
    reviewers: true,
  },
  /** Incoming and missed calls; no e-mail. */
  {
    key: 'calls',
    types: ['meet.call', 'meet.call_missed'],
    category: 'meetings',
    module: 'meet',
    channels: ['inApp', 'desktop', 'push'],
  },
  { key: 'meetings', types: ['meet.*'], category: 'meetings', module: 'meet' },
  { key: 'calendar', types: ['calendar.*'], category: 'meetings', module: 'calendar' },
  { key: 'mail', types: ['mail.*'], category: 'alert', module: 'mail' },
  { key: 'boards', types: ['boards.*'], category: 'boards', module: 'boards' },
  { key: 'pages', types: ['page.*'], category: 'mention', module: 'wiki' },
  { key: 'drive', types: ['drive.*', 'space.*'], category: 'share' },
  { key: 'approvals', types: ['approval.*'], category: 'alert' },
  {
    key: 'announcements',
    types: ['announcement.*', 'kudos.*'],
    category: 'announcements',
    locked: ['inApp'],
  },
  { key: 'forms', types: ['forms.*'], category: 'alert', module: 'forms' },
  { key: 'automations', types: ['automations.*'], category: 'alert', module: 'automations' },
  /** Links going down and webhooks failing. */
  { key: 'integrations', types: ['link.*', 'chat.webhook_failing'], category: 'links' },
  { key: 'vault', types: ['vault.*'], category: 'vault', module: 'vault' },
  /** Sign-in and account security: the bell and e-mail cannot be turned off. */
  {
    key: 'security',
    types: ['security.*', 'account.*'],
    category: 'security',
    locked: ['inApp', 'email'],
  },
  { key: 'portal', types: ['portal.*'], category: 'portal', module: 'portal' },
  /** Every plugin; each one may also be muted on its own (plugin notification settings). */
  { key: 'plugins', types: ['plugin.*'], category: 'alert' },
] as const satisfies readonly {
  key: string;
  types: readonly string[];
  category: NotificationCategory;
  module?: string;
  channels?: readonly NotificationChannel[];
  locked?: readonly NotificationChannel[];
  /** Shown only to the people who review chat reports (org owners and admins). */
  reviewers?: boolean;
}[];

export type NotificationGroupKey = (typeof NOTIFICATION_GROUPS)[number]['key'];
export const NotificationGroupKey = z.enum(
  NOTIFICATION_GROUPS.map((g) => g.key) as [NotificationGroupKey, ...NotificationGroupKey[]],
);

/** The row a type belongs to (exact names before `prefix.*`); null: only its category applies. */
export function notificationGroupOf(type: string): NotificationGroupKey | null {
  for (const g of NOTIFICATION_GROUPS) {
    if ((g.types as readonly string[]).includes(type)) return g.key;
  }
  for (const g of NOTIFICATION_GROUPS) {
    for (const t of g.types as readonly string[]) {
      if (t.endsWith('.*') && type.startsWith(t.slice(0, -1))) return g.key;
    }
  }
  return null;
}

export const NotificationGroupPref = z.object({
  group: NotificationGroupKey,
  inApp: z.boolean(),
  desktop: z.boolean(),
  push: z.boolean(),
  email: z.boolean(),
  /** Channels the person cannot turn off. */
  locked: z.array(NotificationChannel),
  /** Channels this row has at all (calls send no e-mail). */
  channels: z.array(NotificationChannel),
});
export type NotificationGroupPref = z.infer<typeof NotificationGroupPref>;

export const NotificationPref = z.object({
  category: NotificationCategory,
  inApp: z.boolean(),
  push: z.boolean(),
  email: z.boolean(),
  /** Channels the person cannot turn off (security, new vault device). */
  locked: z.array(z.enum(['inApp', 'push', 'email'])),
});

export const QuietHours = z.object({
  /** "22:00" – "08:00" in the person's time zone; may wrap midnight. */
  from: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  to: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
});

export const NotificationPrefs = z.object({
  categories: z.array(NotificationPref),
  digest: DigestFrequency,
  quietHours: QuietHours.nullable(),
  /** Every row × channel (modules the org turned off are left out); newer clients show these. */
  groups: z.array(NotificationGroupPref).optional(),
});
export type NotificationPrefs = z.infer<typeof NotificationPrefs>;

export const UpdateNotificationPrefs = z.object({
  categories: z
    .array(
      z.object({
        category: NotificationCategory,
        inApp: z.boolean().optional(),
        push: z.boolean().optional(),
        email: z.boolean().optional(),
      }),
    )
    .optional(),
  groups: z
    .array(
      z.object({
        group: NotificationGroupKey,
        inApp: z.boolean().optional(),
        desktop: z.boolean().optional(),
        push: z.boolean().optional(),
        email: z.boolean().optional(),
      }),
    )
    .optional(),
  digest: DigestFrequency.optional(),
  quietHours: QuietHours.nullable().optional(),
});

export const PushPlatform = z.enum(['ios', 'android']);

/**
 * `data` of every push the server sends (Expo and FCM). Mobile opens `url` (the web path of the
 * message, node or card) and marks `notificationId` read.
 */
export const PushData = z.object({
  url: z.string(),
  notificationId: Id,
  /** Notification type (`chat.mention`, `link.down`…). */
  type: z.string(),
  /** `meet.call`: the call to answer or decline (getCall / answerCall). */
  callId: Id.optional(),
  /**
   * API 42: the tray tag of a notification that can be cleared later (a plugin's `threadKey`).
   * A data-only `notification.clear` naming this tag removes it from the phone.
   */
  tag: z.string().optional(),
});
export type PushData = z.infer<typeof PushData>;

/** Who delivers to the device: Expo's push service or Firebase Cloud Messaging directly. */
/**
 * expo: Expo push token; fcm: native FCM token; voip: iOS PushKit token (hex), registered beside
 * the Expo token of the same iPhone and used only for incoming calls (VoipPush, CallKit).
 */
export const PushProvider = z.enum(['expo', 'fcm', 'voip']);

/** Why a notification did not ask for a push. `attending`: someone is at a session right now. */
export const PushSkipReason = z.enum([
  'pref_off',
  'silent',
  'busy',
  'dnd',
  'quiet_hours',
  'attending',
  'no_devices',
]);
export type PushSkipReason = z.infer<typeof PushSkipReason>;
export type PushProvider = z.infer<typeof PushProvider>;

const EXPO_TOKEN = /^Expo(nent)?PushToken\[[^\]]+\]$/;

export const ApnsEnvironment = z.enum(['sandbox', 'production']);
export type ApnsEnvironment = z.infer<typeof ApnsEnvironment>;

/** APNs device tokens are hex (32 bytes today; Apple says the length may change). */
const APNS_TOKEN = /^[0-9a-f]{64,200}$/i;

/** `ExponentPushToken[…]` → Expo, anything else → FCM, unless `provider` says otherwise. */
export function pushProviderOf(token: string, provider?: PushProvider): PushProvider {
  return provider ?? (EXPO_TOKEN.test(token) ? 'expo' : 'fcm');
}

export const RegisterPushDevice = z
  .object({
    /**
     * The device's push token (the name stays for compatibility): `ExponentPushToken[…]` for
     * Expo, the native FCM registration token for FCM.
     */
    expoToken: z.string().min(1).max(4096),
    platform: PushPlatform,
    appVersion: z.string().max(40).optional(),
    /** Optional; inferred from the token when missing. */
    provider: PushProvider.optional(),
    /**
     * VoIP tokens: the build's aps-environment (development builds: sandbox; TestFlight and App
     * Store: production). Without it the server tries its default and then the other one.
     */
    apnsEnvironment: ApnsEnvironment.optional(),
  })
  .refine(
    (v) => pushProviderOf(v.expoToken, v.provider) !== 'expo' || EXPO_TOKEN.test(v.expoToken),
    {
      message: 'not an Expo push token',
      path: ['expoToken'],
    },
  )
  .refine((v) => v.apnsEnvironment === undefined || v.provider === 'voip', {
    message: 'apnsEnvironment is for VoIP tokens',
    path: ['apnsEnvironment'],
  })
  .refine((v) => v.provider !== 'voip' || (v.platform === 'ios' && APNS_TOKEN.test(v.expoToken)), {
    message: 'not an iOS VoIP push token',
    path: ['expoToken'],
  });

/** Why a ring stopped (CallKit's end reason: "başka cihazda cevaplandı", "cevapsız"…). */
export const CallEndReason = z.enum(['answered_elsewhere', 'declined', 'cancelled', 'missed']);
export type CallEndReason = z.infer<typeof CallEndReason>;

/**
 * iOS PushKit (VoIP) pushes, sent straight to APNs (apns-push-type voip, topic
 * `<bundleId>.voip`, priority 10). Apple's rule: the app reports every one to CallKit in the same
 * run (reportNewIncomingCall), `meet.call_end` too (report, then end it at once), or iOS stops
 * delivering them. A device that got the VoIP ring gets no ordinary push for the same call.
 */
export const VoipPush = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('meet.call'),
    callId: Id,
    notificationId: Id.nullable(),
    callerId: Id.nullable(),
    callerName: z.string(),
    /** Absolute URL, or null. */
    callerImageUrl: z.string().nullable(),
    video: z.boolean(),
    /** Rung into a meeting going on ("X seni toplantıya çağırıyor"). */
    invite: z.boolean(),
    /** The same title and body an ordinary push would show, in the person's language. */
    title: z.string(),
    body: z.string(),
    conversationId: Id.nullable(),
    /** App path of the call (answer: open it, then answerCall and joinMeeting). */
    url: z.string(),
    /** The ring stops then; a push arriving later is reported and ended at once. */
    expiresAt: Timestamp,
    /** POST without a session declines the call (declineCallSigned); valid until the ring ends. */
    declineUrl: z.string(),
  }),
  /** Answered on another device, declined, cancelled or missed: end it in CallKit. */
  z.object({
    type: z.literal('meet.call_end'),
    callId: Id,
    notificationId: Id.nullable(),
    reason: CallEndReason.optional(),
  }),
]);
export type VoipPush = z.infer<typeof VoipPush>;

export const PushDevice = z.object({
  id: Id,
  platform: PushPlatform,
  appVersion: z.string().nullable(),
  lastSeenAt: Timestamp,
  disabledAt: Timestamp.nullable(),
  /** "Bu cihazda bildirim alma": no push to this device until then (far future: until changed). */
  mutedUntil: Timestamp.nullable().optional(),
  provider: PushProvider.optional(),
  /** VoIP devices: the APNs environment the server sends to (said, or found); null otherwise. */
  apnsEnvironment: ApnsEnvironment.nullable().optional(),
});
export type PushDevice = z.infer<typeof PushDevice>;

export const UnregisterPushDevice = z.object({ expoToken: z.string().min(1).max(4096) });

/** This device only: no push until `mutedUntil` (null: notify again). */
export const MutePushDevice = z.object({
  expoToken: z.string().min(1).max(4096),
  mutedUntil: Timestamp.nullable(),
});

/** "Why didn't this person get this push?": admins, Yönetim › Üyeler. */
export const PushDiagnostics = z.object({
  userId: Id,
  now: Timestamp,
  visibility: StatusVisibility,
  quietHours: QuietHours.nullable(),
  inQuietHours: z.boolean(),
  /** Open connections; one with `attending` holds pushes back. */
  sessions: z.array(
    z.object({
      client: PresenceDevice.nullable(),
      focused: z.boolean(),
      attending: z.boolean(),
      idleSeconds: z.number().int().nullable(),
      beatSecondsAgo: z.number().int(),
      conversationId: Id.nullable(),
    }),
  ),
  devices: z.array(
    z.object({
      id: Id,
      provider: PushProvider,
      platform: PushPlatform,
      appVersion: z.string().nullable(),
      lastSeenAt: Timestamp,
      disabledAt: Timestamp.nullable(),
      disabledReason: z.string().nullable(),
      mutedUntil: Timestamp.nullable(),
    }),
  ),
  /** The person's rows; `push` false turns that kind off. */
  groups: z.array(NotificationGroupPref),
  /** With ?conversationId: their level there and whether they muted it. */
  conversation: z.object({ notify: z.string(), mutedUntil: Timestamp.nullable() }).nullable(),
  recent: z.array(
    z.object({
      id: Id,
      type: z.string(),
      createdAt: Timestamp,
      updatedAt: Timestamp,
      count: z.number().int(),
      wantsPush: z.boolean(),
      pushSkip: PushSkipReason.nullable(),
      pushedAt: Timestamp.nullable(),
      readAt: Timestamp.nullable(),
      outcome: z
        .array(
          z.object({
            deviceId: Id,
            provider: z.string(),
            ok: z.boolean(),
            error: z.string().optional(),
          }),
        )
        .nullable(),
    }),
  ),
});
export type PushDiagnostics = z.infer<typeof PushDiagnostics>;

export const PushDiagnosticsQuery = z.object({ conversationId: Id.optional() });

// ---- Incoming webhooks (design 4.11-4.14) -----------------------------------------------

/**
 * Service integrations (roadmap: dış servis bildirimleri): an incoming webhook that reads the
 * service's own payload, checks its signature and posts only the chosen events as cards.
 * GitHub signs with HMAC-SHA256 (X-Hub-Signature-256), Jira with HMAC-SHA256 (X-Hub-Signature),
 * Azure DevOps sends the secret as the Basic auth password of its service hook.
 */
export const WEBHOOK_PROVIDERS = ['github', 'azure_devops', 'jira'] as const;
export const WebhookProvider = z.enum(WEBHOOK_PROVIDERS);
export type WebhookProvider = z.infer<typeof WebhookProvider>;

/** Event keys per service (GitHub's X-GitHub-Event, Azure's eventType, Jira's webhookEvent). */
export const WEBHOOK_PROVIDER_EVENTS = {
  github: ['push', 'pull_request', 'issues', 'issue_comment', 'workflow_run', 'release'],
  azure_devops: [
    'git.push',
    'git.pullrequest.created',
    'git.pullrequest.updated',
    'git.pullrequest.merged',
    'build.complete',
    'ms.vss-release.deployment-completed-event',
    'workitem.created',
    'workitem.updated',
    'workitem.commented',
  ],
  jira: ['jira:issue_created', 'jira:issue_updated', 'jira:issue_deleted', 'comment_created'],
} as const satisfies Record<WebhookProvider, readonly string[]>;

/** Etkin, Sınırda (429 in the last hour), Sessizde, Hatalı (recent 4xx), Kapalı. */
export const WebhookHealth = z.enum(['active', 'limited', 'muted', 'failing', 'disabled']);

export const IncomingWebhook = z.object({
  id: Id,
  conversationId: Id,
  name: z.string(),
  avatarUrl: z.url().nullable(),
  /** `https://hub/api/hooks/<id>?key=••••` — the key is only shown on create/regenerate. */
  maskedUrl: z.string(),
  rateLimit: z.number().int(),
  health: WebhookHealth,
  lastUsedAt: Timestamp.nullable(),
  mutedUntil: Timestamp.nullable(),
  disabledAt: Timestamp.nullable(),
  createdBy: UserSummary.nullable(),
  createdAt: Timestamp,
  /** Requests in the last 24 h. */
  deliveries24h: z.number().int(),
  /** A service integration; null/absent: Crewhall or Google Chat body. */
  provider: WebhookProvider.nullable().optional(),
  /** The service events it posts (from WEBHOOK_PROVIDER_EVENTS). */
  events: z.array(z.string()).optional(),
  /**
   * Severity of a message without a card (design 04 "Kartsız mesajın önemi"); null or absent:
   * read from the text (guessAlertSeverity). A chosen "critical" breaks quiet hours like a
   * critical card; one read from the text does not.
   */
  textSeverity: AlertSeverity.nullable().optional(),
});
export type IncomingWebhook = z.infer<typeof IncomingWebhook>;

/** Create and regenerate answer the full URL once; the server keeps only its hash. */
export const IncomingWebhookSecret = z.object({
  webhook: IncomingWebhook,
  url: z.url(),
  /** Integrations: the signing secret to paste into the service, shown only here. */
  secret: z.string().nullable().optional(),
});
export type IncomingWebhookSecret = z.infer<typeof IncomingWebhookSecret>;

const ProviderEvents = z.array(z.string().max(80)).max(30);

export const CreateIncomingWebhook = z
  .object({
    name: z.string().min(1).max(80),
    /** Image already uploaded to Drive, used as the bot avatar. */
    avatarNodeId: Id.optional(),
    provider: WebhookProvider.optional(),
    /** Default: every event of the service. */
    events: ProviderEvents.optional(),
    /** Null or absent: read from the text. */
    textSeverity: AlertSeverity.nullable().optional(),
  })
  .refine(
    (v) =>
      !v.events ||
      (v.provider !== undefined &&
        v.events.every((e) =>
          (WEBHOOK_PROVIDER_EVENTS[v.provider!] as readonly string[]).includes(e),
        )),
    { path: ['events'], message: 'unknown event' },
  );

export const UpdateIncomingWebhook = z.object({
  name: z.string().min(1).max(80).optional(),
  avatarNodeId: Id.nullable().optional(),
  mutedUntil: Timestamp.nullable().optional(),
  disabled: z.boolean().optional(),
  /** Integrations only; checked against the service's event list. */
  events: ProviderEvents.optional(),
  /** Null: read from the text again. */
  textSeverity: AlertSeverity.nullable().optional(),
});

export const WebhookDelivery = z.object({
  id: Id,
  receivedAt: Timestamp,
  status: z.number().int(),
  sizeBytes: z.number().int(),
  ip: z.string().nullable(),
  latencyMs: z.number().int(),
  error: z.string().nullable(),
  /** Relevant part of a failed body; kept 30 days, never the key. */
  bodyExcerpt: z.string().nullable(),
  messageId: Id.nullable(),
});
export type WebhookDelivery = z.infer<typeof WebhookDelivery>;

/** Crewhall body for `POST /api/hooks/:id?key=`: text, a card or both. */
export const HookPayload = z
  .object({
    text: z.string().max(CHAT_LIMITS.messageChars).optional(),
    card: AlertCard.optional(),
  })
  .refine((v) => v.text !== undefined || v.card !== undefined, { message: 'text or card' });

/** Google Chat body (text and cardsV2); unknown widgets are reduced to text. */
export const GoogleChatPayload = z.object({
  text: z.string().max(CHAT_LIMITS.messageChars).optional(),
  cardsV2: z
    .array(
      z.object({
        cardId: z.string().optional(),
        card: z.record(z.string(), z.unknown()),
      }),
    )
    .optional(),
  thread: z.unknown().optional(),
});

export const HookResult = z.object({ messageId: Id, seq: z.number().int() });

// ---- WebSocket (doc 17 §6) --------------------------------------------------------------

/** Connect with `/ws?ticket=<ticket>`; a ticket works once, within 30 s. */
export const WsTicket = z.object({
  ticket: z.string(),
  expiresAt: Timestamp,
  /** Path to open, relative to the API origin. */
  path: z.literal('/ws'),
});
export type WsTicket = z.infer<typeof WsTicket>;

/** Close codes the server uses (4401: bad ticket, 4403: access gone, 4408: missed heartbeats). */
export const WS_CLOSE = { ticketInvalid: 4401, forbidden: 4403, timeout: 4408 } as const;

export const WsClientEvent = z.discriminatedUnion('type', [
  /**
   * Every 25 s, and right away when focus, the open conversation or the lock state changes.
   * `active`: user input in the last PRESENCE_LIMITS.idleMinutes (servers before apiLevel 14
   * read only this); `focused`: tab/app visible (mobile in background sends false). No
   * focused session → push is sent. `activeConversationId`: the conversation on screen; while
   * focused, messages there create no notification (bell, toast or push).
   * `idleSeconds`: seconds since the last input on this device (desktop: system-wide); the
   * server then decides activity itself. `locked`: screen locked or the system asleep.
   */
  z.object({
    type: z.literal('heartbeat'),
    active: z.boolean(),
    focused: z.boolean(),
    activeConversationId: Id.nullable().optional(),
    client: PresenceDevice.optional(),
    idleSeconds: z.number().int().min(0).optional(),
    locked: z.boolean().optional(),
  }),
  /** Only while the conversation is visible; others see it for 3 s. */
  z.object({ type: z.literal('typing'), conversationId: Id }),
  /** People whose presence this client shows; replaces the previous set. */
  z.object({ type: z.literal('presence.watch'), userIds: z.array(Id).max(500) }),
]);
export type WsClientEvent = z.infer<typeof WsClientEvent>;

export const NodeChange = z.enum(['created', 'updated', 'moved', 'trashed', 'restored', 'deleted']);

export const WsServerEvent = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('ready'),
    userId: Id,
    orgId: Id,
    serverTime: Timestamp,
    heartbeatSeconds: z.number().int(),
  }),
  z.object({
    type: z.literal('message.created'),
    conversationId: Id,
    message: Message,
    /**
     * API 55: the receiving person is at a session right now (a focused desktop or web session
     * with fresh input, or the mobile app in the foreground; presence `attending`). Only that
     * session makes a sound: one that is not being looked at plays no chime. Set per recipient on
     * others' messages; false for critical alerts, which ring everywhere. Missing (older
     * servers, own messages): the usual rules.
     */
    attended: z.boolean().optional(),
  }),
  /** Edit, attachment removed, pin change. */
  z.object({ type: z.literal('message.updated'), conversationId: Id, message: Message }),
  /** The row stays as a tombstone; quotes of it read "Bu mesaj silindi". */
  z.object({
    type: z.literal('message.deleted'),
    conversationId: Id,
    messageId: Id,
    seq: z.number().int(),
    deletedAt: Timestamp,
  }),
  z.object({
    type: z.literal('reaction'),
    conversationId: Id,
    messageId: Id,
    emoji: z.string(),
    userId: Id,
    added: z.boolean(),
  }),
  /**
   * Someone's read position moved. For the caller's own devices the unread counts are set;
   * for others they are omitted (and nothing is sent when receipts are off).
   */
  z.object({
    type: z.literal('read'),
    conversationId: Id,
    userId: Id,
    lastReadSeq: z.number().int(),
    unread: z.number().int().optional(),
    unreadMentions: z.number().int().optional(),
  }),
  z.object({
    type: z.literal('typing'),
    conversationId: Id,
    userId: Id,
    expiresAt: Timestamp,
  }),
  z.object({ type: z.literal('presence'), presence: Presence }),
  /** Created, renamed, members changed, my settings changed (built per recipient). */
  z.object({ type: z.literal('conversation.updated'), conversation: Conversation }),
  /** Left, removed or no longer visible. */
  z.object({
    type: z.literal('conversation.removed'),
    conversationId: Id,
    /** `deleted`: deleted for everyone (H19); `cleared`: cleared for me on another device. */
    reason: z.enum(['left', 'removed', 'deleted', 'cleared', 'archived']).optional(),
  }),
  z.object({
    type: z.literal('notification'),
    notification: Notification,
    unreadCount: z.number().int(),
    /**
     * API 55: the person was at a session when it was sent (a focused desktop or web session
     * with fresh input, or the mobile app in the foreground). Only the session being looked at
     * makes noise: the others show no OS notification and play no chime. False for urgent ones
     * and incoming calls (`everyDevice`), which ring everywhere. Missing (older servers): the
     * usual rules.
     */
    attended: z.boolean().optional(),
  }),
  /** Read, dismissed or snoozed elsewhere: refresh the bell. */
  z.object({ type: z.literal('notifications.changed'), unreadCount: z.number().int() }),
  /** Drive change in a space the person can see (invalidate listings). */
  z.object({
    type: z.literal('node.updated'),
    spaceId: Id,
    nodeId: Id,
    parentId: Id.nullable(),
    change: NodeChange,
  }),
  /** A checked link went up, warn or down. */
  z.object({ type: z.literal('link.status'), linkId: Id, health: LinkHealth }),
  SurfaceChangedEvent,
  /** Events were dropped (slow connection): call GET /me/unreads and refetch open views. */
  z.object({ type: z.literal('resync') }),
  z.object({ type: z.literal('error'), code: z.string(), message: z.string() }),
  /** Boards module: a board's revision moved / a drawing's thumbnail was rendered. */
  ...BoardsWsEvent.options,
  ...TablesWsEvent.options,
  /** Mail module: a folder changed on the server (IDLE, background sync). */
  ...MailWsEvent.options,
  ...MailInboxWsEvent.options,
  /** Meet module: calls ringing and changing (H7). */
  ...MeetWsEvent.options,
]);
export type WsServerEvent = z.infer<typeof WsServerEvent>;
export type WsServerEventType = WsServerEvent['type'];
