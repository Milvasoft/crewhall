import { aesGcmDecrypt, aesGcmEncrypt, aadOf, KEY_LENGTH } from './aead';
import { concat, CryptoError, u32be } from './bytes';
import { aad } from './context';
import { randomBytes } from './random';

/**
 * Attachment encryption (design "Ekler dosya başına rastgele anahtarla şifrelenir"): a random
 * file key per attachment, kept inside the encrypted item. The file is cut into 1 MiB chunks so
 * large files never sit twice in memory and can be streamed; each chunk is AES-256-GCM with
 * nonce = prefix(8) || index(4) and AAD (attachment id, index, final flag), which stops
 * reordering and truncation.
 *
 * Layout: `0x01 || noncePrefix(8) || chunk0 || chunk1 || …`, chunk = ciphertext || tag(16).
 */

export const ATTACHMENT_CHUNK = 1024 * 1024;
const VERSION = 1;
const HEADER = 9;
const TAG = 16;

export function newFileKey(): Uint8Array {
  return randomBytes(KEY_LENGTH);
}

export function encryptedSize(plainSize: number): number {
  const chunks = Math.max(1, Math.ceil(plainSize / ATTACHMENT_CHUNK));
  return HEADER + plainSize + chunks * TAG;
}

function nonceFor(prefix: Uint8Array, index: number) {
  return concat(prefix, u32be(index));
}

export function encryptAttachment(
  fileKey: Uint8Array,
  attachmentId: string,
  data: Uint8Array,
  noncePrefix: Uint8Array = randomBytes(8),
): Uint8Array {
  const out = new Uint8Array(encryptedSize(data.length));
  out[0] = VERSION;
  out.set(noncePrefix, 1);
  const chunks = Math.max(1, Math.ceil(data.length / ATTACHMENT_CHUNK));
  let o = HEADER;
  for (let i = 0; i < chunks; i++) {
    const part = data.subarray(i * ATTACHMENT_CHUNK, (i + 1) * ATTACHMENT_CHUNK);
    const final = i === chunks - 1;
    const ct = aesGcmEncrypt(
      fileKey,
      nonceFor(noncePrefix, i),
      part,
      aadOf(aad.attachment(attachmentId, i, final)),
    );
    out.set(ct, o);
    o += ct.length;
  }
  return out;
}

export function decryptAttachment(
  fileKey: Uint8Array,
  attachmentId: string,
  blob: Uint8Array,
): Uint8Array {
  if (blob.length < HEADER + TAG || blob[0] !== VERSION)
    throw new CryptoError('decrypt_failed', 'unknown attachment format');
  const prefix = blob.subarray(1, HEADER);
  const body = blob.subarray(HEADER);
  const step = ATTACHMENT_CHUNK + TAG;
  const chunks = Math.max(1, Math.ceil(body.length / step));
  const out = new Uint8Array(body.length - chunks * TAG);
  let o = 0;
  for (let i = 0; i < chunks; i++) {
    const part = body.subarray(i * step, (i + 1) * step);
    const final = i === chunks - 1;
    const pt = aesGcmDecrypt(
      fileKey,
      nonceFor(prefix, i),
      part,
      aadOf(aad.attachment(attachmentId, i, final)),
    );
    out.set(pt, o);
    o += pt.length;
  }
  return out;
}
