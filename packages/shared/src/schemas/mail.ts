import { z } from 'zod';
import { Id, PageQuery, Timestamp } from './common';

/**
 * Mail module (roadmap 24): a webmail client on top of the org's own mail server (IMAP + SMTP).
 * Crewhall does not host mail. Messages stay on the server; Crewhall only stores the server
 * settings, each user's encrypted credentials and a short list of recent recipients.
 *
 * A message is addressed by its folder path and IMAP UID. UIDs are stable while the folder's
 * UIDVALIDITY stays the same, which is the case on every common server.
 */

// ---------------------------------------------------------------------------------------
// Paths outside the contract table (downloads and the OAuth redirect)
// ---------------------------------------------------------------------------------------

export const MAIL_RAW_PATHS = {
  /**
   * GET, browser navigation: an attachment of a message. Query `folder`, `uid`, `part`
   * (MailAttachment.part) and optional `inline=1` (Content-Disposition inline, images only);
   * `inboxId` reads a shared inbox's message (its space's members only).
   */
  attachment: '/api/mail/attachment',
  /** GET, browser navigation: starts OAuth2 for the active org's provider; ends on `/mail`. */
  oauthStart: '/api/mail/oauth/start',
  /**
   * GET, browser navigation: signs a shared inbox in with OAuth2 (`?inboxId=`, space admins).
   * Microsoft 365: the admin's token opens the shared mailbox they have Full Access to. Ends on
   * `/mail/inbox/<id>`. Same callback as `oauthStart`.
   */
  inboxOauthStart: '/api/mail/inbox-oauth/start',
  /** OAuth2 redirect URI to register at Microsoft Entra or Google Cloud. */
  oauthCallback: '/api/mail/oauth/callback',
} as const;

/** Largest total size of the files attached to one outgoing message. */
export const MAIL_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

// ---------------------------------------------------------------------------------------
// Server settings (Yönetim › Posta)
// ---------------------------------------------------------------------------------------

/** `tls`: implicit TLS (993 / 465); `starttls`: upgrade on 143 / 587; `none`: test servers only. */
export const MailSecurity = z.enum(['tls', 'starttls', 'none']);
export type MailSecurity = z.infer<typeof MailSecurity>;

/**
 * How users sign in to the mail server: an app password per user, or OAuth2 with Microsoft 365
 * or Google Workspace (XOAUTH2 on IMAP and SMTP).
 */
export const MailAuthMode = z.enum(['password', 'oauth_microsoft', 'oauth_google']);
export type MailAuthMode = z.infer<typeof MailAuthMode>;

/** Login name sent to the server: the full address or only its local part (before @). */
export const MailUsernameFormat = z.enum(['email', 'local']);
export type MailUsernameFormat = z.infer<typeof MailUsernameFormat>;

const Host = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(/^[A-Za-z0-9.-]+$|^\[[0-9a-fA-F:]+\]$/);
const Port = z.number().int().min(1).max(65535);

export const MailServerSettings = z.object({
  /** False until an admin saved the settings once; the module then only shows a notice. */
  configured: z.boolean(),
  imapHost: z.string(),
  imapPort: Port,
  imapSecurity: MailSecurity,
  smtpHost: z.string(),
  smtpPort: Port,
  smtpSecurity: MailSecurity,
  authMode: MailAuthMode,
  usernameFormat: MailUsernameFormat,
  /** Only for OAuth2: the app registered at Microsoft Entra / Google Cloud. */
  oauthClientId: z.string().nullable(),
  /** The client secret is never returned; this says whether one is stored. */
  hasOauthClientSecret: z.boolean(),
  /** Microsoft only: tenant id or domain; `organizations` when empty. */
  oauthTenant: z.string().nullable(),
  /** Redirect URI to register at the provider (MAIL_RAW_PATHS.oauthCallback on the api URL). */
  oauthRedirectUri: z.string(),
  /**
   * Append a copy of every sent message to the Sent folder. Microsoft 365 and Gmail do this
   * themselves on SMTP, so turn it off there to avoid duplicates.
   */
  saveSentCopy: z.boolean(),
  /** Whether users may load remote images in a message at all (they are always off by default). */
  allowRemoteImages: z.boolean(),
  /** New-mail check interval of the worker, in minutes. */
  pollMinutes: z.number().int().min(1).max(60),
  updatedAt: Timestamp.nullable(),
});
export type MailServerSettings = z.infer<typeof MailServerSettings>;

export const UpdateMailServerSettings = z.object({
  imapHost: Host,
  imapPort: Port,
  imapSecurity: MailSecurity,
  smtpHost: Host,
  smtpPort: Port,
  smtpSecurity: MailSecurity,
  authMode: MailAuthMode,
  usernameFormat: MailUsernameFormat.default('email'),
  oauthClientId: z.string().trim().max(500).nullable().optional(),
  /** Absent keeps the stored secret, null removes it. */
  oauthClientSecret: z.string().max(2000).nullable().optional(),
  oauthTenant: z.string().trim().max(200).nullable().optional(),
  saveSentCopy: z.boolean().default(true),
  allowRemoteImages: z.boolean().default(true),
  pollMinutes: z.number().int().min(1).max(60).default(5),
});
export type UpdateMailServerSettings = z.infer<typeof UpdateMailServerSettings>;

/**
 * Connection test from the settings form. Without credentials it only checks that the
 * servers answer (greeting / EHLO); with them it also signs in.
 */
export const TestMailServer = z.object({
  imapHost: Host,
  imapPort: Port,
  imapSecurity: MailSecurity,
  smtpHost: Host,
  smtpPort: Port,
  smtpSecurity: MailSecurity,
  username: z.string().max(320).optional(),
  password: z.string().max(1000).optional(),
});
export type TestMailServer = z.infer<typeof TestMailServer>;

export const MailProbeResult = z.object({
  ok: z.boolean(),
  /** An `errors.*` code when not ok (mail_server_unreachable, mail_auth_failed). */
  error: z.string().nullable(),
  /** Server error text for the admin, never shown to other users. */
  detail: z.string().nullable(),
});
export type MailProbeResult = z.infer<typeof MailProbeResult>;

export const MailServerTestResult = z.object({ imap: MailProbeResult, smtp: MailProbeResult });
export type MailServerTestResult = z.infer<typeof MailServerTestResult>;

// ---------------------------------------------------------------------------------------
// The user's account
// ---------------------------------------------------------------------------------------

export const MailAccountStatus = z.enum(['ok', 'auth_failed', 'unreachable']);
export type MailAccountStatus = z.infer<typeof MailAccountStatus>;

export const MailAccount = z.object({
  id: Id,
  email: z.email(),
  /** Name in the From header; the profile name when empty. */
  displayName: z.string(),
  username: z.string(),
  authMode: MailAuthMode,
  status: MailAccountStatus,
  /** Sanitized HTML appended to new messages, replies and forwards. */
  signatureHtml: z.string(),
  /** New-mail notifications (in-app and push). */
  notify: z.boolean(),
  lastCheckedAt: Timestamp.nullable(),
  createdAt: Timestamp,
});
export type MailAccount = z.infer<typeof MailAccount>;

export const MailAccountState = z.object({
  server: z.object({
    configured: z.boolean(),
    authMode: MailAuthMode,
    allowRemoteImages: z.boolean(),
    maxAttachmentBytes: z.number().int(),
  }),
  account: MailAccount.nullable(),
});
export type MailAccountState = z.infer<typeof MailAccountState>;

/** App password sign-in (authMode = password). The server checks it on IMAP before saving. */
export const ConnectMailAccount = z.object({
  email: z.email().max(320),
  /** Defaults to the e-mail or its local part, per MailServerSettings.usernameFormat. */
  username: z.string().trim().min(1).max(320).optional(),
  password: z.string().min(1).max(1000),
  displayName: z.string().trim().max(200).optional(),
});
export type ConnectMailAccount = z.infer<typeof ConnectMailAccount>;

export const SIGNATURE_MAX_CHARS = 20_000;

export const UpdateMailAccount = z.object({
  displayName: z.string().trim().max(200).optional(),
  signatureHtml: z.string().max(SIGNATURE_MAX_CHARS).optional(),
  notify: z.boolean().optional(),
  /** Replaces the stored app password (checked on IMAP first). */
  password: z.string().min(1).max(1000).optional(),
});
export type UpdateMailAccount = z.infer<typeof UpdateMailAccount>;

// ---------------------------------------------------------------------------------------
// Folders and messages
// ---------------------------------------------------------------------------------------

export const MailSpecialUse = z.enum(['inbox', 'sent', 'drafts', 'trash', 'junk', 'archive']);
export type MailSpecialUse = z.infer<typeof MailSpecialUse>;

export const MailFolder = z.object({
  /** Full IMAP path (the id of the folder), e.g. `INBOX` or `INBOX/Projects`. */
  path: z.string(),
  /** Last path segment, decoded. */
  name: z.string(),
  parent: z.string().nullable(),
  delimiter: z.string().nullable(),
  specialUse: MailSpecialUse.nullable(),
  total: z.number().int(),
  unread: z.number().int(),
});
export type MailFolder = z.infer<typeof MailFolder>;

const FolderPath = z.string().min(1).max(1000);
const Uid = z.coerce.number().int().min(1);

export const MailAddress = z.object({
  name: z.string().nullable(),
  address: z.string(),
});
export type MailAddress = z.infer<typeof MailAddress>;

export const MailMessageSummary = z.object({
  folder: z.string(),
  uid: z.number().int(),
  messageId: z.string().nullable(),
  /**
   * Conversation key: the first Message-ID in References (or In-Reply-To, or the message's own
   * Message-ID). Messages of one conversation share it across folders.
   */
  threadId: z.string(),
  subject: z.string(),
  from: MailAddress.nullable(),
  to: z.array(MailAddress),
  date: Timestamp.nullable(),
  seen: z.boolean(),
  flagged: z.boolean(),
  answered: z.boolean(),
  hasAttachments: z.boolean(),
  size: z.number().int(),
});
export type MailMessageSummary = z.infer<typeof MailMessageSummary>;

/**
 * Newest first. `cursor` is the smallest UID of the previous page. `q` runs IMAP SEARCH on
 * subject, sender, recipients and body (`TEXT`).
 */
export const MailMessagesQuery = PageQuery.extend({
  folder: FolderPath.default('INBOX'),
  q: z.string().trim().max(200).optional(),
  /**
   * With `q`: `headers` answers at once from Crewhall's header cache (subject, sender,
   * recipients); `all` (default) also runs the server's full-text search over the bodies.
   */
  scope: z.enum(['headers', 'all']).default('all'),
  unread: z.stringbool().optional(),
  flagged: z.stringbool().optional(),
});
export type MailMessagesQuery = z.infer<typeof MailMessagesQuery>;

export const MailAttachment = z.object({
  /** MIME part number, e.g. `2` or `1.2`; the id for downloads and saving to Drive. */
  part: z.string(),
  filename: z.string(),
  contentType: z.string(),
  size: z.number().int(),
  /** Shown inside the HTML body (cid:) rather than as a file. */
  inline: z.boolean(),
});
export type MailAttachment = z.infer<typeof MailAttachment>;

export const MailMessage = MailMessageSummary.extend({
  cc: z.array(MailAddress),
  bcc: z.array(MailAddress),
  replyTo: z.array(MailAddress),
  inReplyTo: z.string().nullable(),
  references: z.array(z.string()),
  /**
   * Sanitized HTML: no scripts, forms, frames, event handlers or remote fonts; inline `cid:`
   * images are embedded as data URIs; remote images are removed unless `remoteImages` was
   * asked for. Clients still render it in a sandboxed iframe without scripts.
   */
  html: z.string().nullable(),
  text: z.string().nullable(),
  attachments: z.array(MailAttachment),
  /** Remote images removed from `html`; the "show images" button appears when > 0. */
  blockedImages: z.number().int(),
});
export type MailMessage = z.infer<typeof MailMessage>;

export const MailMessageQuery = z.object({
  folder: FolderPath,
  uid: Uid,
  remoteImages: z.stringbool().default(false),
  /** Opening a message marks it read unless this is false. */
  markSeen: z.stringbool().default(true),
});
export type MailMessageQuery = z.infer<typeof MailMessageQuery>;

/**
 * The conversation of a message: every message with its threadId in this folder and in Sent.
 * Unread messages of the conversation in `folder` are marked read unless `markSeen` is false.
 */
export const MailThreadQuery = z.object({
  folder: FolderPath,
  uid: Uid,
  remoteImages: z.stringbool().default(false),
  markSeen: z.stringbool().default(true),
});
export type MailThreadQuery = z.infer<typeof MailThreadQuery>;

const Uids = z.array(z.number().int().min(1)).min(1).max(500);

export const MailUpdateFlags = z.object({
  folder: FolderPath,
  uids: Uids,
  seen: z.boolean().optional(),
  flagged: z.boolean().optional(),
});
export type MailUpdateFlags = z.infer<typeof MailUpdateFlags>;

export const MailMoveMessages = z.object({
  folder: FolderPath,
  uids: Uids,
  target: FolderPath,
});
export type MailMoveMessages = z.infer<typeof MailMoveMessages>;

/** Moves to Trash; messages already in Trash are deleted for good. */
export const MailDeleteMessages = z.object({ folder: FolderPath, uids: Uids });
export type MailDeleteMessages = z.infer<typeof MailDeleteMessages>;
export const MailDeleteResult = z.object({ permanent: z.boolean() });
export type MailDeleteResult = z.infer<typeof MailDeleteResult>;

/**
 * Folder-wide change ("Tümünü okundu işaretle", or "select all N messages" in the list). It runs
 * as a background job in chunks of 500 UIDs, so a folder of any size finishes without holding
 * a request open; clients poll `mailBulkJob` for progress.
 */
export const MailBulkAction = z.enum(['seen', 'unseen', 'move', 'delete']);
export type MailBulkAction = z.infer<typeof MailBulkAction>;

export const MAIL_BULK_CHUNK = 500;

export const StartMailBulk = z
  .object({
    folder: FolderPath,
    action: MailBulkAction,
    /** Destination folder of `move`. */
    target: FolderPath.optional(),
  })
  .refine((b) => b.action !== 'move' || Boolean(b.target), {
    message: 'move needs a target',
    path: ['target'],
  });
export type StartMailBulk = z.input<typeof StartMailBulk>;

export const MailBulkStatus = z.enum(['queued', 'running', 'done', 'failed']);
export type MailBulkStatus = z.infer<typeof MailBulkStatus>;

export const MailBulkJob = z.object({
  id: Id,
  folder: z.string(),
  action: MailBulkAction,
  target: z.string().nullable(),
  status: MailBulkStatus,
  /** Messages the job touches; null until the folder was searched. */
  total: z.number().int().nullable(),
  /** Messages changed so far. */
  done: z.number().int(),
  /** An `errors.*` code when failed. */
  error: z.string().nullable(),
  createdAt: Timestamp,
  finishedAt: Timestamp.nullable(),
});
export type MailBulkJob = z.infer<typeof MailBulkJob>;

// ---------------------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------------------

const Recipient = z.object({
  name: z.string().trim().max(200).nullable().optional(),
  address: z.email().max(320),
});

export const MailOutgoingAttachment = z.discriminatedUnion('kind', [
  /** A Drive file the sender can view (its current version). */
  z.object({ kind: z.literal('drive'), nodeId: Id }),
  /** An attachment of an existing message (forwarding). */
  z.object({
    kind: z.literal('message'),
    folder: FolderPath,
    uid: z.number().int().min(1),
    part: z.string().max(50),
  }),
  /** A local file sent inline as base64. */
  z.object({
    kind: z.literal('upload'),
    filename: z.string().trim().min(1).max(255),
    contentType: z.string().max(200).default('application/octet-stream'),
    data: z.string().max(Math.ceil((MAIL_MAX_ATTACHMENT_BYTES * 4) / 3) + 4),
  }),
]);
export type MailOutgoingAttachment = z.infer<typeof MailOutgoingAttachment>;

export const MailSend = z.object({
  to: z.array(Recipient).max(100).default([]),
  cc: z.array(Recipient).max(100).default([]),
  bcc: z.array(Recipient).max(100).default([]),
  subject: z.string().max(998).default(''),
  /** Body from the editor (the signature already inside); the server sanitizes it again. */
  html: z.string().max(2_000_000),
  /** Plain text alternative; derived from `html` when absent. */
  text: z.string().max(2_000_000).optional(),
  /** Reply or forward: threads the message (In-Reply-To, References) and flags the original. */
  source: z
    .object({
      folder: FolderPath,
      uid: z.number().int().min(1),
      mode: z.enum(['reply', 'forward']),
    })
    .optional(),
  attachments: z.array(MailOutgoingAttachment).max(20).default([]),
});
export type MailSend = z.infer<typeof MailSend>;

export const MailSendResult = z.object({
  messageId: z.string(),
  /** False when the copy could not be appended to Sent (the message itself was sent). */
  savedToSent: z.boolean(),
});
export type MailSendResult = z.infer<typeof MailSendResult>;

// ---------------------------------------------------------------------------------------
// Drive and autocomplete
// ---------------------------------------------------------------------------------------

export const MailSaveAttachment = z.object({
  /** A shared inbox's message (absent: the caller's own mailbox). */
  inboxId: Id.optional(),
  folder: FolderPath,
  uid: z.number().int().min(1),
  part: z.string().max(50),
  /** Defaults to the user's personal space, in an "E-posta ekleri" folder. */
  spaceId: Id.optional(),
  parentId: Id.nullable().optional(),
});
export type MailSaveAttachment = z.infer<typeof MailSaveAttachment>;

export const MailSavedAttachment = z.object({
  nodeId: Id,
  spaceId: Id,
  name: z.string(),
});
export type MailSavedAttachment = z.infer<typeof MailSavedAttachment>;

export const MailRecipientsQuery = z.object({
  q: z.string().trim().max(200).default(''),
  limit: z.coerce.number().int().min(1).max(20).default(8),
});
export type MailRecipientsQuery = z.infer<typeof MailRecipientsQuery>;

export const MailRecipientSuggestion = z.object({
  name: z.string().nullable(),
  address: z.string(),
  /** `member`: org directory, `recent`: someone this user wrote to, `contact`: contacts module. */
  source: z.enum(['member', 'recent', 'contact']),
});
export type MailRecipientSuggestion = z.infer<typeof MailRecipientSuggestion>;

/**
 * Over the WebSocket (WsServerEvent): the folder changed on the server (new mail, flags, moved or
 * deleted messages), noticed by IMAP IDLE or a background sync. Clients refresh that folder's
 * list and the folder counters.
 */
export const MailWsEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('mail.changed'), folder: z.string() }),
]);
export type MailWsEvent = z.infer<typeof MailWsEvent>;
