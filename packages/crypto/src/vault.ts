import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  aadOf,
  KEY_LENGTH,
  NONCE_LENGTH,
  openEnvelope,
  sealEnvelope,
} from './aead';
import { CryptoError, fromB64, fromUtf8, toB64, utf8, wipe } from './bytes';
import { aad } from './context';
import { ItemPayload, type ItemType } from './item';
import { openSealed, sealTo } from './keys';
import { randomBytes } from './random';

/**
 * Vault and item encryption (design "Öğe şifreleme", doc 17 §7):
 * - each vault has a random 256-bit key, sealed separately to every member's X25519 key;
 * - each item revision gets a fresh random item key, wrapped with the vault key;
 * - the item JSON is AES-256-GCM encrypted with the item key; the AAD binds vault id,
 *   item id, revision and type, so the server can neither swap ciphertexts between items
 *   nor serve an old ciphertext under a newer revision number.
 */

export function newVaultKey(): Uint8Array {
  return randomBytes(KEY_LENGTH);
}

export interface VaultKeyContext {
  vaultId: string;
  keyVersion: number;
  userId: string;
}

/** Seals the vault key to a member (sharing, design 8.10). */
export function wrapVaultKey(
  vaultKey: Uint8Array,
  recipientPublicKey: string | Uint8Array,
  ctx: VaultKeyContext,
): string {
  const pk =
    typeof recipientPublicKey === 'string' ? fromB64(recipientPublicKey) : recipientPublicKey;
  return toB64(sealTo(pk, vaultKey, aad.vaultKey(ctx.vaultId, ctx.keyVersion, ctx.userId)));
}

export function unwrapVaultKey(
  privateKey: Uint8Array,
  wrapped: string,
  ctx: VaultKeyContext,
): Uint8Array {
  const key = openSealed(
    privateKey,
    fromB64(wrapped),
    aad.vaultKey(ctx.vaultId, ctx.keyVersion, ctx.userId),
  );
  if (key.length !== KEY_LENGTH) throw new CryptoError('decrypt_failed', 'vault key length');
  return key;
}

export interface ItemContext {
  vaultId: string;
  itemId: string;
  /** The revision this ciphertext is for: the server's current + 1 on save. */
  revision: number;
  keyVersion: number;
  type: ItemType;
}

/** What vault_items stores (base64 on the wire). */
export interface EncryptedItem {
  ciphertext: string;
  nonce: string;
  itemKeyWrapped: string;
}

export function encryptItem(
  vaultKey: Uint8Array,
  ctx: ItemContext,
  payload: ItemPayload,
  fixed?: { itemKey?: Uint8Array; nonce?: Uint8Array; wrapNonce?: Uint8Array },
): EncryptedItem {
  if (payload.type !== ctx.type)
    throw new CryptoError('schema_mismatch', 'payload type differs from context');
  return encryptItemPlaintext(vaultKey, ctx, utf8(JSON.stringify(payload)), fixed);
}

/** Low level (test vectors): encrypts the exact plaintext bytes. */
export function encryptItemPlaintext(
  vaultKey: Uint8Array,
  ctx: ItemContext,
  plaintext: Uint8Array,
  fixed?: { itemKey?: Uint8Array; nonce?: Uint8Array; wrapNonce?: Uint8Array },
): EncryptedItem {
  const itemKey = fixed?.itemKey ?? randomBytes(KEY_LENGTH);
  const nonce = fixed?.nonce ?? randomBytes(NONCE_LENGTH);
  const ciphertext = aesGcmEncrypt(
    itemKey,
    nonce,
    plaintext,
    aadOf(aad.item(ctx.vaultId, ctx.itemId, ctx.revision, ctx.type)),
  );
  const itemKeyWrapped = sealEnvelope(
    vaultKey,
    itemKey,
    aad.itemKey(ctx.vaultId, ctx.itemId, ctx.revision, ctx.keyVersion),
    fixed?.wrapNonce,
  );
  if (!fixed?.itemKey) wipe(itemKey);
  return {
    ciphertext: toB64(ciphertext),
    nonce: toB64(nonce),
    itemKeyWrapped: toB64(itemKeyWrapped),
  };
}

export function unwrapItemKey(
  vaultKey: Uint8Array,
  ctx: Omit<ItemContext, 'type'>,
  itemKeyWrapped: string,
): Uint8Array {
  return openEnvelope(
    vaultKey,
    fromB64(itemKeyWrapped),
    aad.itemKey(ctx.vaultId, ctx.itemId, ctx.revision, ctx.keyVersion),
  );
}

export function decryptItemPlaintext(
  vaultKey: Uint8Array,
  ctx: ItemContext,
  item: EncryptedItem,
): Uint8Array {
  const itemKey = unwrapItemKey(vaultKey, ctx, item.itemKeyWrapped);
  try {
    return aesGcmDecrypt(
      itemKey,
      fromB64(item.nonce),
      fromB64(item.ciphertext),
      aadOf(aad.item(ctx.vaultId, ctx.itemId, ctx.revision, ctx.type)),
    );
  } finally {
    wipe(itemKey);
  }
}

/** Decrypts and validates; throws CryptoError on tampering or an unknown shape. */
export function decryptItem(
  vaultKey: Uint8Array,
  ctx: ItemContext,
  item: EncryptedItem,
): ItemPayload {
  const json = fromUtf8(decryptItemPlaintext(vaultKey, ctx, item));
  const parsed = ItemPayload.safeParse(JSON.parse(json));
  if (!parsed.success || parsed.data.type !== ctx.type) throw new CryptoError('schema_mismatch');
  return parsed.data;
}

/**
 * Key rotation for an old revision (kept for history): only the item key is re-wrapped
 * under the new vault key; the content of past revisions is not re-encrypted.
 */
export function rewrapItemKey(
  oldVaultKey: Uint8Array,
  newVaultKey: Uint8Array,
  ctx: {
    vaultId: string;
    itemId: string;
    revision: number;
    oldKeyVersion: number;
    newKeyVersion: number;
  },
  itemKeyWrapped: string,
): string {
  const itemKey = unwrapItemKey(
    oldVaultKey,
    { ...ctx, keyVersion: ctx.oldKeyVersion },
    itemKeyWrapped,
  );
  const out = sealEnvelope(
    newVaultKey,
    itemKey,
    aad.itemKey(ctx.vaultId, ctx.itemId, ctx.revision, ctx.newKeyVersion),
  );
  wipe(itemKey);
  return toB64(out);
}

/**
 * Rollback guard (doc 17 §7 threat table): the client remembers the highest revision it has
 * seen per item and refuses anything lower.
 */
export class RevisionGuard {
  private readonly seen = new Map<string, number>();

  check(itemId: string, revision: number): boolean {
    const prev = this.seen.get(itemId) ?? 0;
    if (revision < prev) return false;
    this.seen.set(itemId, revision);
    return true;
  }

  clear() {
    this.seen.clear();
  }
}
