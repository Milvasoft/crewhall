import { fingerprint, formatFingerprint, fromB64 } from '@crewhall/crypto';
import { changeSettings } from './api';
import { currentPins, currentSettings } from './session';

/**
 * Trust on first use (doc 17 §7 "Sahte açık anahtar"): the key I first went ahead with for a
 * person is pinned in my encrypted settings; a different key later is flagged before anything is
 * sealed to it. The fingerprint is always recomputed from the key, never taken from the server.
 * A pin means the person granted to that key or confirmed it, on any device: merely seeing a key
 * in a list is not one, or a member the server made up would pass as known.
 * `unverified`: my pins can't be relied on (openSettings), so nobody's key can be vouched for.
 */

export type Trust = 'new' | 'pinned' | 'changed' | 'invalid' | 'unverified';

/** The server-reported fingerprint must be the hash of the key it gave us. */
export function keyMatches(publicKey: string, reported: string) {
  try {
    return fingerprint(fromB64(publicKey)) === reported;
  } catch {
    return false;
  }
}

export function trustOf(userId: string, publicKey: string, reported: string): Trust {
  if (!keyMatches(publicKey, reported)) return 'invalid';
  const pins = currentPins();
  if (!pins) return 'unverified';
  const pinned = pins[userId];
  if (!pinned) return currentSettings().confirmNewKeys ? 'unverified' : 'new';
  return pinned === reported ? 'pinned' : 'changed';
}

/** Keys the person went ahead with, in one save; leaves settings that can't be relied on alone. */
export async function pinKeys(keys: { userId: string; publicKey: string }[]) {
  const pins = currentPins();
  if (!pins) return;
  const wanted = keys.map((k) => ({ ...k, fp: fingerprint(fromB64(k.publicKey)) }));
  if (wanted.every((k) => pins[k.userId] === k.fp)) return;
  await changeSettings(
    (latest) => ({
      ...latest,
      pins: { ...latest.pins, ...Object.fromEntries(wanted.map((k) => [k.userId, k.fp])) },
    }),
    { onlyIfTrusted: true },
  );
}

export const pin = (userId: string, publicKey: string) => pinKeys([{ userId, publicKey }]);

/** Someone I removed: if the server shows them again they are not known any more. */
export async function forgetKeys(userIds: string[]) {
  const pins = currentPins();
  if (!pins || !userIds.some((id) => pins[id])) return;
  await changeSettings(
    (latest) => ({
      ...latest,
      pins: Object.fromEntries(Object.entries(latest.pins).filter(([id]) => !userIds.includes(id))),
    }),
    { onlyIfTrusted: true },
  );
}

export const shortFingerprint = (fp: string, groups = 3) => formatFingerprint(fp, groups);
