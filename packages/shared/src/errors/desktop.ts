/** Desktop release management error codes; translations in packages/i18n/src/locales/{tr,en}/errors/desktop.json. */
export const DESKTOP_ERROR_CODES = [
  'desktop_storage_missing',
  'desktop_file_invalid',
  'desktop_file_missing',
  'desktop_version_invalid',
  'desktop_release_in_use',
  'desktop_served_from_folder',
] as const;

export const DESKTOP_ERROR_STATUS: Record<(typeof DESKTOP_ERROR_CODES)[number], number> = {
  desktop_storage_missing: 409,
  desktop_file_invalid: 422,
  desktop_file_missing: 404,
  desktop_version_invalid: 422,
  desktop_release_in_use: 409,
  desktop_served_from_folder: 409,
};
