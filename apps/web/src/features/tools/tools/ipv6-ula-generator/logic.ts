// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/ipv6-ula-generator/logic.ts. See THIRD_PARTY.md.
/**
 * RFC 4193 Unique Local Address (ULA) generator. A ULA is `fd00::/8` followed
 * by a random 40-bit Global ID and a 16-bit Subnet ID. Pure and local — the
 * caller supplies randomness so this stays deterministic and testable.
 */

const hex4 = (n: number) => (n & 0xffff).toString(16).padStart(4, '0');

export interface UlaResult {
  /** 40-bit Global ID as 10 hex characters. */
  globalId: string;
  /** The /48 ULA prefix, e.g. `fd12:3456:789a::/48`. */
  prefix48: string;
  /** 16-bit Subnet ID as 4 hex characters. */
  subnetId: string;
  /** A /64 network within the prefix, e.g. `fd12:3456:789a:0001::/64`. */
  prefix64: string;
  /** The first address of the /64 network. */
  firstAddress: string;
}

/**
 * Build a ULA from a 5-byte Global ID and a subnet number (0–65535).
 * Pass random bytes for a real address; fixed bytes make tests deterministic.
 */
export function generateUla(globalIdBytes: Uint8Array, subnet = 0): UlaResult {
  if (globalIdBytes.length < 5) {
    throw new Error('Global ID needs 5 bytes (40 bits).');
  }
  // Length is checked above, so the first five bytes exist.
  const [g0, g1, g2, g3, g4] = [0, 1, 2, 3, 4].map((i) => globalIdBytes[i]!) as [
    number,
    number,
    number,
    number,
    number,
  ];
  const group1 = 0xfd00 | g0; // 0xfd prefix + top 8 bits of the Global ID
  const group2 = (g1 << 8) | g2;
  const group3 = (g3 << 8) | g4;
  const subnetId = subnet & 0xffff;

  const base = `${hex4(group1)}:${hex4(group2)}:${hex4(group3)}`;
  const globalId = [g0, g1, g2, g3, g4].map((b) => b.toString(16).padStart(2, '0')).join('');

  return {
    globalId,
    prefix48: `${base}::/48`,
    subnetId: hex4(subnetId),
    prefix64: `${base}:${hex4(subnetId)}::/64`,
    firstAddress: `${base}:${hex4(subnetId)}::1`,
  };
}

/** Convenience wrapper that draws 5 random bytes from the Web Crypto API. */
export function randomUla(subnet = 0): UlaResult {
  const bytes = new Uint8Array(5);
  crypto.getRandomValues(bytes);
  return generateUla(bytes, subnet);
}
