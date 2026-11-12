/** AI module error codes; translations in packages/i18n/src/locales/{tr,en}/errors/ai.json. */
export const AI_ERROR_CODES = [
  'ai_disabled',
  'ai_not_configured',
  'ai_quota_exceeded',
  'ai_provider_error',
  'ai_refused',
  'ai_run_not_found',
  'ai_transcription_not_configured',
  'ai_recording_not_ready',
  'ai_action_unverified',
] as const;

export const AI_ERROR_STATUS: Record<(typeof AI_ERROR_CODES)[number], number> = {
  ai_disabled: 409,
  ai_not_configured: 409,
  ai_quota_exceeded: 429,
  ai_provider_error: 502,
  ai_refused: 422,
  ai_run_not_found: 404,
  ai_transcription_not_configured: 409,
  ai_recording_not_ready: 409,
  ai_action_unverified: 500,
};
