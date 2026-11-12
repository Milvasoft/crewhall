/**
 * Error codes returned in `ApiErrorBody.code`. Each code is also an i18n key
 * (`errors.<code>` in packages/i18n). Add new codes here first, then translations.
 */
import { PORTAL_ERROR_CODES, PORTAL_ERROR_STATUS } from './errors/portal';
import { MCP_ERROR_CODES, MCP_ERROR_STATUS } from './errors/mcp';
import { CHAT_ERROR_CODES, CHAT_ERROR_STATUS } from './errors/chat';
import { VAULT_ERROR_CODES, VAULT_ERROR_STATUS } from './errors/vault';
import { WIKI_ERROR_CODES, WIKI_ERROR_STATUS } from './errors/wiki';
import { MEET_ERROR_CODES, MEET_ERROR_STATUS } from './errors/meet';
import { BOARDS_ERROR_CODES, BOARDS_ERROR_STATUS } from './errors/boards';
import { IDENTITY_ERROR_CODES, IDENTITY_ERROR_STATUS } from './errors/identity';
import { FEDERATION_ERROR_CODES, FEDERATION_ERROR_STATUS } from './errors/federation';
import { PLUGINS_ERROR_CODES, PLUGINS_ERROR_STATUS } from './errors/plugins';
import { FORMS_ERROR_CODES, FORMS_ERROR_STATUS } from './errors/forms';
import { CALENDAR_ERROR_CODES, CALENDAR_ERROR_STATUS } from './errors/calendar';
import { CONTACTS_ERROR_CODES, CONTACTS_ERROR_STATUS } from './errors/contacts';
import { AUTOMATIONS_ERROR_CODES, AUTOMATIONS_ERROR_STATUS } from './errors/automations';
import { TABLES_ERROR_CODES, TABLES_ERROR_STATUS } from './errors/tables';
import { AI_ERROR_CODES, AI_ERROR_STATUS } from './errors/ai';
import { MAIL_ERROR_CODES, MAIL_ERROR_STATUS } from './errors/mail';
import { DELIVERY_ERROR_CODES, DELIVERY_ERROR_STATUS } from './errors/delivery';
import { DESKTOP_ERROR_CODES, DESKTOP_ERROR_STATUS } from './errors/desktop';
import { MICROSOFT_ERROR_CODES, MICROSOFT_ERROR_STATUS } from './errors/microsoft';
import { OFFICE_ERROR_CODES, OFFICE_ERROR_STATUS } from './errors/office';

const CORE_ERROR_CODES = [
  'bad_request',
  'validation_failed',
  'unauthenticated',
  'forbidden',
  'not_found',
  'conflict',
  'rate_limited',
  'internal',
  'setup_already_done',
  'setup_required',
  'two_factor_required',
  'org_slug_taken',
  'space_slug_taken',
  'member_not_found',
  'quick_card_not_movable',
  'cannot_change_owner',
  'invitation_expired',
  'quota_exceeded',
  'setup_token_invalid',
  'idempotency_key_reused',
  'client_outdated',
  'invitation_email_mismatch',
  'account_locked',
  'mobile_connect_invalid',
  'mobile_handoff_invalid',
  'oauth_handoff_invalid',
  'node_name_taken',
  'file_too_large',
  'invalid_target',
  'upload_invalid',
  /** A new version based on an older one than the file's current version (`baseVersion`). */
  'version_conflict',
  /** A Drive change-feed cursor too old to continue from: scan again. */
  'drive_changes_expired',
  'preview_unavailable',
  'share_expired',
  'share_password_required',
  'share_password_invalid',
  'share_locked',
  'not_implemented',
  'module_disabled',
  'image_invalid',
  'image_too_large',
] as const;

/** Core codes above; each module appends its own list from ./errors/<module>.ts. */
export const ERROR_CODES = [
  ...CORE_ERROR_CODES,
  ...PORTAL_ERROR_CODES,
  ...MCP_ERROR_CODES,
  ...CHAT_ERROR_CODES,
  ...VAULT_ERROR_CODES,
  ...WIKI_ERROR_CODES,
  ...MEET_ERROR_CODES,
  ...BOARDS_ERROR_CODES,
  ...IDENTITY_ERROR_CODES,
  ...FEDERATION_ERROR_CODES,
  ...PLUGINS_ERROR_CODES,
  ...FORMS_ERROR_CODES,
  ...CALENDAR_ERROR_CODES,
  ...CONTACTS_ERROR_CODES,
  ...AUTOMATIONS_ERROR_CODES,
  ...TABLES_ERROR_CODES,
  ...AI_ERROR_CODES,
  ...MAIL_ERROR_CODES,
  ...DELIVERY_ERROR_CODES,
  ...DESKTOP_ERROR_CODES,
  ...MICROSOFT_ERROR_CODES,
  ...OFFICE_ERROR_CODES,
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const CORE_ERROR_STATUS: Record<(typeof CORE_ERROR_CODES)[number], number> = {
  bad_request: 400,
  validation_failed: 422,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  internal: 500,
  setup_already_done: 409,
  setup_required: 409,
  two_factor_required: 403,
  org_slug_taken: 409,
  space_slug_taken: 409,
  member_not_found: 404,
  quick_card_not_movable: 409,
  cannot_change_owner: 403,
  invitation_expired: 410,
  quota_exceeded: 413,
  setup_token_invalid: 403,
  idempotency_key_reused: 422,
  client_outdated: 426,
  invitation_email_mismatch: 403,
  account_locked: 423,
  mobile_connect_invalid: 410,
  mobile_handoff_invalid: 400,
  oauth_handoff_invalid: 410,
  node_name_taken: 409,
  file_too_large: 413,
  invalid_target: 400,
  upload_invalid: 400,
  version_conflict: 409,
  drive_changes_expired: 410,
  preview_unavailable: 404,
  share_expired: 410,
  share_password_required: 401,
  share_password_invalid: 401,
  share_locked: 423,
  not_implemented: 501,
  module_disabled: 403,
  image_invalid: 422,
  image_too_large: 413,
};

export const HTTP_STATUS_BY_CODE: Record<ErrorCode, number> = {
  ...CORE_ERROR_STATUS,
  ...PORTAL_ERROR_STATUS,
  ...MCP_ERROR_STATUS,
  ...CHAT_ERROR_STATUS,
  ...VAULT_ERROR_STATUS,
  ...WIKI_ERROR_STATUS,
  ...MEET_ERROR_STATUS,
  ...BOARDS_ERROR_STATUS,
  ...IDENTITY_ERROR_STATUS,
  ...FEDERATION_ERROR_STATUS,
  ...PLUGINS_ERROR_STATUS,
  ...FORMS_ERROR_STATUS,
  ...CALENDAR_ERROR_STATUS,
  ...CONTACTS_ERROR_STATUS,
  ...AUTOMATIONS_ERROR_STATUS,
  ...TABLES_ERROR_STATUS,
  ...AI_ERROR_STATUS,
  ...MAIL_ERROR_STATUS,
  ...DELIVERY_ERROR_STATUS,
  ...DESKTOP_ERROR_STATUS,
  ...MICROSOFT_ERROR_STATUS,
  ...OFFICE_ERROR_STATUS,
};
