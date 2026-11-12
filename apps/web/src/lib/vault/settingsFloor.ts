import { fingerprint, fromB64 } from '@crewhall/crypto';

/**
 * The highest settings revision this device has seen, per account key (openSettings in
 * @crewhall/crypto). Only a number, nothing decrypted, and it must outlive the unlock, so unlike
 * vault data it lives in localStorage. Without storage there is no floor: nothing can be told.
 */
const keyOf = (userId: string, publicKey: string) =>
  `crewhall.vaultSettingsFloor.${userId}.${fingerprint(fromB64(publicKey))}`;

export function settingsFloor(userId: string, publicKey: string): number {
  try {
    const stored = Number(localStorage.getItem(keyOf(userId, publicKey)));
    return Number.isSafeInteger(stored) && stored > 0 ? stored : 0;
  } catch {
    return 0;
  }
}

export function raiseSettingsFloor(userId: string, publicKey: string, revision: number) {
  try {
    if (revision > settingsFloor(userId, publicKey)) {
      localStorage.setItem(keyOf(userId, publicKey), String(revision));
    }
  } catch {
    // No storage: see above.
  }
}
