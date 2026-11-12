import { aadOf, aesGcmDecrypt, aesGcmEncrypt, KEY_LENGTH, NONCE_LENGTH } from './aead';
import { CryptoError, fromB64, fromUtf8, toB64, toB64Url, utf8 } from './bytes';
import { aad } from './context';
import { ItemPayload } from './item';
import { randomBytes } from './random';
import { totpSourceOf } from './totp';

/**
 * One-time share links (roadmap 20). The item is re-encrypted on the device under a fresh
 * 256-bit key that exists only in the link's fragment (`…/kasa-paylasim/<token>#<key>`):
 * browsers never send the fragment, so the server stores ciphertext it cannot open. The
 * server limits the link by time and number of opens and deletes the ciphertext after the
 * last one.
 */

export interface ShareOptions {
  /** Keep the TOTP secret: whoever opens the link could generate codes forever. Default off. */
  includeTotp?: boolean;
  /** Keep the notes. Default on. */
  includeNotes?: boolean;
}

/**
 * What a link carries: the item without its history, attachments (their keys would be
 * useless without access to the blobs), import notes, tags and favourite flag.
 */
export function sharePayloadOf(item: ItemPayload, opts: ShareOptions = {}): ItemPayload {
  const totp = totpSourceOf(item);
  const fields =
    !totp || opts.includeTotp ? item.fields : item.fields.filter((f) => f.value !== totp);
  const out = {
    ...item,
    favorite: false,
    tags: [],
    attachments: [],
    passwordHistory: [],
    importWarnings: [],
    notes: opts.includeNotes === false ? '' : item.notes,
    fields,
  };
  delete (out as { importedFrom?: unknown }).importedFrom;
  if (out.type === 'login' && !opts.includeTotp) return { ...out, totp: '' };
  return out;
}

export interface EncryptedShare {
  ciphertext: string;
  nonce: string;
}

export const newShareKey = () => randomBytes(KEY_LENGTH);

export function encryptShare(
  key: Uint8Array,
  payload: ItemPayload,
  nonce: Uint8Array = randomBytes(NONCE_LENGTH),
): EncryptedShare {
  const ct = aesGcmEncrypt(key, nonce, utf8(JSON.stringify(payload)), aadOf(aad.share()));
  return { ciphertext: toB64(ct), nonce: toB64(nonce) };
}

export function decryptShare(key: Uint8Array, enc: EncryptedShare): ItemPayload {
  const plain = aesGcmDecrypt(key, fromB64(enc.nonce), fromB64(enc.ciphertext), aadOf(aad.share()));
  let json: unknown;
  try {
    json = JSON.parse(fromUtf8(plain));
  } catch {
    throw new CryptoError('schema_mismatch', 'share is not JSON');
  }
  const parsed = ItemPayload.safeParse(json);
  if (!parsed.success) throw new CryptoError('schema_mismatch', 'share payload');
  return parsed.data;
}

/** The key as it goes into the URL fragment (base64url, 43 characters). */
export const shareFragment = (key: Uint8Array) => toB64Url(key);

/** Reads the key back from `location.hash` (with or without the leading '#'); null if invalid. */
export function shareKeyFromFragment(fragment: string): Uint8Array | null {
  const text = fragment.replace(/^#/, '').trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(text)) return null;
  try {
    const key = fromB64(text);
    return key.length === KEY_LENGTH ? key : null;
  } catch {
    return null;
  }
}
