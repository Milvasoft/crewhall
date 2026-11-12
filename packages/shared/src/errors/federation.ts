/** Federation error codes; translations go to packages/i18n/src/locales/{tr,en}/errors/federation.json. */
export const FEDERATION_ERROR_CODES = [
  'federation_disabled',
  'federation_domain_not_allowed',
  'federation_domain_self',
  'federation_peer_unreachable',
  'federation_peer_not_active',
  'federation_user_not_found',
  'federation_signature_invalid',
  'federation_not_allowed',
  'federation_shared_channels_disabled',
  'federation_share_closed',
] as const;

export const FEDERATION_ERROR_STATUS: Record<(typeof FEDERATION_ERROR_CODES)[number], number> = {
  federation_disabled: 403,
  federation_domain_not_allowed: 403,
  federation_domain_self: 422,
  federation_peer_unreachable: 502,
  federation_peer_not_active: 409,
  federation_user_not_found: 404,
  federation_signature_invalid: 401,
  federation_not_allowed: 403,
  federation_shared_channels_disabled: 403,
  federation_share_closed: 409,
};
