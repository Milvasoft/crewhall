// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/ipv4-subnet-calculator/logic.ts. See THIRD_PARTY.md.
import {
  ipClass,
  ipToLong,
  longToIp,
  parseCidr,
  prefixToMask,
} from '@/features/tools/lib/net/ipv4';

export interface SubnetInfo {
  cidr: string;
  address: string;
  prefix: number;
  netmask: string;
  wildcard: string;
  network: string;
  broadcast: string;
  firstHost: string;
  lastHost: string;
  totalHosts: number;
  usableHosts: number;
  ipClass: string;
  isPrivate: boolean;
}

const PRIVATE_RANGES: [string, number][] = [
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
];

function inRange(addr: number, base: string, prefix: number): boolean {
  const mask = prefixToMask(prefix);
  return (addr & mask) >>> 0 === (ipToLong(base) & mask) >>> 0;
}

/** Compute subnet facts for a CIDR (or `ip mask`) string. */
export function calculateSubnet(input: string): SubnetInfo {
  const { ip, prefix } = parseCidr(input);
  const addr = ipToLong(ip);
  const mask = prefixToMask(prefix);
  const wildcard = ~mask >>> 0;
  const network = (addr & mask) >>> 0;
  const broadcast = (network | wildcard) >>> 0;
  const total = 2 ** (32 - prefix);

  let firstHost: number;
  let lastHost: number;
  let usable: number;
  if (prefix >= 31) {
    // /31 (point-to-point) and /32 (single host) have no network/broadcast split.
    firstHost = network;
    lastHost = broadcast;
    usable = total;
  } else {
    firstHost = (network + 1) >>> 0;
    lastHost = (broadcast - 1) >>> 0;
    usable = total - 2;
  }

  return {
    cidr: `${longToIp(network)}/${prefix}`,
    address: longToIp(addr),
    prefix,
    netmask: longToIp(mask),
    wildcard: longToIp(wildcard),
    network: longToIp(network),
    broadcast: longToIp(broadcast),
    firstHost: longToIp(firstHost),
    lastHost: longToIp(lastHost),
    totalHosts: total,
    usableHosts: usable,
    ipClass: ipClass(addr),
    isPrivate: PRIVATE_RANGES.some(([b, p]) => inRange(addr, b, p)),
  };
}
