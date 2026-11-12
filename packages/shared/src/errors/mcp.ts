/** Mcp module error codes; translations go to packages/i18n/src/locales/{tr,en}/errors/mcp.json. */
export const MCP_ERROR_CODES = [
  'mcp_disabled',
  'mcp_guests_not_allowed',
  'mcp_tokens_disabled',
  'mcp_reauth_required',
  'mcp_password_invalid',
  'mcp_consent_invalid',
  'mcp_client_pending',
  'mcp_client_blocked',
  'mcp_scope_not_allowed',
  'mcp_expiry_not_allowed',
  'mcp_approval_closed',
  'mcp_undo_unavailable',
  'mcp_undo_stale',
  'token_scope',
] as const;

export const MCP_ERROR_STATUS: Record<(typeof MCP_ERROR_CODES)[number], number> = {
  mcp_disabled: 403,
  mcp_guests_not_allowed: 403,
  mcp_tokens_disabled: 403,
  mcp_reauth_required: 403,
  mcp_password_invalid: 401,
  mcp_consent_invalid: 400,
  mcp_client_pending: 403,
  mcp_client_blocked: 403,
  mcp_scope_not_allowed: 403,
  mcp_expiry_not_allowed: 422,
  mcp_approval_closed: 409,
  mcp_undo_unavailable: 410,
  mcp_undo_stale: 409,
  token_scope: 403,
};
