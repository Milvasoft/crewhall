/** Forms module error codes; translations go to packages/i18n/src/locales/{tr,en}/errors/forms.json. */
export const FORMS_ERROR_CODES = [
  'form_closed',
  'form_already_answered',
  'form_answers_invalid',
  'form_definition_invalid',
  'form_limit_reached',
  'form_file_too_large',
  'form_file_invalid',
  'form_destination_invalid',
] as const;

export const FORMS_ERROR_STATUS: Record<(typeof FORMS_ERROR_CODES)[number], number> = {
  form_closed: 409,
  form_already_answered: 409,
  form_answers_invalid: 422,
  form_definition_invalid: 422,
  form_limit_reached: 409,
  form_file_too_large: 413,
  form_file_invalid: 422,
  form_destination_invalid: 422,
};
