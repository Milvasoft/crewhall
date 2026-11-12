// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/ipv4-address-converter/logic.ts. See THIRD_PARTY.md.
import { ipToLong, longToIp } from '@/features/tools/lib/net/ipv4';

export interface AddressForms {
  dotted: string;
  decimal: string;
  hex: string;
  octal: string;
  binary: string;
  ipv6: string;
  ipv6Hex: string;
}

/**
 * Parse an IPv4 address written as dotted-quad, decimal integer, or a
 * 0x/0o/0b-prefixed integer into an unsigned 32-bit value.
 */
export function parseFlexible(input: string): number {
  const s = input.trim();
  if (!s) throw new Error('Enter an address.');

  if (s.includes('.')) return ipToLong(s);

  let value: number;
  if (/^0x[0-9a-f]+$/i.test(s)) value = parseInt(s.slice(2), 16);
  else if (/^0o[0-7]+$/i.test(s)) value = parseInt(s.slice(2), 8);
  else if (/^0b[01]+$/i.test(s)) value = parseInt(s.slice(2), 2);
  else if (/^\d+$/.test(s)) value = Number(s);
  else throw new Error('Unrecognized address format.');

  if (!Number.isFinite(value) || value < 0 || value > 0xffffffff) {
    throw new Error('Value out of the 32-bit IPv4 range.');
  }
  return value >>> 0;
}

export function convertAddress(input: string): AddressForms {
  const v = parseFlexible(input);
  const g1 = ((v >>> 16) & 0xffff).toString(16).padStart(4, '0');
  const g2 = (v & 0xffff).toString(16).padStart(4, '0');
  const dotted = longToIp(v);
  return {
    dotted,
    decimal: String(v),
    hex: '0x' + v.toString(16).padStart(8, '0'),
    octal: '0o' + v.toString(8),
    binary: dotted
      .split('.')
      .map((o) => Number(o).toString(2).padStart(8, '0'))
      .join('.'),
    ipv6: `::ffff:${dotted}`,
    ipv6Hex: `::ffff:${g1}:${g2}`,
  };
}
