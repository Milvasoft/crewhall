// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/base64/logic.ts. See THIRD_PARTY.md.
/**
 * UTF-8 safe Base64. The native btoa/atob only handle Latin-1, so we round-trip
 * through TextEncoder/Decoder to support the full Unicode range.
 */

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export interface EncodeOptions {
  urlSafe?: boolean;
  /** Strip `=` padding (common for URL-safe tokens). */
  noPadding?: boolean;
}

export function encodeBase64(text: string, opts: EncodeOptions = {}): string {
  const bytes = new TextEncoder().encode(text);
  let out = bytesToBase64(bytes);
  if (opts.urlSafe) out = out.replace(/\+/g, '-').replace(/\//g, '_');
  if (opts.noPadding) out = out.replace(/=+$/, '');
  return out;
}

export function decodeBase64(input: string): string {
  let b64 = input.trim().replace(/\s+/g, '');
  // Accept URL-safe alphabet.
  b64 = b64.replace(/-/g, '+').replace(/_/g, '/');
  // Restore padding if missing.
  const pad = b64.length % 4;
  if (pad === 2) b64 += '==';
  else if (pad === 3) b64 += '=';
  else if (pad === 1) throw new Error('Invalid Base64: length is not valid.');

  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) {
    throw new Error('Input contains characters that are not valid Base64.');
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(base64ToBytes(b64));
}
