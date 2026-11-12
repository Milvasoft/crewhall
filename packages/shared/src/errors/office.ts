/** Office module error codes; translations in packages/i18n/src/locales/{tr,en}/errors/office.json. */
export const OFFICE_ERROR_CODES = ['office_unavailable', 'office_unsupported'] as const;

export const OFFICE_ERROR_STATUS: Record<(typeof OFFICE_ERROR_CODES)[number], number> = {
  /** Not set up, switched off, or the document server does not answer. */
  office_unavailable: 503,
  /** The document server cannot open this file type. */
  office_unsupported: 415,
};
