/**
 * Byte helpers without platform globals (no Buffer, TextEncoder, atob): the same code runs
 * in browsers, Node and React Native (Hermes).
 */

export class CryptoError extends Error {
  constructor(
    readonly code:
      | 'decrypt_failed'
      | 'invalid_input'
      | 'invalid_encoding'
      | 'invalid_recovery_key'
      | 'weak_kdf'
      | 'random_unavailable'
      | 'schema_mismatch',
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'CryptoError';
  }
}

/** UTF-8 encode (WHATWG semantics: lone surrogates become U+FFFD). */
export function utf8(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let cp = text.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (next - 0xdc00);
        i++;
      } else cp = 0xfffd;
    } else if (cp >= 0xdc00 && cp <= 0xdfff) cp = 0xfffd;
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 63),
        0x80 | ((cp >> 6) & 63),
        0x80 | (cp & 63),
      );
  }
  return Uint8Array.from(out);
}

/** Strict UTF-8 decode; malformed input throws instead of being replaced silently. */
export function fromUtf8(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  const bad = () => {
    throw new CryptoError('invalid_encoding', 'malformed UTF-8');
  };
  const cont = (k: number) => {
    const b = bytes[k];
    if (b === undefined || (b & 0xc0) !== 0x80) bad();
    return (b as number) & 63;
  };
  while (i < bytes.length) {
    const b = bytes[i] as number;
    let cp: number;
    if (b < 0x80) {
      cp = b;
      i += 1;
    } else if (b >= 0xc2 && b < 0xe0) {
      cp = ((b & 31) << 6) | cont(i + 1);
      i += 2;
    } else if (b >= 0xe0 && b < 0xf0) {
      cp = ((b & 15) << 12) | (cont(i + 1) << 6) | cont(i + 2);
      if (cp < 0x800 || (cp >= 0xd800 && cp <= 0xdfff)) bad();
      i += 3;
    } else if (b >= 0xf0 && b < 0xf5) {
      cp = ((b & 7) << 18) | (cont(i + 1) << 12) | (cont(i + 2) << 6) | cont(i + 3);
      if (cp < 0x10000 || cp > 0x10ffff) bad();
      i += 4;
    } else return bad();
    if (cp >= 0x10000) {
      cp -= 0x10000;
      out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
    } else out += String.fromCharCode(cp);
  }
  return out;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i;
  // URL-safe alphabet decodes too.
  t['-'.charCodeAt(0)] = 62;
  t['_'.charCodeAt(0)] = 63;
  return t;
})();

/** Standard base64 with padding (the API's byte encoding). */
export function toB64(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n =
      ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8) | (bytes[i + 2] as number);
    out += B64[n >> 18]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + B64[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = (bytes[i] as number) << 16;
    out += B64[n >> 18]! + B64[(n >> 12) & 63]! + '==';
  } else if (rest === 2) {
    const n = ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8);
    out += B64[n >> 18]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + '=';
  }
  return out;
}

/** Decodes standard or URL-safe base64, padded or not; whitespace is ignored. */
export function fromB64(text: string): Uint8Array {
  const clean = text.replace(/[\s=]/g, '');
  if (clean.length % 4 === 1) throw new CryptoError('invalid_encoding', 'bad base64 length');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let acc = 0;
  let o = 0;
  for (let i = 0; i < clean.length; i++) {
    const c = clean.charCodeAt(i);
    const v = c < 128 ? (B64_LOOKUP[c] as number) : -1;
    if (v < 0) throw new CryptoError('invalid_encoding', 'bad base64 character');
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, o);
}

export function toB64Url(bytes: Uint8Array): string {
  return toB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export function fromHex(hex: string): Uint8Array {
  const clean = hex.replace(/\s/g, '');
  if (clean.length % 2 || /[^0-9a-f]/i.test(clean)) {
    throw new CryptoError('invalid_encoding', 'bad hex');
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Constant-time comparison for equal-length secrets. */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

export function u32be(n: number): Uint8Array {
  return Uint8Array.of((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
}

/** Best effort: overwrite key material once it is no longer needed. */
export function wipe(...arrays: (Uint8Array | null | undefined)[]) {
  for (const a of arrays) a?.fill(0);
}
