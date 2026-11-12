/** Portal module error codes; translations go to packages/i18n/src/locales/{tr,en}/errors/portal.json. */
export const PORTAL_ERROR_CODES = [
  'portal_site_slug_taken',
  'portal_slug_taken',
  'portal_version_exists',
  'portal_version_invalid',
  'portal_doc_conflict',
  'portal_nothing_to_publish',
  'portal_media_in_use',
  'portal_token_invalid',
  'portal_category_not_empty',
  'portal_locale_unsupported',
  'portal_translation_source_missing',
  'portal_redirect_loop',
] as const;

export const PORTAL_ERROR_STATUS: Record<(typeof PORTAL_ERROR_CODES)[number], number> = {
  portal_site_slug_taken: 409,
  portal_slug_taken: 409,
  portal_version_exists: 409,
  portal_version_invalid: 400,
  portal_doc_conflict: 409,
  portal_nothing_to_publish: 400,
  portal_media_in_use: 409,
  portal_token_invalid: 401,
  portal_category_not_empty: 409,
  portal_locale_unsupported: 400,
  portal_translation_source_missing: 400,
  portal_redirect_loop: 400,
};
