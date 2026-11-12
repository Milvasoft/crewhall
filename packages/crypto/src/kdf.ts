import { argon2idAsync } from '@noble/hashes/argon2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { argon2id as wasmArgon2id } from 'hash-wasm';
import { CryptoError, fromB64, toB64, utf8 } from './bytes';
import { info } from './context';
import { randomBytes } from './random';

/**
 * Argon2id parameters, stored as-is in user_keys.kdf (doc 17 §4) so they can be raised later.
 * `m` is in KiB. Defaults are Bitwarden's: 64 MiB, 3 iterations, 4 lanes.
 */
export interface KdfParams {
  alg: 'argon2id';
  m: number;
  t: number;
  p: number;
  /** 16 random bytes, base64. */
  salt: string;
}

export const DEFAULT_KDF = { alg: 'argon2id', m: 65536, t: 3, p: 4 } as const;

/**
 * The client refuses weaker parameters, even when the server sends them: a malicious server
 * could otherwise lower the cost and brute-force the verifier the client sends back.
 * 32 MiB is the floor for low-memory phones (design 8.16).
 */
export const KDF_LIMITS = {
  minM: 32768,
  maxM: 1048576,
  minT: 2,
  maxT: 16,
  minP: 1,
  maxP: 16,
} as const;

export function assertKdfParams(k: KdfParams) {
  const ok =
    k.alg === 'argon2id' &&
    Number.isInteger(k.m) &&
    Number.isInteger(k.t) &&
    Number.isInteger(k.p) &&
    k.m >= KDF_LIMITS.minM &&
    k.m <= KDF_LIMITS.maxM &&
    k.t >= KDF_LIMITS.minT &&
    k.t <= KDF_LIMITS.maxT &&
    k.p >= KDF_LIMITS.minP &&
    k.p <= KDF_LIMITS.maxP &&
    // Argon2 needs at least 8 KiB per lane.
    k.m >= 8 * k.p;
  if (!ok) throw new CryptoError('weak_kdf', 'KDF parameters outside the accepted range');
  if (fromB64(k.salt).length < 16) throw new CryptoError('weak_kdf', 'salt shorter than 16 bytes');
}

export function newKdfParams(overrides: Partial<Omit<KdfParams, 'alg' | 'salt'>> = {}): KdfParams {
  const params: KdfParams = { ...DEFAULT_KDF, ...overrides, salt: toB64(randomBytes(16)) };
  assertKdfParams(params);
  return params;
}

export interface Argon2idInput {
  password: Uint8Array;
  salt: Uint8Array;
  m: number;
  t: number;
  p: number;
  dkLen: number;
}
export type Argon2idImpl = (input: Argon2idInput) => Promise<Uint8Array>;

/** hash-wasm (MIT, WASM): the fast path in browsers and Node. */
export const wasmArgon2: Argon2idImpl = async (i) =>
  wasmArgon2id({
    password: i.password,
    salt: i.salt,
    iterations: i.t,
    memorySize: i.m,
    parallelism: i.p,
    hashLength: i.dkLen,
    outputType: 'binary',
  });

/**
 * @noble/hashes (MIT, pure JS): works where WebAssembly does not (Hermes), but is several
 * times slower; mobile should inject a native implementation with configureArgon2id().
 */
export const jsArgon2: Argon2idImpl = async (i) =>
  argon2idAsync(i.password, i.salt, { m: i.m, t: i.t, p: i.p, dkLen: i.dkLen });

let custom: Argon2idImpl | null = null;

/** Injects the Argon2id implementation (e.g. a native module on React Native). */
export function configureArgon2id(impl: Argon2idImpl | null) {
  custom = impl;
}

function currentArgon2(): Argon2idImpl {
  if (custom) return custom;
  return typeof (globalThis as { WebAssembly?: unknown }).WebAssembly === 'object'
    ? wasmArgon2
    : jsArgon2;
}

/**
 * Passwords are NFC-normalized so the same password typed on any keyboard (iOS can emit
 * decomposed forms) derives the same key.
 */
export function normalizePassword(password: string): Uint8Array {
  return utf8(password.normalize('NFC'));
}

/** Argon2id(password, salt) → 32-byte master key. Never leaves the device. */
export async function deriveMasterKey(password: string, kdf: KdfParams): Promise<Uint8Array> {
  assertKdfParams(kdf);
  const out = await currentArgon2()({
    password: normalizePassword(password),
    salt: fromB64(kdf.salt),
    m: kdf.m,
    t: kdf.t,
    p: kdf.p,
    dkLen: 32,
  });
  if (out.length !== 32) throw new CryptoError('invalid_input', 'Argon2id returned a bad length');
  return out;
}

export function hkdf32(ikm: Uint8Array, label: string, salt?: Uint8Array): Uint8Array {
  return hkdf(sha256, ikm, salt, utf8(label), 32);
}

export interface DerivedPair {
  /** Encrypts / decrypts the private key. Stays on the device. */
  kek: Uint8Array;
  /** Sent to the server, which stores only its SHA-256 and releases the wrapped key on a match. */
  verifier: Uint8Array;
}

export function splitMasterKey(masterKey: Uint8Array): DerivedPair {
  return { kek: hkdf32(masterKey, info.kek), verifier: hkdf32(masterKey, info.auth) };
}

export function splitRecoveryKey(recoveryKey: Uint8Array): DerivedPair {
  return {
    kek: hkdf32(recoveryKey, info.recoveryKek),
    verifier: hkdf32(recoveryKey, info.recoveryAuth),
  };
}

/** Passkey PRF output or a device-bound secret (mobile biometrics). */
export function splitUnlockSecret(secret: Uint8Array): DerivedPair {
  if (secret.length < 32) throw new CryptoError('invalid_input', 'unlock secret too short');
  return { kek: hkdf32(secret, info.unlockKek), verifier: hkdf32(secret, info.unlockAuth) };
}

/** What the server stores for a verifier (it never keeps the verifier itself). */
export function verifierHash(verifier: Uint8Array): Uint8Array {
  return sha256(verifier);
}
