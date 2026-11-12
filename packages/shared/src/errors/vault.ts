/** Vault module error codes; translations go to packages/i18n/src/locales/{tr,en}/errors/vault.json. */
export const VAULT_ERROR_CODES = [
  'vault_setup_required',
  'vault_already_set_up',
  'vault_unlock_failed',
  'vault_unlock_locked',
  'vault_revision_conflict',
  'vault_revision_current',
  'vault_key_version_mismatch',
  'vault_rotation_incomplete',
  'vault_member_without_keys',
  'vault_personal_not_shareable',
  'vault_last_manager',
  'vault_cannot_remove_self',
  'vault_attachment_too_large',
  'vault_share_disabled',
  'vault_share_gone',
  'vault_share_limit',
  'vault_breach_disabled',
  'vault_breach_unavailable',
] as const;

export const VAULT_ERROR_STATUS: Record<(typeof VAULT_ERROR_CODES)[number], number> = {
  vault_setup_required: 409,
  vault_already_set_up: 409,
  /** details.remaining: tries left before the wait. */
  vault_unlock_failed: 403,
  /** details.retryAfter: seconds. */
  vault_unlock_locked: 429,
  /** details.currentRevision: reload, merge and save again (design 8.8). */
  vault_revision_conflict: 409,
  /** Only kept revisions are deleted one by one; the current one goes with the item. */
  vault_revision_current: 409,
  /** details.keyVersion: the vault key was rotated meanwhile; reload the vault. */
  vault_key_version_mismatch: 409,
  /**
   * details: missing members / items / revisions in a rotation payload; `revisions` names the
   * first of the missing revisions as { itemId, revision }.
   */
  vault_rotation_incomplete: 422,
  vault_member_without_keys: 409,
  vault_personal_not_shareable: 403,
  vault_last_manager: 409,
  /** The device that rotates knows the new key; another manager has to remove this person. */
  vault_cannot_remove_self: 409,
  vault_attachment_too_large: 413,
  /** The org switched share links off (roadmap 20). */
  vault_share_disabled: 403,
  /** Expired, used up or revoked; the ciphertext is gone. */
  vault_share_gone: 410,
  /** details.maxHours / details.maxViews: above the org policy. */
  vault_share_limit: 422,
  /** The org switched the leaked password check off. */
  vault_breach_disabled: 403,
  /** The range API (or the org's mirror) did not answer. */
  vault_breach_unavailable: 503,
};
