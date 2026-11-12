/** Wiki module error codes; translations go to packages/i18n/src/locales/{tr,en}/errors/wiki.json. */
export const WIKI_ERROR_CODES = [
  'page_locked',
  'page_too_large',
  'collab_unavailable',
  'import_invalid',
  'page_task_changed',
] as const;

export const WIKI_ERROR_STATUS: Record<(typeof WIKI_ERROR_CODES)[number], number> = {
  page_locked: 423,
  page_too_large: 413,
  collab_unavailable: 503,
  import_invalid: 400,
  page_task_changed: 409,
};
