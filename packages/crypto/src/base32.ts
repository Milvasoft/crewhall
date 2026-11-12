import { CryptoError } from './bytes';

/** RFC 4648 base32 alphabet (no padding). No 0, 1, 8 or 9: easy to read aloud and write down. */
export const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function toBase32(bytes: Uint8Array): string {
  let out = '';
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32_ALPHABET[(acc >> bits) & 31];
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32_ALPHABET[(acc << (5 - bits)) & 31];
  return out;
}

/**
 * Lenient decode for typed input: case, spaces, dashes and `=` padding are ignored; the
 * look-alike digits 0/1/8 read as O/I/B.
 */
export function fromBase32(text: string): Uint8Array {
  const clean = text
    .toUpperCase()
    .replace(/[\s\-=]/g, '')
    .replace(/0/g, 'O')
    .replace(/1/g, 'I')
    .replace(/8/g, 'B');
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const ch of clean) {
    const v = BASE32_ALPHABET.indexOf(ch);
    if (v < 0) throw new CryptoError('invalid_encoding', 'bad base32 character');
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 255);
    }
    acc &= (1 << bits) - 1;
  }
  return Uint8Array.from(out);
}
