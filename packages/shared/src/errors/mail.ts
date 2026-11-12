/** Mail module error codes; translations in packages/i18n/src/locales/{tr,en}/errors/mail.json. */
export const MAIL_ERROR_CODES = [
  'mail_not_configured',
  'mail_account_required',
  'mail_auth_mode_mismatch',
  'mail_auth_failed',
  'mail_server_unreachable',
  'mail_folder_not_found',
  'mail_message_not_found',
  'mail_attachment_not_found',
  'mail_attachments_too_large',
  'mail_recipients_required',
  'mail_send_failed',
  'mail_oauth_failed',
  'mail_remote_images_disabled',
  // Shared inbox
  'mail_inbox_exists',
  'mail_inbox_assignee_invalid',
] as const;

/** mail_auth_failed is 422, not 401: a refused mailbox password must not sign the user out. */
export const MAIL_ERROR_STATUS: Record<(typeof MAIL_ERROR_CODES)[number], number> = {
  mail_not_configured: 409,
  mail_account_required: 409,
  mail_auth_mode_mismatch: 409,
  mail_auth_failed: 422,
  mail_server_unreachable: 502,
  mail_folder_not_found: 404,
  mail_message_not_found: 404,
  mail_attachment_not_found: 404,
  mail_attachments_too_large: 413,
  mail_recipients_required: 422,
  mail_send_failed: 502,
  mail_oauth_failed: 400,
  mail_remote_images_disabled: 403,
  mail_inbox_exists: 409,
  mail_inbox_assignee_invalid: 422,
};
