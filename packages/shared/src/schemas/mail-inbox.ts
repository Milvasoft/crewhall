import { z } from 'zod';
import { Id, PageQuery, Timestamp } from './common';
import { MailAddress, MailAuthMode, MailMessage, MailSend } from './mail';

/**
 * Shared inbox (sonraki-isler.md "Ortak gelen kutusu"): an org address such as destek@ that a
 * space's members work together. Every conversation (mail thread) has a status, an assignee,
 * tags and internal notes; the first response time is measured against the inbox's SLA.
 */

export const MAIL_CONVERSATION_STATUSES = ['open', 'pending', 'resolved'] as const;
export const MailConversationStatus = z.enum(MAIL_CONVERSATION_STATUSES);
export type MailConversationStatus = z.infer<typeof MailConversationStatus>;

export const MailInboxPerson = z.object({
  id: Id,
  name: z.string(),
  imageUrl: z.string().nullable(),
});
export type MailInboxPerson = z.infer<typeof MailInboxPerson>;

const Tag = z.string().trim().min(1).max(40);
/** 1 minute to 30 days. */
const SlaMinutes = z.number().int().min(1).max(43_200);

export const MailInbox = z.object({
  id: Id,
  spaceId: Id,
  spaceName: z.string(),
  name: z.string(),
  email: z.string(),
  username: z.string(),
  signatureHtml: z.string(),
  /** First response target in minutes; null = no SLA. */
  slaFirstResponseMinutes: z.number().int().nullable(),
  status: z.enum(['ok', 'auth_failed']),
  /** `password`: the inbox's app password; otherwise signed in through the org's provider. */
  authMode: MailAuthMode,
  /** OAuth inbox nobody signed in yet (or its sign-in was revoked): an admin signs it in. */
  needsSignIn: z.boolean(),
  counts: z.object({
    open: z.number().int(),
    unassigned: z.number().int(),
    mine: z.number().int(),
  }),
  /** Reply, assign, change status, notes (space editors). */
  canWork: z.boolean(),
  /** Settings, password, canned responses' owner rights (space admins). */
  canManage: z.boolean(),
  createdAt: Timestamp,
});
export type MailInbox = z.infer<typeof MailInbox>;

export const CreateMailInbox = z.object({
  spaceId: Id,
  name: z.string().trim().min(1).max(120),
  email: z.email().max(320),
  /** IMAP/SMTP login when it is not the address. */
  username: z.string().trim().min(1).max(320).optional(),
  /**
   * The inbox's app password. Without it (org signs in with Microsoft 365 or Google) the
   * inbox is created unsigned and an admin signs it in (`MAIL_RAW_PATHS.inboxOauthStart`).
   */
  password: z.string().min(1).max(1000).optional(),
  signatureHtml: z.string().max(100_000).optional(),
  slaFirstResponseMinutes: SlaMinutes.nullable().optional(),
});
export type CreateMailInbox = z.infer<typeof CreateMailInbox>;

export const UpdateMailInbox = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  password: z.string().min(1).max(1000).optional(),
  signatureHtml: z.string().max(100_000).optional(),
  slaFirstResponseMinutes: SlaMinutes.nullable().optional(),
});
export type UpdateMailInbox = z.infer<typeof UpdateMailInbox>;

export const MailConversationSla = z.object({
  /** When the first response is due (null without an SLA). */
  dueAt: Timestamp.nullable(),
  /** Answered late, or still unanswered past `dueAt`. */
  breached: z.boolean(),
});

export const MailConversationSummary = z.object({
  id: Id,
  inboxId: Id,
  threadId: z.string(),
  subject: z.string(),
  /** Sender of the first incoming message. */
  customer: MailAddress.nullable(),
  status: MailConversationStatus,
  assignee: MailInboxPerson.nullable(),
  tags: z.array(z.string()),
  messageCount: z.number().int(),
  /** An incoming message nobody opened yet. */
  unread: z.boolean(),
  noteCount: z.number().int(),
  firstMessageAt: Timestamp,
  lastMessageAt: Timestamp,
  /** Last incoming message (the customer's). */
  lastInboundAt: Timestamp.nullable(),
  /** First message the team sent in the conversation (from Crewhall or any other program). */
  firstResponseAt: Timestamp.nullable(),
  sla: MailConversationSla,
});
export type MailConversationSummary = z.infer<typeof MailConversationSummary>;

export const MailConversationsQuery = PageQuery.extend({
  status: z.enum([...MAIL_CONVERSATION_STATUSES, 'all']).default('open'),
  /** `me`, `none` (unassigned) or a user id. */
  assignee: z.union([z.enum(['me', 'none']), Id]).optional(),
  tag: Tag.optional(),
  q: z.string().trim().max(200).optional(),
});
export type MailConversationsQuery = z.infer<typeof MailConversationsQuery>;

export const MailConversationNote = z.object({
  id: Id,
  author: MailInboxPerson.nullable(),
  /** Plain text; never sent to the customer. */
  body: z.string(),
  createdAt: Timestamp,
});
export type MailConversationNote = z.infer<typeof MailConversationNote>;

export const MailConversation = MailConversationSummary.extend({
  /** The mail thread, oldest first (incoming and the team's replies). */
  messages: z.array(MailMessage),
  notes: z.array(MailConversationNote),
  /** People writing a reply right now (collision warning). */
  replying: z.array(MailInboxPerson),
});
export type MailConversation = z.infer<typeof MailConversation>;

export const MailConversationQuery = z.object({
  remoteImages: z.stringbool().optional(),
});
export type MailConversationQuery = z.infer<typeof MailConversationQuery>;

export const UpdateMailConversation = z.object({
  status: MailConversationStatus.optional(),
  assigneeId: Id.nullable().optional(),
  tags: z.array(Tag).max(20).optional(),
});
export type UpdateMailConversation = z.infer<typeof UpdateMailConversation>;

export const AddMailConversationNote = z.object({
  body: z.string().trim().min(1).max(10_000),
});
export type AddMailConversationNote = z.infer<typeof AddMailConversationNote>;

/** Sent every few seconds while a reply is being written; `false` when the composer closes. */
export const MailConversationReplying = z.object({ active: z.boolean() });
export type MailConversationReplying = z.infer<typeof MailConversationReplying>;

/** A reply from the inbox's address; the server threads it on the conversation's last message. */
export const MailInboxReply = MailSend.omit({ source: true }).extend({
  mode: z.enum(['reply', 'forward']).default('reply'),
  /** Status after sending (default: unchanged). */
  status: MailConversationStatus.optional(),
});
export type MailInboxReply = z.infer<typeof MailInboxReply>;

export const MailCannedResponse = z.object({
  id: Id,
  inboxId: Id,
  title: z.string(),
  html: z.string(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type MailCannedResponse = z.infer<typeof MailCannedResponse>;

export const CreateMailCannedResponse = z.object({
  title: z.string().trim().min(1).max(120),
  html: z.string().min(1).max(200_000),
});
export type CreateMailCannedResponse = z.infer<typeof CreateMailCannedResponse>;

export const UpdateMailCannedResponse = CreateMailCannedResponse.partial();
export type UpdateMailCannedResponse = z.infer<typeof UpdateMailCannedResponse>;

export const MailInboxWsEvent = z.discriminatedUnion('type', [
  /** A conversation changed (new mail, status, assignee, note); null = the list in general. */
  z.object({
    type: z.literal('mail.inbox.changed'),
    inboxId: Id,
    conversationId: Id.nullable(),
  }),
  z.object({
    type: z.literal('mail.inbox.replying'),
    inboxId: Id,
    conversationId: Id,
    user: MailInboxPerson,
    active: z.boolean(),
  }),
]);
export type MailInboxWsEvent = z.infer<typeof MailInboxWsEvent>;
