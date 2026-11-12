/** Microsoft integrations error codes; translations in packages/i18n/src/locales/{tr,en}/errors/microsoft.json. */
export const MICROSOFT_ERROR_CODES = [
  'integration_disabled',
  'microsoft_app_missing',
  'microsoft_graph_failed',
  'microsoft_permission_missing',
  'mount_unreachable',
  'mount_read_only',
  'mount_item_not_found',
  'upload_request_closed',
  'teams_link_invalid',
  'sso_blocked_by_policy',
] as const;

export const MICROSOFT_ERROR_STATUS: Record<(typeof MICROSOFT_ERROR_CODES)[number], number> = {
  integration_disabled: 403,
  microsoft_app_missing: 409,
  microsoft_graph_failed: 502,
  microsoft_permission_missing: 403,
  mount_unreachable: 502,
  mount_read_only: 403,
  mount_item_not_found: 404,
  upload_request_closed: 410,
  teams_link_invalid: 400,
  sso_blocked_by_policy: 403,
};
