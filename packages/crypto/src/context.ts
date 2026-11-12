/**
 * Domain separation. Every HKDF `info` and every AES-GCM associated-data string is built
 * here, so web and mobile bind ciphertexts to exactly the same context (doc 17 §7:
 * "AAD şifreli içeriği item_id ve vault_id'ye bağlar").
 *
 * Changing any string breaks every existing ciphertext: add a v2 instead.
 */

export const PROTOCOL = 'crewhall/vault/v1';

export type UnlockMethod = 'password' | 'recovery' | 'passkey_prf' | 'device';

export const info = {
  /** Master key (Argon2id output) → key-encryption key for the private key. */
  kek: `${PROTOCOL}/kek`,
  /** Master key → value the server checks before releasing the wrapped key. */
  auth: `${PROTOCOL}/auth`,
  recoveryKek: `${PROTOCOL}/recovery-kek`,
  recoveryAuth: `${PROTOCOL}/recovery-auth`,
  /** Passkey PRF output or device secret → KEK / server check value. */
  unlockKek: `${PROTOCOL}/unlock-kek`,
  unlockAuth: `${PROTOCOL}/unlock-auth`,
  /** X25519 shared secret → sealing key. */
  seal: `${PROTOCOL}/seal`,
  /** Private key → key for the encrypted account settings. */
  settings: `${PROTOCOL}/settings`,
  fingerprint: `${PROTOCOL}/fingerprint`,
  recoveryChecksum: `${PROTOCOL}/recovery-checksum`,
} as const;

export const aad = {
  privateKey: (userId: string, method: UnlockMethod) =>
    `${PROTOCOL}/private-key|${userId}|${method}`,
  vaultKey: (vaultId: string, keyVersion: number, userId: string) =>
    `${PROTOCOL}/vault-key|${vaultId}|${keyVersion}|${userId}`,
  itemKey: (vaultId: string, itemId: string, revision: number, keyVersion: number) =>
    `${PROTOCOL}/item-key|${vaultId}|${itemId}|${revision}|${keyVersion}`,
  item: (vaultId: string, itemId: string, revision: number, type: string) =>
    `${PROTOCOL}/item|${vaultId}|${itemId}|${revision}|${type}`,
  settings: (userId: string) => `${PROTOCOL}/settings|${userId}`,
  attachment: (attachmentId: string, index: number, final: boolean) =>
    `${PROTOCOL}/attachment|${attachmentId}|${index}|${final ? 1 : 0}`,
  /** One-time share link (roadmap 20): the key is fresh per link and travels in the URL fragment. */
  share: () => `${PROTOCOL}/share`,
} as const;
