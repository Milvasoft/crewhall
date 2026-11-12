import { x25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { aesGcmDecrypt, aesGcmEncrypt, aadOf, NONCE_LENGTH } from './aead';
import { concat, CryptoError, toHex, utf8 } from './bytes';
import { info } from './context';
import { hkdf32 } from './kdf';
import { randomBytes } from './random';

/** X25519 key pair: the person's identity in the vault (user_keys.public_key). */
export interface KeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

export function generateKeyPair(privateKey: Uint8Array = randomBytes(32)): KeyPair {
  if (privateKey.length !== 32)
    throw new CryptoError('invalid_input', 'X25519 key must be 32 bytes');
  return { privateKey, publicKey: x25519.getPublicKey(privateKey) };
}

export function publicKeyOf(privateKey: Uint8Array): Uint8Array {
  return x25519.getPublicKey(privateKey);
}

const SEAL_VERSION = 1;
const SEAL_OVERHEAD = 1 + 32 + NONCE_LENGTH + 16;

function sharedKey(
  secret: Uint8Array,
  publicKey: Uint8Array,
  ephPk: Uint8Array,
  recipientPk: Uint8Array,
) {
  let shared: Uint8Array;
  try {
    shared = x25519.getSharedSecret(secret, publicKey);
  } catch {
    throw new CryptoError('decrypt_failed', 'invalid public key');
  }
  // A low-order public key gives an all-zero secret: refuse it.
  if (shared.every((b) => b === 0)) throw new CryptoError('decrypt_failed', 'low-order public key');
  return hkdf32(shared, info.seal, concat(ephPk, recipientPk));
}

/**
 * Sealed box (design "Space kasası paylaşımı"): ephemeral X25519 + HKDF-SHA256 + AES-256-GCM.
 * Layout: `0x01 || ephemeralPublicKey(32) || nonce(12) || ciphertext || tag(16)`.
 * Only the holder of the recipient's private key can open it; the server just stores it.
 */
export function sealTo(
  recipientPublicKey: Uint8Array,
  plaintext: Uint8Array,
  context: string,
  fixed?: { ephemeralPrivateKey?: Uint8Array; nonce?: Uint8Array },
): Uint8Array {
  const eph = generateKeyPair(fixed?.ephemeralPrivateKey ?? randomBytes(32));
  const key = sharedKey(eph.privateKey, recipientPublicKey, eph.publicKey, recipientPublicKey);
  const nonce = fixed?.nonce ?? randomBytes(NONCE_LENGTH);
  return concat(
    Uint8Array.of(SEAL_VERSION),
    eph.publicKey,
    nonce,
    aesGcmEncrypt(key, nonce, plaintext, aadOf(context)),
  );
}

export function openSealed(
  privateKey: Uint8Array,
  sealed: Uint8Array,
  context: string,
): Uint8Array {
  if (sealed.length < SEAL_OVERHEAD || sealed[0] !== SEAL_VERSION) {
    throw new CryptoError('decrypt_failed', 'unknown sealed box');
  }
  const ephPk = sealed.subarray(1, 33);
  const key = sharedKey(privateKey, ephPk, ephPk, publicKeyOf(privateKey));
  return aesGcmDecrypt(
    key,
    sealed.subarray(33, 33 + NONCE_LENGTH),
    sealed.subarray(33 + NONCE_LENGTH),
    aadOf(context),
  );
}

/**
 * Public-key fingerprint, 64 hex chars. The UI shows it in groups of four (TOFU, design 8.10);
 * people compare the first 4 groups aloud, the full value on the verify screen.
 */
export function fingerprint(publicKey: Uint8Array): string {
  return toHex(sha256(concat(utf8(info.fingerprint), publicKey)));
}

export function formatFingerprint(fp: string, groups = 4): string {
  return (fp.match(/.{4}/g) ?? []).slice(0, groups).join(' ');
}
