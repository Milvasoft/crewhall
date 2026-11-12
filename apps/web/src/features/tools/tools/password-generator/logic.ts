// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/password-generator/logic.ts. See THIRD_PARTY.md.
/** Local random generation via the platform CSPRNG (crypto.getRandomValues). */

const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const DIGITS = '0123456789';
const SYMBOLS = '!@#$%^&*()-_=+[]{};:,.<>?';
const AMBIGUOUS = /[Il1O0o]/g;

export interface PasswordOptions {
  length: number;
  lowercase: boolean;
  uppercase: boolean;
  digits: boolean;
  symbols: boolean;
  avoidAmbiguous: boolean;
}

function randomIndex(max: number): number {
  // Rejection sampling for an unbiased index in [0, max).
  const limit = Math.floor(0xffffffff / max) * max;
  const buf = new Uint32Array(1);
  let x: number;
  do {
    crypto.getRandomValues(buf);
    x = buf[0]!;
  } while (x >= limit);
  return x % max;
}

export function generatePassword(opts: PasswordOptions): string {
  let charset = '';
  if (opts.lowercase) charset += LOWER;
  if (opts.uppercase) charset += UPPER;
  if (opts.digits) charset += DIGITS;
  if (opts.symbols) charset += SYMBOLS;
  if (opts.avoidAmbiguous) charset = charset.replace(AMBIGUOUS, '');
  if (!charset) throw new Error('Select at least one character set.');

  const len = Math.max(1, Math.min(opts.length, 4096));
  let out = '';
  for (let i = 0; i < len; i++) out += charset[randomIndex(charset.length)];
  return out;
}

export type KeyEncoding = 'hex' | 'base64' | 'base64url';

export function generateKey(bits: number, encoding: KeyEncoding): string {
  const bytes = new Uint8Array(Math.max(1, bits / 8));
  crypto.getRandomValues(bytes);
  if (encoding === 'hex') {
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  const b64 = btoa(binary);
  return encoding === 'base64url'
    ? b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    : b64;
}

/** Rough Shannon-style strength estimate in bits for a generated password. */
export function estimateEntropyBits(opts: PasswordOptions): number {
  let size = 0;
  if (opts.lowercase) size += 26;
  if (opts.uppercase) size += 26;
  if (opts.digits) size += 10;
  if (opts.symbols) size += SYMBOLS.length;
  if (size === 0) return 0;
  return Math.round(opts.length * Math.log2(size));
}
