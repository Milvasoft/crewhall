// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/totp-generator/logic.ts. See THIRD_PARTY.md.
/**
 * HOTP (RFC 4226) and TOTP (RFC 6238) implemented with the Web Crypto API, plus
 * base32 handling for the shared secret. Everything runs locally.
 */

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

// Web Crypto typings want ArrayBuffer-backed views; our Uint8Arrays are fine.
const buf = (u: Uint8Array): BufferSource => u as unknown as BufferSource;

export type OtpAlgorithm = 'SHA-1' | 'SHA-256' | 'SHA-512';

export function base32Encode(bytes: Uint8Array): string {
  let bits = '';
  for (const b of bytes) bits += b.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i + 5 <= bits.length; i += 5) {
    out += B32_ALPHABET[parseInt(bits.slice(i, i + 5), 2)];
  }
  const rem = bits.length % 5;
  if (rem !== 0) {
    out += B32_ALPHABET[parseInt(bits.slice(bits.length - rem).padEnd(5, '0'), 2)];
  }
  return out;
}

export function base32Decode(input: string): Uint8Array {
  const clean = input.toUpperCase().replace(/[\s=]/g, '');
  let bits = '';
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error(`Invalid base32 character: "${ch}".`);
    bits += idx.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return new Uint8Array(bytes);
}

export function randomSecret(bytes = 20): Uint8Array {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return buf;
}

async function hmac(
  key: Uint8Array,
  message: Uint8Array,
  algorithm: OtpAlgorithm,
): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    buf(key),
    { name: 'HMAC', hash: algorithm },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, buf(message));
  return new Uint8Array(sig);
}

/** RFC 4226 HOTP for a specific counter. */
export async function hotp(
  secret: Uint8Array,
  counter: number,
  digits = 6,
  algorithm: OtpAlgorithm = 'SHA-1',
): Promise<string> {
  const msg = new Uint8Array(8);
  let c = counter;
  for (let i = 7; i >= 0; i--) {
    msg[i] = c & 0xff;
    c = Math.floor(c / 256);
  }
  const hash = await hmac(secret, msg, algorithm);
  const offset = hash[hash.length - 1]! & 0x0f;
  const binary =
    ((hash[offset]! & 0x7f) << 24) |
    ((hash[offset + 1]! & 0xff) << 16) |
    ((hash[offset + 2]! & 0xff) << 8) |
    (hash[offset + 3]! & 0xff);
  return (binary % 10 ** digits).toString().padStart(digits, '0');
}

export interface TotpOptions {
  digits?: number;
  period?: number;
  algorithm?: OtpAlgorithm;
  /** Unix time in seconds; defaults to now. */
  now?: number;
}

export interface TotpResult {
  code: string;
  secondsRemaining: number;
}

/** RFC 6238 TOTP for the current (or given) time. */
export async function totp(secret: Uint8Array, opts: TotpOptions = {}): Promise<TotpResult> {
  const { digits = 6, period = 30, algorithm = 'SHA-1' } = opts;
  const seconds = opts.now ?? Date.now() / 1000;
  const counter = Math.floor(seconds / period);
  return {
    code: await hotp(secret, counter, digits, algorithm),
    secondsRemaining: period - (Math.floor(seconds) % period),
  };
}

/** Build the otpauth:// provisioning URI (for QR codes / authenticator apps). */
export function otpauthUri(
  secretBase32: string,
  {
    issuer = 'Too Much Tools',
    account = 'user',
    digits = 6,
    period = 30,
    algorithm = 'SHA-1' as OtpAlgorithm,
  } = {},
): string {
  // Label is "issuer:account" with each part percent-encoded but the colon kept
  // literal as the separator (per the Key URI spec).
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  // Build the query with encodeURIComponent (which encodes spaces as %20).
  // URLSearchParams would encode spaces as "+", which authenticator apps read as
  // a literal plus, so "Acme Co" would show up as "Acme+Co" and stop matching the
  // label prefix.
  const params: Record<string, string> = {
    secret: secretBase32,
    issuer,
    algorithm: algorithm.replace('-', ''),
    digits: String(digits),
    period: String(period),
  };
  const query = Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
  return `otpauth://totp/${label}?${query}`;
}
