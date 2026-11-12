import { gcm } from '@noble/ciphers/aes.js';
import { concat, CryptoError, utf8 } from './bytes';
import { randomBytes } from './random';

/**
 * AES-256-GCM with a 96-bit random nonce. Wrapped keys and other small secrets use a
 * self-describing envelope: `0x01 || nonce(12) || ciphertext || tag(16)`.
 */

export const ENVELOPE_VERSION = 1;
export const NONCE_LENGTH = 12;
export const KEY_LENGTH = 32;
const TAG_LENGTH = 16;

function checkKey(key: Uint8Array) {
  if (key.length !== KEY_LENGTH) throw new CryptoError('invalid_input', 'AES key must be 32 bytes');
}

export function aesGcmEncrypt(
  key: Uint8Array,
  nonce: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array,
): Uint8Array {
  checkKey(key);
  if (nonce.length !== NONCE_LENGTH)
    throw new CryptoError('invalid_input', 'nonce must be 12 bytes');
  return gcm(key, nonce, aad).encrypt(plaintext);
}

export function aesGcmDecrypt(
  key: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
  aad: Uint8Array,
): Uint8Array {
  checkKey(key);
  if (nonce.length !== NONCE_LENGTH || ciphertext.length < TAG_LENGTH) {
    throw new CryptoError('decrypt_failed');
  }
  try {
    return gcm(key, nonce, aad).decrypt(ciphertext);
  } catch {
    throw new CryptoError('decrypt_failed');
  }
}

/** Associated data is always a `|`-joined UTF-8 context string (see context.ts). */
export const aadOf = (context: string) => utf8(context);

export function sealEnvelope(
  key: Uint8Array,
  plaintext: Uint8Array,
  context: string,
  nonce: Uint8Array = randomBytes(NONCE_LENGTH),
): Uint8Array {
  return concat(
    Uint8Array.of(ENVELOPE_VERSION),
    nonce,
    aesGcmEncrypt(key, nonce, plaintext, aadOf(context)),
  );
}

export function openEnvelope(key: Uint8Array, envelope: Uint8Array, context: string): Uint8Array {
  if (envelope.length < 1 + NONCE_LENGTH + TAG_LENGTH || envelope[0] !== ENVELOPE_VERSION) {
    throw new CryptoError('decrypt_failed', 'unknown envelope');
  }
  return aesGcmDecrypt(
    key,
    envelope.subarray(1, 1 + NONCE_LENGTH),
    envelope.subarray(1 + NONCE_LENGTH),
    aadOf(context),
  );
}
