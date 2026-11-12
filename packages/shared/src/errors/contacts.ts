/** Contacts module error codes; translations go to packages/i18n/src/locales/{tr,en}/errors/contacts.json. */
export const CONTACTS_ERROR_CODES = [
  'directory_field_synced',
  'directory_manager_cycle',
  'contacts_vcard_invalid',
  'directory_csv_invalid',
  'directory_person_unknown',
  'contacts_account_unavailable',
] as const;

export const CONTACTS_ERROR_STATUS: Record<(typeof CONTACTS_ERROR_CODES)[number], number> = {
  /** The field comes from AD/LDAP and changes there. */
  directory_field_synced: 409,
  /** The manager line would loop back to the person. */
  directory_manager_cycle: 422,
  /** The file is not vCard or holds no cards. */
  contacts_vcard_invalid: 422,
  /** The CSV has no e-mail column or no rows. */
  directory_csv_invalid: 422,
  /** No active org member has this e-mail (CSV import, manager column). */
  directory_person_unknown: 422,
  /** The connected account's address book does not sync (off, busy-only, or no permission yet). */
  contacts_account_unavailable: 409,
};
