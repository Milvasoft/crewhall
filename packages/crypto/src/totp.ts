import { hmac } from '@noble/hashes/hmac.js';
import { sha1 } from '@noble/hashes/legacy.js';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { fromBase32 } from './base32';
import { CryptoError } from './bytes';
import type { ItemPayload } from './item';

/** TOTP (RFC 6238) computed on the device (design 8.5). */

export type TotpAlgorithm = 'SHA1' | 'SHA256' | 'SHA512';

export interface TotpConfig {
  secret: Uint8Array;
  algorithm: TotpAlgorithm;
  digits: number;
  period: number;
  issuer?: string;
  account?: string;
}

/**
 * Accepts an `otpauth://totp/...` URI or a bare base32 secret (spaces allowed), as pasted
 * in the edit form (design 8.8). Returns null when it is neither.
 */
export function parseTotp(input: string): TotpConfig | null {
  const text = input.trim();
  if (!text) return null;
  // Parsed by hand: React Native's URL has no searchParams.
  const m = /^otpauth:\/\/([^/?#]+)\/?([^?#]*)(?:\?([^#]*))?/i.exec(text);
  if (m) {
    if ((m[1] ?? '').toLowerCase() !== 'totp') return null;
    const params = new Map<string, string>();
    for (const pair of (m[3] ?? '').split('&')) {
      if (!pair) continue;
      const eq = pair.indexOf('=');
      const k = safeDecode(eq < 0 ? pair : pair.slice(0, eq)).toLowerCase();
      if (!params.has(k)) params.set(k, safeDecode(eq < 0 ? '' : pair.slice(eq + 1)));
    }
    const secretText = params.get('secret');
    if (!secretText) return null;
    const algorithm = (params.get('algorithm') ?? 'SHA1').toUpperCase();
    const digits = Number(params.get('digits') ?? 6);
    const period = Number(params.get('period') ?? 30);
    if (!['SHA1', 'SHA256', 'SHA512'].includes(algorithm)) return null;
    if (![6, 7, 8].includes(digits) || !Number.isInteger(period) || period < 1 || period > 300)
      return null;
    const label = safeDecode(m[2] ?? '');
    const [issuerPart, account] = label.includes(':') ? label.split(/:(.*)/s) : [undefined, label];
    let secret: Uint8Array;
    try {
      secret = fromBase32(secretText);
    } catch {
      return null;
    }
    if (secret.length < 10) return null;
    return {
      secret,
      algorithm: algorithm as TotpAlgorithm,
      digits,
      period,
      issuer: params.get('issuer') ?? issuerPart?.trim() ?? undefined,
      account: account?.trim() || undefined,
    };
  }
  try {
    const secret = fromBase32(text);
    return secret.length >= 10 ? { secret, algorithm: 'SHA1', digits: 6, period: 30 } : null;
  } catch {
    return null;
  }
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s;
  }
}

function hotp(cfg: TotpConfig, counter: number): string {
  const msg = new Uint8Array(8);
  let c = counter;
  for (let i = 7; i >= 0; i--) {
    msg[i] = c & 255;
    c = Math.floor(c / 256);
  }
  const hash = cfg.algorithm === 'SHA256' ? sha256 : cfg.algorithm === 'SHA512' ? sha512 : sha1;
  const mac = hmac(hash, cfg.secret, msg);
  const offset = (mac[mac.length - 1] as number) & 15;
  const bin =
    (((mac[offset] as number) & 0x7f) << 24) |
    ((mac[offset + 1] as number) << 16) |
    ((mac[offset + 2] as number) << 8) |
    (mac[offset + 3] as number);
  return String(bin % 10 ** cfg.digits).padStart(cfg.digits, '0');
}

export interface TotpCode {
  code: string;
  /** Seconds until this code expires. */
  remaining: number;
  period: number;
}

export function totpAt(cfg: TotpConfig, unixMs: number): TotpCode {
  if (!Number.isFinite(unixMs)) throw new CryptoError('invalid_input', 'time');
  const seconds = Math.floor(unixMs / 1000);
  const counter = Math.floor(seconds / cfg.period);
  return {
    code: hotp(cfg, counter),
    remaining: cfg.period - (seconds % cfg.period),
    period: cfg.period,
  };
}

/**
 * The code to copy (design 8.5): when fewer than `minRemaining` seconds are left, the next
 * code is copied instead.
 */
export function totpForCopy(cfg: TotpConfig, unixMs: number, minRemaining = 5): string {
  const now = totpAt(cfg, unixMs);
  return now.remaining < minRemaining ? totpAt(cfg, unixMs + now.remaining * 1000).code : now.code;
}

/** "482 913" style grouping for display. */
export function formatTotp(code: string): string {
  return code.length === 6
    ? `${code.slice(0, 3)} ${code.slice(3)}`
    : code.length === 8
      ? `${code.slice(0, 4)} ${code.slice(4)}`
      : code;
}

const TOTP_LABEL = /^(totp|otp|2fa|mfa|one[- ]?time|tek kullan[ıi]ml[ıi]k|doğrulama kodu)/i;

/**
 * The TOTP secret of an item (roadmap 20): a login's own TOTP field, otherwise the first
 * custom field holding an `otpauth://totp/` URI, or a field labelled like "TOTP" / "2FA" with a
 * valid base32 secret (imports keep TOTP there for non-login items). '' when there is none.
 */
export function totpSourceOf(p: ItemPayload): string {
  if (p.type === 'login' && p.totp.trim()) return p.totp;
  for (const f of p.fields) {
    const v = f.value.trim();
    if (!v || f.type === 'boolean' || f.type === 'date') continue;
    if (/^otpauth:\/\/totp\//i.test(v) && parseTotp(v)) return f.value;
  }
  for (const f of p.fields) {
    if (f.type === 'boolean' || f.type === 'date') continue;
    if (TOTP_LABEL.test(f.label.trim()) && parseTotp(f.value)) return f.value;
  }
  return '';
}
