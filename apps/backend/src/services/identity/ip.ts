import { BlockList, isIP } from 'node:net';
import type { IpRange } from '@crewhall/shared';

/** Strips the IPv4-mapped IPv6 prefix so `::ffff:10.0.0.1` matches `10.0.0.0/8`. */
export function normalizeIp(ip: string) {
  return ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
}

export function validRange(cidr: string) {
  const [addr, bits] = cidr.split('/');
  const family = addr ? isIP(addr) : 0;
  if (!family) return false;
  if (bits === undefined) return true;
  const n = Number(bits);
  return Number.isInteger(n) && n >= 0 && n <= (family === 4 ? 32 : 128);
}

export function ipInRanges(ip: string | null, ranges: Pick<IpRange, 'cidr'>[]) {
  if (!ip) return false;
  const address = normalizeIp(ip);
  const family = isIP(address);
  if (!family) return false;
  const list = new BlockList();
  for (const { cidr } of ranges) {
    if (!validRange(cidr)) continue;
    const [addr, bits] = cidr.split('/') as [string, string | undefined];
    const type = isIP(addr) === 4 ? 'ipv4' : 'ipv6';
    if (bits === undefined) list.addAddress(addr, type);
    else list.addSubnet(addr, Number(bits), type);
  }
  return list.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

/**
 * "Yönetim alanı" of the IP allow list (9.11): org administration endpoints. Reads of the
 * org itself (`GET /api/v1/org`) stay open because every member's client loads it.
 */
const ADMIN_PATTERNS: [RegExp, 'any' | 'write'][] = [
  [/^\/api\/v1\/org(\/|$)/, 'write'],
  [/^\/api\/v1\/org\/(members|invitations|spaces|quota)/, 'any'],
  [/^\/api\/v1\/mcp\/(org|policy)/, 'any'],
  [/^\/api\/v1\/identity\/(providers|security|reauth)/, 'any'],
  [/^\/api\/v1\/identity\/oidc(\/(settings|keys|clients)|$)/, 'any'],
];

export function isAdminArea(method: string, path: string) {
  return ADMIN_PATTERNS.some(([re, kind]) => re.test(path) && (kind === 'any' || method !== 'GET'));
}
