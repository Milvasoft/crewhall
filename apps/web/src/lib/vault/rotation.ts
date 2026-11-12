import {
  CryptoError,
  decryptItem,
  encryptItem,
  newVaultKey,
  rewrapItemKey,
  unwrapVaultKey,
  wipe,
  wrapVaultKey,
  type ItemType,
} from '@crewhall/crypto';
import { type VaultMember } from '@crewhall/shared';
import { api, isApiError } from '@/lib/api';
import { refreshSettings } from './api';
import { requireUnlocked } from './session';
import { forgetKeys, keyMatches, pinKeys, trustOf } from './tofu';

/** Someone the new key would be sealed to, whom the person has to look at first. */
export interface KeyToConfirm {
  userId: string;
  name: string;
  fingerprint: string;
  /**
   * `changed`: differs from the key pinned for them. `unlisted`: not on the list the person saw,
   * or with another key there. `unverified`: my pins can't be relied on to tell. `first_seen`:
   * on the list, but nobody confirmed this key yet, and a list is only the server's word.
   */
  why: 'changed' | 'unlisted' | 'unverified' | 'first_seen';
}

export class KeysToConfirmError extends Error {
  constructor(readonly people: KeyToConfirm[]) {
    super('keys_to_confirm');
    this.name = 'KeysToConfirmError';
  }
}

/** A revision that would not open under the current key: the rotation can't carry it along. */
export interface BlockedRevision {
  itemId: string;
  revision: number;
  /** The item itself rather than a kept revision, which can't be deleted on its own. */
  current: boolean;
}

export class RotationBlockedError extends Error {
  constructor(readonly blocked: BlockedRevision[]) {
    super('rotation_blocked');
    this.name = 'RotationBlockedError';
  }
}

export interface RotationOptions {
  /** The members on the screen the person decided from; anyone else needs `accepted`. */
  seen?: { user: { id: string }; fingerprint: string }[];
  /** userId → fingerprint: a key swapped after the checkbox does not match, and is not sealed. */
  accepted?: Record<string, string>;
  onProgress?: (done: number, total: number) => void;
}

/**
 * The server says who holds the vault and with which key, and a swapped key or a made-up member
 * would get the new vault key: only keys the person confirmed are sealed to, as on the phone.
 */
async function checkRecipients(
  remaining: VaultMember[],
  me: { userId: string; publicKey: string },
  options: RotationOptions,
) {
  await refreshSettings();
  const mine = remaining.find((m) => m.user.id === me.userId);
  // My own key I know for certain: it opened my private key at unlock.
  if (mine?.publicKey !== me.publicKey) throw new Error('fingerprint_mismatch');
  const seen = new Map(options.seen?.map((m) => [m.user.id, m.fingerprint]));
  const toConfirm: KeyToConfirm[] = [];
  const toPin: { userId: string; publicKey: string }[] = [];
  for (const m of remaining) {
    if (m.user.id === me.userId) continue;
    if (!keyMatches(m.publicKey, m.fingerprint)) throw new Error('fingerprint_mismatch');
    const person = { userId: m.user.id, name: m.user.name, fingerprint: m.fingerprint };
    const trust = trustOf(m.user.id, m.publicKey, m.fingerprint);
    if (options.accepted?.[m.user.id] === m.fingerprint) {
      toPin.push({ userId: m.user.id, publicKey: m.publicKey });
    } else if (trust === 'changed' || trust === 'unverified') {
      toConfirm.push({ ...person, why: trust });
    } else if (seen.get(m.user.id) !== m.fingerprint) {
      toConfirm.push({ ...person, why: 'unlisted' });
    } else if (trust !== 'pinned') {
      toConfirm.push({ ...person, why: 'first_seen' });
    }
  }
  if (toConfirm.length) throw new KeysToConfirmError(toConfirm);
  await pinKeys(toPin);
}

/**
 * Key rotation on this device (doc 17 §7 "Üye çıkarma ve anahtar döndürme"): a new vault key,
 * sealed to each remaining member, every item re-encrypted at revision + 1, kept revisions
 * re-wrapped. The server applies it in one transaction or refuses; on a race we retry.
 */
export async function rotateVault(
  vaultId: string,
  removeUserIds: string[],
  options: RotationOptions = {},
) {
  const u = requireUnlocked();
  for (let attempt = 0; attempt < 3; attempt++) {
    const data = await api.call('vaultRotationData', { params: { vaultId } });
    const v = data.vault;
    const remaining = data.members.filter((m) => !removeUserIds.includes(m.user.id));
    await checkRecipients(remaining, u, options);
    const oldKey = unwrapVaultKey(u.privateKey, v.myWrappedKey, {
      vaultId,
      keyVersion: v.keyVersion,
      userId: u.userId,
    });
    const newKey = newVaultKey();
    const keyVersion = v.keyVersion + 1;
    const total = data.items.length;
    try {
      // On through the rest: the person deals with all of them in one go.
      const blocked: BlockedRevision[] = [];
      const orBlocked = <T>(entry: BlockedRevision, work: () => T): T[] => {
        try {
          return [work()];
        } catch (e) {
          if (!(e instanceof CryptoError || e instanceof SyntaxError)) throw e;
          blocked.push(entry);
          return [];
        }
      };
      const items = data.items.flatMap((i, n) => {
        const ctx = { vaultId, itemId: i.id, keyVersion: i.keyVersion, type: i.type as ItemType };
        const entry = { itemId: i.id, revision: i.revision, current: true };
        const sealed = orBlocked(entry, () => {
          const plain = decryptItem(oldKey, { ...ctx, revision: i.revision }, i);
          return {
            id: i.id,
            revision: i.revision + 1,
            ...encryptItem(newKey, { ...ctx, revision: i.revision + 1, keyVersion }, plain),
          };
        });
        options.onProgress?.(n + 1, total);
        return sealed;
      });
      const revisions = data.revisions.flatMap((r) =>
        orBlocked({ itemId: r.itemId, revision: r.revision, current: false }, () => ({
          itemId: r.itemId,
          revision: r.revision,
          itemKeyWrapped: rewrapItemKey(
            oldKey,
            newKey,
            {
              vaultId,
              itemId: r.itemId,
              revision: r.revision,
              oldKeyVersion: r.keyVersion,
              newKeyVersion: keyVersion,
            },
            r.itemKeyWrapped,
          ),
        })),
      );
      if (blocked.length) throw new RotationBlockedError(blocked);
      const body = {
        keyVersion,
        removeUserIds,
        members: remaining.map((m) => ({
          userId: m.user.id,
          wrappedKey: wrapVaultKey(newKey, m.publicKey, { vaultId, keyVersion, userId: m.user.id }),
        })),
        items,
        revisions,
      };
      const out = await api.call('vaultRotate', { params: { vaultId }, body });
      await forgetKeys(removeUserIds).catch(() => undefined);
      return out;
    } catch (e) {
      // Someone saved an item or changed members meanwhile: start over with fresh data.
      if (
        isApiError(e, 'vault_rotation_incomplete') ||
        isApiError(e, 'vault_key_version_mismatch')
      ) {
        continue;
      }
      throw e;
    } finally {
      wipe(oldKey, newKey);
    }
  }
  throw new Error('rotation_retry_exhausted');
}
