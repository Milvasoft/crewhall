import { openEnvelope, sealEnvelope } from './aead';
import { CryptoError, fromB64, fromUtf8, toB64, utf8, wipe } from './bytes';
import { aad, info, type UnlockMethod } from './context';
import {
  deriveMasterKey,
  hkdf32,
  newKdfParams,
  splitMasterKey,
  splitRecoveryKey,
  splitUnlockSecret,
  type DerivedPair,
  type KdfParams,
} from './kdf';
import { fingerprint, generateKeyPair, publicKeyOf } from './keys';
import { formatRecoveryKey, generateRecoveryKey, parseRecoveryKey } from './recovery';
import { randomBytes } from './random';

/**
 * Account key setup and unlock (doc 17 §7 "Kurulum", "Kasa şifresi unutulursa").
 * Wire values are base64; raw keys stay in memory only.
 */

/** Everything the server stores for a person (user_keys); no secret in clear. */
export interface AccountKeysUpload {
  publicKey: string;
  fingerprint: string;
  kdf: KdfParams;
  encryptedPrivateKey: string;
  passwordVerifier: string;
  recoveryWrappedKey: string;
  recoveryVerifier: string;
}

export interface AccountSetup {
  upload: AccountKeysUpload;
  privateKey: Uint8Array;
  publicKey: Uint8Array;
  /** Formatted for display; shown once, never sent. */
  recoveryKey: string;
}

/** Runs on the device during setup (design 8.1-8.2). */
export async function createAccountKeys(input: {
  userId: string;
  password: string;
  kdf?: Partial<Pick<KdfParams, 'm' | 't' | 'p'>>;
}): Promise<AccountSetup> {
  const pair = generateKeyPair();
  const kdf = newKdfParams(input.kdf);
  const pw = await wrapForPassword(pair.privateKey, input.userId, input.password, kdf);
  const recovery = newRecovery(pair.privateKey, input.userId);
  return {
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    recoveryKey: recovery.recoveryKey,
    upload: {
      publicKey: toB64(pair.publicKey),
      fingerprint: fingerprint(pair.publicKey),
      kdf,
      encryptedPrivateKey: pw.encryptedPrivateKey,
      passwordVerifier: pw.passwordVerifier,
      recoveryWrappedKey: recovery.recoveryWrappedKey,
      recoveryVerifier: recovery.recoveryVerifier,
    },
  };
}

function wrapPrivateKey(
  pair: DerivedPair,
  privateKey: Uint8Array,
  userId: string,
  method: UnlockMethod,
) {
  return toB64(sealEnvelope(pair.kek, privateKey, aad.privateKey(userId, method)));
}

/** New password (setup, change, or after recovery): fresh salt, fresh wrap. */
export async function wrapForPassword(
  privateKey: Uint8Array,
  userId: string,
  password: string,
  kdf: KdfParams = newKdfParams(),
) {
  const master = await deriveMasterKey(password, kdf);
  const pair = splitMasterKey(master);
  wipe(master);
  const out = {
    kdf,
    encryptedPrivateKey: wrapPrivateKey(pair, privateKey, userId, 'password'),
    passwordVerifier: toB64(pair.verifier),
  };
  wipe(pair.kek);
  return out;
}

/** A new recovery key (setup, or "Yenisini oluştur" in 8.16; the old one stops working). */
export function newRecovery(privateKey: Uint8Array, userId: string) {
  const key = generateRecoveryKey();
  const pair = splitRecoveryKey(key);
  const out = {
    recoveryKey: formatRecoveryKey(key),
    recoveryWrappedKey: wrapPrivateKey(pair, privateKey, userId, 'recovery'),
    recoveryVerifier: toB64(pair.verifier),
  };
  wipe(key, pair.kek);
  return out;
}

/** Step 1 of a password unlock: the verifier goes to the server, the KEK stays here. */
export async function passwordUnlockMaterial(
  password: string,
  kdf: KdfParams,
): Promise<DerivedPair> {
  const master = await deriveMasterKey(password, kdf);
  const pair = splitMasterKey(master);
  wipe(master);
  return pair;
}

/** Throws CryptoError('invalid_recovery_key') on a typo. */
export function recoveryUnlockMaterial(recoveryKeyText: string): DerivedPair {
  const key = parseRecoveryKey(recoveryKeyText);
  const pair = splitRecoveryKey(key);
  wipe(key);
  return pair;
}

export function secretUnlockMaterial(secret: Uint8Array): DerivedPair {
  return splitUnlockSecret(secret);
}

/** Step 2: open the wrapped private key the server released; checks it matches the public key. */
export function openPrivateKey(input: {
  kek: Uint8Array;
  wrapped: string;
  userId: string;
  method: UnlockMethod;
  publicKey: string;
}): Uint8Array {
  const privateKey = openEnvelope(
    input.kek,
    fromB64(input.wrapped),
    aad.privateKey(input.userId, input.method),
  );
  const expected = fromB64(input.publicKey);
  const actual = publicKeyOf(privateKey);
  if (actual.length !== expected.length || actual.some((b, i) => b !== expected[i])) {
    throw new CryptoError('decrypt_failed', 'private key does not match the public key');
  }
  return privateKey;
}

/** Passkey PRF / device unlock: wraps the private key under a 32-byte secret. */
export function wrapForSecret(
  privateKey: Uint8Array,
  userId: string,
  method: 'passkey_prf' | 'device',
  secret: Uint8Array,
) {
  const pair = splitUnlockSecret(secret);
  const out = {
    wrappedPrivateKey: wrapPrivateKey(pair, privateKey, userId, method),
    verifier: toB64(pair.verifier),
  };
  wipe(pair.kek);
  return out;
}

/** Random 32-byte salt for a passkey's PRF evaluation (stored with the unlock method). */
export function newPrfSalt(): string {
  return toB64(randomBytes(32));
}

/* ------------------------- encrypted account settings ------------------------- */

function settingsKey(privateKey: Uint8Array) {
  return hkdf32(privateKey, info.settings);
}

/** Per-account settings and TOFU pins are stored encrypted (design 8.16). */
export function encryptSettings(privateKey: Uint8Array, userId: string, settings: unknown): string {
  return toB64(
    sealEnvelope(settingsKey(privateKey), utf8(JSON.stringify(settings)), aad.settings(userId)),
  );
}

export function decryptSettings(privateKey: Uint8Array, userId: string, blob: string): unknown {
  return JSON.parse(
    fromUtf8(openEnvelope(settingsKey(privateKey), fromB64(blob), aad.settings(userId))),
  );
}

export type SettingsState = 'ok' | 'rolled_back' | 'unreadable';

/**
 * Encryption proves a blob is mine, not that it is my latest: the server can hand back an older
 * one, or none, and with it lose the TOFU pins saved since. So the settings JSON carries a
 * `revision` (0 when absent, on blobs from before it) and each device remembers the highest it
 * has seen as `floor`. Only that memory can tell, so a device without one takes what it gets.
 */
export function openSettings(
  privateKey: Uint8Array,
  userId: string,
  blob: string | null,
  floor: number,
): { value: unknown; revision: number; state: SettingsState } {
  if (blob === null) return { value: {}, revision: 0, state: floor > 0 ? 'rolled_back' : 'ok' };
  let value: unknown;
  try {
    value = decryptSettings(privateKey, userId, blob);
  } catch {
    return { value: {}, revision: 0, state: 'unreadable' };
  }
  if (!value || typeof value !== 'object') return { value: {}, revision: 0, state: 'unreadable' };
  const stored = (value as { revision?: unknown }).revision;
  const revision = typeof stored === 'number' && Number.isSafeInteger(stored) ? stored : 0;
  return { value, revision, state: revision < floor ? 'rolled_back' : 'ok' };
}

/**
 * The revision for a save. A time rather than a counter: a session left open elsewhere counts on
 * from an old value, and a counter would make its honest save look like a rollback here.
 */
export function nextSettingsRevision(floor: number, now: number = Date.now()): number {
  return Math.max(now, floor + 1);
}

/**
 * The way out of `rolled_back` or `unreadable`, only on the person's own decision: settings to
 * save as the newest, which every device then reads as `ok`. Pins saved since the old copy are
 * gone and nothing says which, so from here on a key without a pin is not "first seen":
 * `confirmNewKeys` makes it unverified until the person confirms it.
 */
export function acceptSettings<T extends object>(
  value: T,
  floor: number,
  now: number = Date.now(),
) {
  const stored = (value as { revision?: unknown }).revision;
  const revision = typeof stored === 'number' && Number.isSafeInteger(stored) ? stored : 0;
  return {
    ...value,
    revision: nextSettingsRevision(Math.max(floor, revision), now),
    confirmNewKeys: true,
  };
}
