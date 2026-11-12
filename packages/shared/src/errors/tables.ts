/** Tables module error codes; translations go to packages/i18n/src/locales/{tr,en}/errors/tables.json. */
export const TABLES_ERROR_CODES = [
  'table_limit_reached',
  'table_field_invalid',
  'table_value_invalid',
  'table_primary_field',
  'table_last_view',
  'table_formula_invalid',
  'table_import_invalid',
] as const;

export const TABLES_ERROR_STATUS: Record<(typeof TABLES_ERROR_CODES)[number], number> = {
  table_limit_reached: 409,
  table_field_invalid: 422,
  table_value_invalid: 422,
  table_primary_field: 409,
  table_last_view: 409,
  table_formula_invalid: 422,
  table_import_invalid: 422,
};
