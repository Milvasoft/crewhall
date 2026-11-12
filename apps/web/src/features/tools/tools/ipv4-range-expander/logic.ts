// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/ipv4-range-expander/logic.ts. See THIRD_PARTY.md.
import { ipToLong, longToIp, prefixToMask } from '@/features/tools/lib/net/ipv4';

export interface RangeResult {
  inputStart: string;
  inputEnd: string;
  newStart: string;
  newEnd: string;
  cidr: string;
  prefix: number;
  netmask: string;
  addresses: number;
}

/**
 * Given two IPv4 addresses, find the smallest single CIDR block that fully
 * contains the range. The block boundaries usually extend the input range
 * outward to align with the network and broadcast addresses.
 */
export function expandRange(startIp: string, endIp: string): RangeResult {
  let start = ipToLong(startIp);
  let end = ipToLong(endIp);
  if (start > end) [start, end] = [end, start];

  // Most-significant differing bit sets the prefix length.
  let xor = (start ^ end) >>> 0;
  let diffBits = 0;
  while (xor > 0) {
    diffBits++;
    xor >>>= 1;
  }
  const prefix = 32 - diffBits;
  const mask = prefixToMask(prefix);
  const network = (start & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;

  return {
    inputStart: longToIp(start),
    inputEnd: longToIp(end),
    newStart: longToIp(network),
    newEnd: longToIp(broadcast),
    cidr: `${longToIp(network)}/${prefix}`,
    prefix,
    netmask: longToIp(mask),
    addresses: 2 ** (32 - prefix),
  };
}
