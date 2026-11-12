import {
  decryptAttachment,
  encryptAttachment,
  fromB64,
  newFileKey,
  newId,
  toB64,
  wipe,
  type AttachmentRef,
} from '@crewhall/crypto';
import { api } from '@/lib/api';

/**
 * Encrypted attachments (design 8.8 "Cihazda şifrelenip yüklenir · en çok 100 MB"): a fresh
 * file key per file, kept only inside the encrypted item; the store receives ciphertext.
 */

export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;

export async function uploadAttachment(itemId: string, file: File): Promise<AttachmentRef> {
  if (file.size > MAX_ATTACHMENT_BYTES) throw new Error('too_large');
  const id = newId();
  const key = newFileKey();
  const encrypted = encryptAttachment(key, id, new Uint8Array(await file.arrayBuffer()));
  const up = await api.call('vaultCreateAttachment', {
    params: { itemId },
    body: { id, size: encrypted.length },
  });
  const parts: { partNumber: number; etag: string }[] = [];
  for (const p of up.parts) {
    const body = encrypted.slice((p.partNumber - 1) * up.partSize, p.partNumber * up.partSize);
    const res = await fetch(p.url, { method: 'PUT', body });
    if (!res.ok) throw new Error(`upload ${res.status}`);
    parts.push({ partNumber: p.partNumber, etag: res.headers.get('etag') ?? '' });
  }
  await api.call('vaultCompleteAttachment', {
    params: { itemId, attachmentId: id },
    body: { parts },
  });
  const ref = {
    id,
    name: file.name.slice(0, 255) || 'file',
    size: file.size,
    mime: file.type || null,
    key: toB64(key),
  };
  wipe(key);
  return ref;
}

/** Downloads, decrypts in memory and hands the file to the browser. */
/** Fetches and decrypts an attachment into a blob URL (memory only; revoke it when done). */
export async function attachmentBlobUrl(itemId: string, ref: AttachmentRef): Promise<string> {
  const { url } = await api.call('vaultAttachmentUrl', {
    params: { itemId, attachmentId: ref.id },
  });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${res.status}`);
  const key = fromB64(ref.key);
  const plain = decryptAttachment(key, ref.id, new Uint8Array(await res.arrayBuffer()));
  wipe(key);
  return URL.createObjectURL(
    new Blob([plain.slice().buffer as ArrayBuffer], {
      type: ref.mime ?? 'application/octet-stream',
    }),
  );
}

export async function downloadAttachment(itemId: string, ref: AttachmentRef) {
  const blobUrl = await attachmentBlobUrl(itemId, ref);
  const a = document.createElement('a');
  a.href = blobUrl;
  a.download = ref.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(blobUrl), 2000);
}

export async function deleteAttachment(itemId: string, attachmentId: string) {
  await api.call('vaultDeleteAttachment', { params: { itemId, attachmentId } });
}
