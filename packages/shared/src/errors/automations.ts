/** Automations module error codes; translations go to packages/i18n/src/locales/{tr,en}/errors/automations.json. */
export const AUTOMATIONS_ERROR_CODES = [
  'automation_trigger_unknown',
  'automation_action_unknown',
  'automation_config_invalid',
  'automation_target_invalid',
  'automation_limit_reached',
  'automation_webhook_blocked',
  'automation_webhook_failed',
  'automation_owner_inactive',
] as const;

export const AUTOMATIONS_ERROR_STATUS: Record<(typeof AUTOMATIONS_ERROR_CODES)[number], number> = {
  automation_trigger_unknown: 422,
  automation_action_unknown: 422,
  automation_config_invalid: 422,
  automation_target_invalid: 422,
  automation_limit_reached: 409,
  automation_webhook_blocked: 422,
  automation_webhook_failed: 502,
  automation_owner_inactive: 409,
};
