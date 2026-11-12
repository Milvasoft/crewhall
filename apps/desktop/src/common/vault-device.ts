import { createHash, createPublicKey, timingSafeEqual, verify } from 'node:crypto';

/**
 * Vault unlock with Windows Hello in the desktop app (docs/contracts/kararlar.md, "Masaüstünde
 * Windows Hello ile kasa"). Like the mobile biometric lock: a 32-byte device secret wraps a copy
 * of the vault's private key on the server (unlock method `device`); the app keeps the secret
 * encrypted with the OS (safeStorage: DPAPI on Windows) and hands it to the vault page only
 * after a fresh Windows Hello check that the main process verifies itself:
 *
 * - at enrolment the page creates a platform credential (Windows Hello, user verification
 *   required) for this purpose; the app keeps its public key;
 * - every unlock is a WebAuthn assertion over a one-time challenge from the app, with the user
 *   verified flag, signed by that key (it never leaves the device's Hello/TPM store).
 *
 * This module is the pure part: checks and verification (node:crypto), no Electron.
 */

/** Usable for this long after the last unlock with the vault password (mobile: the same). */
export const DEVICE_UNLOCK_DAYS = 14;
const DAY = 86_400_000;
/** A challenge is good for one ceremony within this time. */
export const CHALLENGE_TTL_MS = 120_000;

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

export interface StoredDevice {
  /** Server unlock method id (`device`). */
  unlockId: string;
  /** The device secret, encrypted by the OS (base64 of safeStorage output). */
  secret: string;
  /** Windows Hello credential (base64url id, SPKI public key in base64, COSE alg). */
  credentialId: string;
  publicKey: string;
  alg: number;
  signCount: number;
  enrolledAt: number;
  /** Last unlock with the vault password: starts the 14-day window. */
  passwordAt: number;
  /** keyVersion and passwordChangedAt at enrolment: a new vault password ends it. */
  stamp: string;
}

export class DeviceCheckError extends Error {
  constructor(readonly reason: string) {
    super(`vault device: ${reason}`);
  }
}

export function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

export function fromB64url(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}

/** The stamp a vault password change (or key rotation) moves. */
export function vaultStamp(keyVersion: number, passwordChangedAt: string | null): string {
  return `${keyVersion}:${passwordChangedAt ?? ''}`;
}

/** Whether the stored device may still open the vault without the password. */
export function deviceUsable(
  d: Pick<StoredDevice, 'passwordAt' | 'stamp'>,
  stamp: string,
  now: number,
): 'ok' | 'expired' | 'stale' {
  if (d.stamp !== stamp) return 'stale';
  if (now - d.passwordAt >= DEVICE_UNLOCK_DAYS * DAY) return 'expired';
  return 'ok';
}

function sha256(data: Uint8Array | string): Buffer {
  return createHash('sha256').update(data).digest();
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

interface ClientData {
  type: string;
  challenge: string;
  origin: string;
  crossOrigin?: boolean;
}

function checkClientData(
  clientDataJSON: Uint8Array,
  type: 'webauthn.create' | 'webauthn.get',
  challenge: string,
  origin: string,
): void {
  let cd: ClientData;
  try {
    cd = JSON.parse(Buffer.from(clientDataJSON).toString('utf8')) as ClientData;
  } catch {
    throw new DeviceCheckError('client_data');
  }
  if (cd.type !== type) throw new DeviceCheckError('type');
  if (!sameBytes(fromB64url(cd.challenge), fromB64url(challenge)))
    throw new DeviceCheckError('challenge');
  if (cd.origin !== origin) throw new DeviceCheckError('origin');
  if (cd.crossOrigin) throw new DeviceCheckError('cross_origin');
}

/** rpIdHash, flags (user present and verified) and the signature counter. */
function checkAuthData(authData: Uint8Array, rpId: string): { flags: number; signCount: number } {
  if (authData.length < 37) throw new DeviceCheckError('auth_data');
  if (!sameBytes(authData.subarray(0, 32), sha256(rpId))) throw new DeviceCheckError('rp_id');
  const flags = authData[32]!;
  if (!(flags & FLAG_UP)) throw new DeviceCheckError('not_present');
  if (!(flags & FLAG_UV)) throw new DeviceCheckError('not_verified');
  const signCount = Buffer.from(authData.subarray(33, 37)).readUInt32BE(0);
  return { flags, signCount };
}

export interface Expected {
  challenge: string;
  origin: string;
  rpId: string;
}

export interface Registration {
  credentialId: string;
  clientDataJSON: string;
  authenticatorData: string;
  /** SubjectPublicKeyInfo (base64url), from AuthenticatorAttestationResponse.getPublicKey(). */
  publicKey: string;
  alg: number;
}

const ALGS = new Set([-7, -257, -8]);

/** Checks a new Windows Hello credential; returns what is kept of it. */
export function verifyRegistration(
  r: Registration,
  expected: Expected,
): Pick<StoredDevice, 'credentialId' | 'publicKey' | 'alg' | 'signCount'> {
  if (!ALGS.has(r.alg)) throw new DeviceCheckError('alg');
  checkClientData(
    fromB64url(r.clientDataJSON),
    'webauthn.create',
    expected.challenge,
    expected.origin,
  );
  const authData = fromB64url(r.authenticatorData);
  const { flags, signCount } = checkAuthData(authData, expected.rpId);
  if (!(flags & FLAG_AT)) throw new DeviceCheckError('no_credential');
  // Attested credential data: aaguid (16), id length (2), id.
  const idLen = authData.readUInt16BE(53);
  const id = authData.subarray(55, 55 + idLen);
  if (!sameBytes(id, fromB64url(r.credentialId))) throw new DeviceCheckError('credential_id');
  const spki = fromB64url(r.publicKey);
  try {
    createPublicKey({ key: spki, format: 'der', type: 'spki' });
  } catch {
    throw new DeviceCheckError('public_key');
  }
  return {
    credentialId: r.credentialId,
    publicKey: spki.toString('base64'),
    alg: r.alg,
    signCount,
  };
}

export interface Assertion {
  credentialId: string;
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
}

/** Checks a Windows Hello assertion against the stored credential; returns the new counter. */
export function verifyAssertion(
  a: Assertion,
  stored: Pick<StoredDevice, 'credentialId' | 'publicKey' | 'alg' | 'signCount'>,
  expected: Expected,
): number {
  if (!sameBytes(fromB64url(a.credentialId), fromB64url(stored.credentialId)))
    throw new DeviceCheckError('credential_id');
  const clientData = fromB64url(a.clientDataJSON);
  checkClientData(clientData, 'webauthn.get', expected.challenge, expected.origin);
  const authData = fromB64url(a.authenticatorData);
  const { signCount } = checkAuthData(authData, expected.rpId);
  // A counter that went back means a cloned authenticator; 0 means it keeps none.
  if (signCount !== 0 && stored.signCount !== 0 && signCount <= stored.signCount)
    throw new DeviceCheckError('counter');
  const key = createPublicKey({
    key: Buffer.from(stored.publicKey, 'base64'),
    format: 'der',
    type: 'spki',
  });
  const data = Buffer.concat([authData, sha256(clientData)]);
  const signature = fromB64url(a.signature);
  const ok =
    stored.alg === -8
      ? verify(null, data, key, signature)
      : verify('sha256', data, stored.alg === -7 ? { key, dsaEncoding: 'der' } : key, signature);
  if (!ok) throw new DeviceCheckError('signature');
  return signCount;
}
