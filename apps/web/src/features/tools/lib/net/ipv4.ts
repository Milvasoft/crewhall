// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/lib/net/ipv4.ts. See THIRD_PARTY.md.
/**
 * Pure IPv4 helpers shared by the network tools. Addresses are handled as
 * unsigned 32-bit integers (via `>>> 0`), so all math stays exact and local.
 */

/** Parse a dotted-quad string into an unsigned 32-bit integer. Throws if malformed. */
export function ipToLong(ip: string): number {
  const parts = ip.trim().split('.');
  if (parts.length !== 4) throw new Error('An IPv4 address has four octets.');
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) throw new Error(`Invalid octet "${part}".`);
    const n = Number(part);
    if (n > 255) throw new Error(`Octet out of range: ${n}.`);
    value = value * 256 + n;
  }
  return value >>> 0;
}

/** Format an unsigned 32-bit integer as a dotted-quad string. */
export function longToIp(value: number): string {
  const v = value >>> 0;
  return [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].join('.');
}

export function isValidIpv4(ip: string): boolean {
  try {
    ipToLong(ip);
    return true;
  } catch {
    return false;
  }
}

/** Build a netmask integer for a prefix length (0–32). */
export function prefixToMask(prefix: number): number {
  if (prefix < 0 || prefix > 32) throw new Error('Prefix must be between 0 and 32.');
  return prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
}

/** Count the set bits in a netmask, or throw if it isn't contiguous. */
export function maskToPrefix(mask: number): number {
  const m = mask >>> 0;
  let prefix = 0;
  let seenZero = false;
  for (let i = 31; i >= 0; i--) {
    const bit = (m >>> i) & 1;
    if (bit === 1) {
      if (seenZero) throw new Error('Netmask bits must be contiguous.');
      prefix++;
    } else {
      seenZero = true;
    }
  }
  return prefix;
}

export interface Cidr {
  ip: string;
  prefix: number;
}

/**
 * Parse `a.b.c.d/p` or `a.b.c.d` (defaulting to /32) or `a.b.c.d 255.255.255.0`.
 */
export function parseCidr(input: string): Cidr {
  const trimmed = input.trim();
  const slash = trimmed.split('/');
  if (slash.length === 2) {
    const [ipPart = '', prefixPart] = slash;
    const prefix = Number(prefixPart);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
      throw new Error('Prefix must be an integer between 0 and 32.');
    }
    ipToLong(ipPart); // validate
    return { ip: ipPart.trim(), prefix };
  }
  const space = trimmed.split(/\s+/);
  if (space.length === 2) {
    const [ipPart = '', maskPart = ''] = space;
    ipToLong(ipPart);
    return { ip: ipPart, prefix: maskToPrefix(ipToLong(maskPart)) };
  }
  ipToLong(trimmed);
  return { ip: trimmed, prefix: 32 };
}

/** The A/B/C/D/E class of an address, by leading bits. */
export function ipClass(value: number): string {
  const first = (value >>> 24) & 255;
  if (first < 128) return 'A';
  if (first < 192) return 'B';
  if (first < 224) return 'C';
  if (first < 240) return 'D (multicast)';
  return 'E (reserved)';
}
