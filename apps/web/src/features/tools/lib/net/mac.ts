// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/lib/net/mac.ts. See THIRD_PARTY.md.
/**
 * Pure MAC-address helpers shared by the MAC tools.
 */

export type MacSeparator = ':' | '-' | '.' | '';

/** Strip separators and return lowercase hex pairs. */
export function macHexPairs(input: string): string[] {
  const clean = input
    .trim()
    .toLowerCase()
    .replace(/[^0-9a-f]/g, '');
  return clean.match(/.{1,2}/g) ?? [];
}

/** The OUI (first three octets) as 6 uppercase hex chars. Throws if too short. */
export function parseOui(input: string): string {
  const clean = input
    .trim()
    .toUpperCase()
    .replace(/[^0-9A-F]/g, '');
  if (clean.length < 6) {
    throw new Error('Enter at least 6 hex digits (the first three octets).');
  }
  return clean.slice(0, 6);
}

/** Format six byte values into a MAC string in the chosen style. */
export function formatMac(bytes: number[], separator: MacSeparator, uppercase: boolean): string {
  const hex = bytes.map((b) => (b & 0xff).toString(16).padStart(2, '0'));
  let s: string;
  if (separator === '.') {
    // Cisco-style dotted groups: aabb.ccdd.eeff
    s = hex.join('').replace(/(.{4})(?=.)/g, '$1.');
  } else {
    s = hex.join(separator);
  }
  return uppercase ? s.toUpperCase() : s;
}
