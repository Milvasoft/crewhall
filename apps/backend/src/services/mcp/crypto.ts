import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Secrets of the MCP module (doc 17 §13): opaque random values with a readable prefix.
 * Only their sha256 is stored, so a database dump does not reveal a usable token.
 */
export const TOKEN_PREFIX = {
  pat: 'mhp_',
  access: 'mha_',
  refresh: 'mhr_',
  code: 'mhc_',
  client: 'mcp_c_',
} as const;

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** Unbiased base62 string of `length` characters (≈5.95 bits each). */
export function randomBase62(length: number): string {
  let out = '';
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      // 248 = 4 * 62: drop bytes that would skew the distribution.
      if (byte < 248) out += BASE62[byte % 62];
      if (out.length === length) break;
    }
  }
  return out;
}

export const newSecret = (prefix: string, length = 40) => `${prefix}${randomBase62(length)}`;

export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** RFC 7636 S256: BASE64URL(SHA256(verifier)) compared in constant time. */
export function pkceMatches(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return false;
  const computed = createHash('sha256').update(verifier).digest('base64url');
  return safeEqual(computed, challenge);
}

/** Short-lived signed value (consent CSRF token): `<payload>.<exp>.<mac>`. */
export function signValue(secret: string, payload: string, ttlMs: number): string {
  const exp = Date.now() + ttlMs;
  const body = `${payload}.${exp}`;
  const mac = createHmac('sha256', secret).update(body).digest('base64url');
  return `${Buffer.from(body).toString('base64url')}.${mac}`;
}

/** Returns the payload when the signature is valid and not expired. */
export function verifySigned(secret: string, token: string): string | null {
  const [encoded, mac] = token.split('.');
  if (!encoded || !mac) return null;
  const body = Buffer.from(encoded, 'base64url').toString('utf8');
  const expected = createHmac('sha256', secret).update(body).digest('base64url');
  if (!safeEqual(expected, mac)) return null;
  const dot = body.lastIndexOf('.');
  const exp = Number(body.slice(dot + 1));
  if (!Number.isFinite(exp) || exp < Date.now()) return null;
  return body.slice(0, dot);
}
