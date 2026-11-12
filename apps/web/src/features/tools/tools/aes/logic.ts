// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/aes/logic.ts. See THIRD_PARTY.md.
/**
 * AES-256-GCM with a passphrase, via Web Crypto. The key is derived with
 * PBKDF2 (SHA-256). Output is Base64 of `salt(16) | iv(12) | ciphertext`, so
 * decryption is self-contained. Fully local, nothing is transmitted.
 */

const ITERATIONS = 100_000;
const enc = new TextEncoder();
const dec = new TextDecoder();

// Web Crypto's TS types want `BufferSource` backed by a plain ArrayBuffer.
const bs = (u: Uint8Array): BufferSource => u as unknown as BufferSource;

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey('raw', bs(enc.encode(password)), 'PBKDF2', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: bs(salt), iterations: ITERATIONS, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array {
  const s = atob(b64.trim());
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export async function aesEncrypt(plaintext: string, password: string): Promise<string> {
  if (!password) throw new Error('A passphrase is required.');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: bs(iv) }, key, bs(enc.encode(plaintext))),
  );
  const blob = new Uint8Array(salt.length + iv.length + ct.length);
  blob.set(salt, 0);
  blob.set(iv, salt.length);
  blob.set(ct, salt.length + iv.length);
  return toBase64(blob);
}

export async function aesDecrypt(payload: string, password: string): Promise<string> {
  if (!password) throw new Error('A passphrase is required.');
  const blob = fromBase64(payload);
  if (blob.length < 28) throw new Error('Ciphertext is too short or malformed.');
  const salt = blob.slice(0, 16);
  const iv = blob.slice(16, 28);
  const ct = blob.slice(28);
  const key = await deriveKey(password, salt);
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bs(iv) }, key, bs(ct));
    return dec.decode(pt);
  } catch {
    throw new Error('Decryption failed, wrong passphrase or corrupted data.');
  }
}
