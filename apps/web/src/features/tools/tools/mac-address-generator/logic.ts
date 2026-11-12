// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/mac-address-generator/logic.ts. See THIRD_PARTY.md.
import { formatMac, macHexPairs, type MacSeparator } from '@/features/tools/lib/net/mac';

export interface MacGenOptions {
  separator: MacSeparator;
  uppercase: boolean;
  /** Optional OUI prefix to force the first octets (e.g. "00:11:22"). */
  prefix?: string;
}

/** Build six byte values from a random source, overriding with a prefix if given. */
export function macBytesFrom(random: Uint8Array, prefix?: string): number[] {
  const bytes = Array.from({ length: 6 }, (_, i) => (random[i] ?? 0) & 0xff);
  if (prefix && prefix.trim()) {
    const pairs = macHexPairs(prefix);
    for (let i = 0; i < pairs.length && i < 6; i++) {
      bytes[i] = parseInt(pairs[i]!, 16);
    }
  }
  return bytes;
}

export function generateMac(random: Uint8Array, opts: MacGenOptions): string {
  return formatMac(macBytesFrom(random, opts.prefix), opts.separator, opts.uppercase);
}

/** Draw a random MAC using the Web Crypto API. */
export function randomMac(opts: MacGenOptions): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return generateMac(bytes, opts);
}
