import {
  fromB64,
  randomBytes,
  secretUnlockMaterial,
  toB64,
  toB64Url,
  wipe,
  wrapForSecret,
} from '@crewhall/crypto';
import { type VaultKeyStatus } from '@crewhall/shared';
import { api, isApiError } from '@/lib/api';
import { desktopBridge, desktopHas, type DesktopVaultDeviceBridge } from '@/lib/desktop';
import { unlockWithSecret } from './api';
import { requireUnlocked } from './session';

/**
 * Vault unlock with Windows Hello (Touch ID in a signed mac build) in the desktop app: the same
 * as the mobile biometric lock (unlock method `device`). A random 32-byte secret wraps a copy of
 * the private key on the server; the app keeps the secret encrypted by the OS and gives it back
 * after a Windows Hello check it verifies itself (apps/desktop src/common/vault-device.ts).
 * Usable for 14 days after the last unlock with the vault password; a new vault password ends it.
 */

export function vaultDeviceBridge(): DesktopVaultDeviceBridge | null {
  return desktopHas('vaultDevice') ? (desktopBridge()?.vaultDevice ?? null) : null;
}

/** What a new vault password or a key rotation changes. */
export function vaultStamp(status: Pick<VaultKeyStatus, 'keyVersion' | 'passwordChangedAt'>) {
  return `${status.keyVersion}:${status.passwordChangedAt ?? ''}`;
}

/** "Windows Hello" or "Touch ID", by the desktop app's platform. */
export function deviceLockName(): string {
  return desktopBridge()?.platform === 'darwin' ? 'Touch ID' : 'Windows Hello';
}

const bytes = (b: ArrayBuffer) => toB64Url(new Uint8Array(b));
const buf = (s: string) => {
  const b = fromB64(s.replace(/-/g, '+').replace(/_/g, '/'));
  return b.slice().buffer as ArrayBuffer;
};

export type DeviceState = 'unavailable' | 'off' | 'expired' | 'ready';

/**
 * Whether Hello unlock can be offered or used here. A device made stale by a new vault
 * password is forgotten on both sides.
 */
export async function deviceState(userId: string, status: VaultKeyStatus): Promise<DeviceState> {
  const bridge = vaultDeviceBridge();
  if (!bridge) return 'unavailable';
  const available =
    typeof PublicKeyCredential !== 'undefined' &&
    (await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable().catch(() => false));
  if (!available) return 'unavailable';
  const s = await bridge.status(userId, vaultStamp(status)).catch(() => null);
  if (!s?.available) return 'unavailable';
  if (!s.enrolled) {
    if (s.stale) await removeMethod(s.stale);
    return 'off';
  }
  // The server does not list it (removed on the web or another device): off here too. The
  // secret goes when Hello is set up again or an unlock finds the server refusing it.
  if (!status.unlockMethods.some((m) => m.id === s.unlockId)) return 'off';
  return s.usable ? 'ready' : 'expired';
}

async function removeMethod(unlockId: string) {
  await api.call('vaultRemoveUnlockMethod', { params: { unlockId } }).catch(() => undefined);
}

/**
 * Sets up Hello unlock while the vault is open; `verifier` is the vault password proof the
 * server asks for (the one from this unlock, or asked again). Windows Hello asks once to create
 * this device's key.
 */
export async function enrolDevice(
  status: VaultKeyStatus,
  label: string,
  verifier: Uint8Array,
): Promise<void> {
  const bridge = vaultDeviceBridge();
  const u = requireUnlocked();
  if (!bridge) throw new Error('unavailable');
  const { challenge, rpId } = await bridge.challenge(u.userId, 'enrol');
  const created = (await navigator.credentials.create({
    publicKey: {
      challenge: buf(challenge),
      rp: { id: rpId, name: document.title || 'Crewhall' },
      user: { id: randomBytes(16).slice().buffer as ArrayBuffer, name: label, displayName: label },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 },
      ],
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        userVerification: 'required',
        residentKey: 'discouraged',
      },
      attestation: 'none',
      timeout: 120_000,
    },
  })) as PublicKeyCredential | null;
  if (!created) throw new DOMException('cancelled', 'NotAllowedError');
  const response = created.response as AuthenticatorAttestationResponse;
  const publicKey = response.getPublicKey();
  if (!publicKey) throw new Error('unsupported');

  const secret = randomBytes(32);
  let unlockId: string | null = null;
  try {
    const wrap = wrapForSecret(u.privateKey, u.userId, 'device', secret);
    const method = await api.call('vaultAddUnlockMethod', {
      body: {
        proof: { method: 'password', verifier: toB64(verifier) },
        method: 'device',
        label,
        wrappedPrivateKey: wrap.wrappedPrivateKey,
        verifier: wrap.verifier,
      },
    });
    unlockId = method.id;
    const { replaced } = await bridge.enrol(u.userId, {
      unlockId,
      secret: toB64(secret),
      stamp: vaultStamp(status),
      credential: {
        credentialId: bytes(created.rawId),
        clientDataJSON: bytes(response.clientDataJSON),
        authenticatorData: bytes(response.getAuthenticatorData()),
        publicKey: bytes(publicKey),
        alg: response.getPublicKeyAlgorithm(),
      },
    });
    if (replaced) await removeMethod(replaced);
  } catch (e) {
    if (unlockId) await removeMethod(unlockId);
    throw e;
  } finally {
    wipe(secret);
  }
}

/** Turns Hello unlock off here (and on the server). */
export async function disableDevice(userId: string): Promise<void> {
  const bridge = vaultDeviceBridge();
  if (!bridge) return;
  const { unlockId } = await bridge.forget(userId);
  if (unlockId) await removeMethod(unlockId);
}

/** After an unlock with the vault password: the 14-day window starts again. */
export function passwordUnlocked(userId: string, status: VaultKeyStatus): void {
  void vaultDeviceBridge()
    ?.passwordUnlocked(userId, vaultStamp(status))
    .catch(() => undefined);
}

/**
 * Opens the vault with Windows Hello. Resolves false when this device can no longer do it (the
 * server forgot it, or its Hello key is gone): the password is needed, and Hello is set up again
 * afterwards. Throws a DOMException when the person cancels the Hello prompt.
 */
export async function unlockWithDevice(userId: string): Promise<boolean> {
  const bridge = vaultDeviceBridge();
  if (!bridge) return false;
  const t0 = performance.now();
  const { challenge, rpId, credentialId } = await bridge.challenge(userId, 'unlock');
  if (!credentialId) return false;
  const t1 = performance.now();
  const cred = (await navigator.credentials.get({
    publicKey: {
      challenge: buf(challenge),
      rpId,
      allowCredentials: [{ type: 'public-key', id: buf(credentialId), transports: ['internal'] }],
      userVerification: 'required',
      // Windows opens Hello directly, not the "phone or security key" chooser.
      hints: ['client-device'],
      timeout: 120_000,
    } as PublicKeyCredentialRequestOptions,
  })) as PublicKeyCredential | null;
  if (!cred) throw new DOMException('cancelled', 'NotAllowedError');
  const t2 = performance.now();
  const response = cred.response as AuthenticatorAssertionResponse;
  const released = await bridge.unlock(userId, {
    credentialId: bytes(cred.rawId),
    clientDataJSON: bytes(response.clientDataJSON),
    authenticatorData: bytes(response.authenticatorData),
    signature: bytes(response.signature),
  });
  const secret = fromB64(released.secret);
  const material = secretUnlockMaterial(secret);
  const t3 = performance.now();
  try {
    await unlockWithSecret(userId, 'device', released.unlockId, material);
    // Where the time goes, for reports from the field.
    console.info(
      `[vault] Hello unlock: challenge ${Math.round(t1 - t0)} ms, prompt ${Math.round(t2 - t1)} ms, release ${Math.round(t3 - t2)} ms, server ${Math.round(performance.now() - t3)} ms`,
    );
    return true;
  } catch (e) {
    // The server no longer knows this device: back to the password.
    if (isApiError(e, 'vault_unlock_failed') || isApiError(e, 'not_found')) {
      await bridge.forget(userId).catch(() => undefined);
      return false;
    }
    throw e;
  } finally {
    wipe(secret, material.kek, material.verifier);
  }
}
