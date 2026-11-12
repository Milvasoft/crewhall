import { sha256 } from '@noble/hashes/sha2.js';
import { fromBase32, toBase32 } from './base32';
import { concat, CryptoError, equalBytes, utf8 } from './bytes';
import { info } from './context';
import { randomBytes } from './random';

/**
 * Recovery key (doc 17 §7): 32 random bytes plus a 3-byte checksum, shown once as base32 in
 * 14 groups of four. The checksum catches typos before any network request; the key itself
 * never leaves the device.
 */

export const RECOVERY_KEY_BYTES = 32;
const CHECKSUM_BYTES = 3;

function checksum(key: Uint8Array) {
  return sha256(concat(utf8(info.recoveryChecksum), key)).subarray(0, CHECKSUM_BYTES);
}

export function generateRecoveryKey(): Uint8Array {
  return randomBytes(RECOVERY_KEY_BYTES);
}

/** `K7QM 2X9V …` — 56 characters, 14 groups. */
export function formatRecoveryKey(key: Uint8Array): string {
  if (key.length !== RECOVERY_KEY_BYTES)
    throw new CryptoError('invalid_input', 'recovery key length');
  const text = toBase32(concat(key, checksum(key)));
  return (text.match(/.{1,4}/g) ?? []).join(' ');
}

/** Parses what the person typed; throws invalid_recovery_key on a typo. */
export function parseRecoveryKey(text: string): Uint8Array {
  let raw: Uint8Array;
  try {
    raw = fromBase32(text);
  } catch {
    throw new CryptoError('invalid_recovery_key');
  }
  if (raw.length !== RECOVERY_KEY_BYTES + CHECKSUM_BYTES)
    throw new CryptoError('invalid_recovery_key');
  const key = raw.slice(0, RECOVERY_KEY_BYTES);
  if (!equalBytes(checksum(key), raw.subarray(RECOVERY_KEY_BYTES))) {
    throw new CryptoError('invalid_recovery_key');
  }
  return key;
}

/** True while typing when the text already decodes to a valid key. */
export function isRecoveryKeyComplete(text: string): boolean {
  try {
    parseRecoveryKey(text);
    return true;
  } catch {
    return false;
  }
}
