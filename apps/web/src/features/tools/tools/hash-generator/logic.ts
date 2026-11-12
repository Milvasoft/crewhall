// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/hash-generator/logic.ts. See THIRD_PARTY.md.
/**
 * Digests via the Web Crypto API (SubtleCrypto), fully local, no libraries.
 * MD5 is intentionally unavailable: SubtleCrypto does not provide it and it is
 * cryptographically broken; we surface only SHA family + HMAC.
 */

export type HashAlgo = 'SHA-1' | 'SHA-256' | 'SHA-384' | 'SHA-512';

export const HASH_ALGOS: HashAlgo[] = ['SHA-1', 'SHA-256', 'SHA-384', 'SHA-512'];

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i]!.toString(16).padStart(2, '0');
  return out;
}

export async function hash(text: string, algo: HashAlgo): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest(algo, data);
  return toHex(digest);
}

export async function hmac(text: string, key: string, algo: HashAlgo): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(key),
    { name: 'HMAC', hash: algo },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(text));
  return toHex(sig);
}
