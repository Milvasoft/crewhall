import { z } from 'zod';
import { Empty, def, items, type EndpointDef } from '../endpoint-def';
import { page } from '../schemas/common';
import {
  ConnectMailAccount,
  MailAccount,
  MailAccountState,
  MailDeleteMessages,
  MailBulkJob,
  MailDeleteResult,
  MailFolder,
  MailMessage,
  MailMessageQuery,
  MailMessageSummary,
  MailMessagesQuery,
  MailMoveMessages,
  MailRecipientSuggestion,
  MailRecipientsQuery,
  MailSaveAttachment,
  MailSavedAttachment,
  MailSend,
  MailSendResult,
  MailServerSettings,
  MailServerTestResult,
  MailThreadQuery,
  MailUpdateFlags,
  StartMailBulk,
  TestMailServer,
  UpdateMailAccount,
  UpdateMailServerSettings,
} from '../schemas/mail';
import {
  AddMailConversationNote,
  CreateMailCannedResponse,
  CreateMailInbox,
  MailCannedResponse,
  MailConversation,
  MailConversationNote,
  MailConversationQuery,
  MailConversationReplying,
  MailConversationSummary,
  MailConversationsQuery,
  MailInbox,
  MailInboxReply,
  UpdateMailCannedResponse,
  UpdateMailConversation,
  UpdateMailInbox,
} from '../schemas/mail-inbox';

/**
 * Mail module contract (roadmap 24). Only the mail session edits this file. Every call talks to
 * the org's IMAP/SMTP server live with the caller's own credentials; mail is not copied into
 * Crewhall. Endpoint names start with `mail` to stay unique across modules.
 */
export const mailEndpoints = {
  /* ------------------------------ administration ------------------------------ */

  /** Yönetim › Posta (owner/admin, `org.update_settings`). */
  mailServerSettings: def({
    method: 'GET',
    path: '/api/v1/mail/admin/settings',
    auth: 'session',
    response: MailServerSettings,
  }),
  mailUpdateServerSettings: def({
    method: 'PUT',
    path: '/api/v1/mail/admin/settings',
    auth: 'session',
    body: UpdateMailServerSettings,
    response: MailServerSettings,
  }),
  /** Probes IMAP and SMTP with the given settings; never saves anything. */
  mailTestServer: def({
    method: 'POST',
    path: '/api/v1/mail/admin/test',
    auth: 'session',
    body: TestMailServer,
    response: MailServerTestResult,
  }),

  /* --------------------------------- account ---------------------------------- */

  /** Server summary and the caller's account (null until connected). */
  mailAccount: def({
    method: 'GET',
    path: '/api/v1/mail/account',
    auth: 'session',
    response: MailAccountState,
  }),
  /** App password sign-in; 422 mail_auth_failed when IMAP refuses it. OAuth2 uses MAIL_RAW_PATHS. */
  mailConnectAccount: def({
    method: 'POST',
    path: '/api/v1/mail/account',
    auth: 'session',
    body: ConnectMailAccount,
    response: MailAccount,
  }),
  mailUpdateAccount: def({
    method: 'PATCH',
    path: '/api/v1/mail/account',
    auth: 'session',
    body: UpdateMailAccount,
    response: MailAccount,
  }),
  /** Forgets the credentials; mail on the server is untouched. */
  mailDisconnectAccount: def({
    method: 'DELETE',
    path: '/api/v1/mail/account',
    auth: 'session',
    response: Empty,
  }),

  /* ----------------------------- folders, messages ---------------------------- */

  mailFolders: def({
    method: 'GET',
    path: '/api/v1/mail/folders',
    auth: 'session',
    response: items(MailFolder),
  }),
  mailMessages: def({
    method: 'GET',
    path: '/api/v1/mail/messages',
    auth: 'session',
    query: MailMessagesQuery,
    response: page(MailMessageSummary),
  }),
  mailMessage: def({
    method: 'GET',
    path: '/api/v1/mail/message',
    auth: 'session',
    query: MailMessageQuery,
    response: MailMessage,
  }),
  /** Oldest first; the asked message is always included. At most 25 messages. */
  mailThread: def({
    method: 'GET',
    path: '/api/v1/mail/thread',
    auth: 'session',
    query: MailThreadQuery,
    response: items(MailMessage),
  }),
  mailUpdateFlags: def({
    method: 'POST',
    path: '/api/v1/mail/messages/flags',
    auth: 'session',
    body: MailUpdateFlags,
    response: Empty,
  }),
  mailMoveMessages: def({
    method: 'POST',
    path: '/api/v1/mail/messages/move',
    auth: 'session',
    body: MailMoveMessages,
    response: Empty,
  }),
  mailDeleteMessages: def({
    method: 'POST',
    path: '/api/v1/mail/messages/delete',
    auth: 'session',
    body: MailDeleteMessages,
    response: MailDeleteResult,
  }),
  /**
   * Whole-folder read / unread / move / delete as a background job (chunks of 500 UIDs). A job
   * already running for the same folder and action is returned instead of a second one.
   */
  mailStartBulk: def({
    method: 'POST',
    path: '/api/v1/mail/bulk',
    auth: 'session',
    body: StartMailBulk,
    response: MailBulkJob,
  }),
  /** Progress of the caller's own job. */
  mailBulkJob: def({
    method: 'GET',
    path: '/api/v1/mail/bulk/:jobId',
    auth: 'session',
    response: MailBulkJob,
  }),

  /* ---------------------------------- sending --------------------------------- */

  /** Sends over SMTP and appends a copy to Sent (MailServerSettings.saveSentCopy). */
  mailSend: def({
    method: 'POST',
    path: '/api/v1/mail/send',
    auth: 'session',
    body: MailSend,
    response: MailSendResult,
  }),

  /* ------------------------------ Drive, people ------------------------------- */

  /** Saves an attachment as a Drive file (needs edit rights in the target space). */
  mailSaveAttachment: def({
    method: 'POST',
    path: '/api/v1/mail/attachments/save',
    auth: 'session',
    body: MailSaveAttachment,
    response: MailSavedAttachment,
  }),
  /** Recipient autocomplete: recent recipients, the org directory (and contacts when present). */
  mailRecipients: def({
    method: 'GET',
    path: '/api/v1/mail/recipients',
    auth: 'session',
    query: MailRecipientsQuery,
    response: items(MailRecipientSuggestion),
  }),
  /* ------------------------------ shared inboxes ------------------------------ */

  /** Shared inboxes of the caller's spaces (sonraki-isler.md "Ortak gelen kutusu"). */
  mailInboxes: def({
    method: 'GET',
    path: '/api/v1/mail/inboxes',
    auth: 'session',
    response: items(MailInbox),
  }),
  /** Space admins; the password is checked on IMAP first. 409 mail_inbox_exists. */
  mailCreateInbox: def({
    method: 'POST',
    path: '/api/v1/mail/inboxes',
    auth: 'session',
    body: CreateMailInbox,
    response: MailInbox,
  }),
  mailUpdateInbox: def({
    method: 'PATCH',
    path: '/api/v1/mail/inboxes/:inboxId',
    auth: 'session',
    body: UpdateMailInbox,
    response: MailInbox,
  }),
  /** Removes the inbox with its conversations, notes and canned responses (mail stays on the server). */
  mailDeleteInbox: def({
    method: 'DELETE',
    path: '/api/v1/mail/inboxes/:inboxId',
    auth: 'session',
    response: Empty,
  }),
  /** Newest activity first; cursor = the previous page's last item. */
  mailInboxConversations: def({
    method: 'GET',
    path: '/api/v1/mail/inboxes/:inboxId/conversations',
    auth: 'session',
    query: MailConversationsQuery,
    response: page(MailConversationSummary),
  }),
  /** The thread, notes and who is replying; opening marks the messages read (editors). */
  mailInboxConversation: def({
    method: 'GET',
    path: '/api/v1/mail/inboxes/:inboxId/conversations/:conversationId',
    auth: 'session',
    query: MailConversationQuery,
    response: MailConversation,
  }),
  mailUpdateInboxConversation: def({
    method: 'PATCH',
    path: '/api/v1/mail/inboxes/:inboxId/conversations/:conversationId',
    auth: 'session',
    body: UpdateMailConversation,
    response: MailConversationSummary,
  }),
  mailAddInboxNote: def({
    method: 'POST',
    path: '/api/v1/mail/inboxes/:inboxId/conversations/:conversationId/notes',
    auth: 'session',
    body: AddMailConversationNote,
    response: MailConversationNote,
  }),
  /** The author or a space admin. */
  mailDeleteInboxNote: def({
    method: 'DELETE',
    path: '/api/v1/mail/inboxes/:inboxId/conversations/:conversationId/notes/:noteId',
    auth: 'session',
    response: Empty,
  }),
  /** "Replying now": a heartbeat every few seconds while composing, `active: false` at the end. */
  mailInboxReplying: def({
    method: 'POST',
    path: '/api/v1/mail/inboxes/:inboxId/conversations/:conversationId/replying',
    auth: 'session',
    body: MailConversationReplying,
    response: Empty,
  }),
  /** Sends from the inbox's address, threaded on the conversation's last incoming message. */
  mailInboxReply: def({
    method: 'POST',
    path: '/api/v1/mail/inboxes/:inboxId/conversations/:conversationId/reply',
    auth: 'session',
    body: MailInboxReply,
    response: MailSendResult,
  }),
  mailInboxTags: def({
    method: 'GET',
    path: '/api/v1/mail/inboxes/:inboxId/tags',
    auth: 'session',
    response: items(z.string()),
  }),
  mailCannedResponses: def({
    method: 'GET',
    path: '/api/v1/mail/inboxes/:inboxId/canned',
    auth: 'session',
    response: items(MailCannedResponse),
  }),
  mailCreateCannedResponse: def({
    method: 'POST',
    path: '/api/v1/mail/inboxes/:inboxId/canned',
    auth: 'session',
    body: CreateMailCannedResponse,
    response: MailCannedResponse,
  }),
  mailUpdateCannedResponse: def({
    method: 'PATCH',
    path: '/api/v1/mail/inboxes/:inboxId/canned/:cannedId',
    auth: 'session',
    body: UpdateMailCannedResponse,
    response: MailCannedResponse,
  }),
  mailDeleteCannedResponse: def({
    method: 'DELETE',
    path: '/api/v1/mail/inboxes/:inboxId/canned/:cannedId',
    auth: 'session',
    response: Empty,
  }),
} as const satisfies Record<string, EndpointDef>;
