/**
 * Client-side mirror of the IP allowlist check (9.11): shows whether the admin's current
 * address is covered before saving. The server checks again and refuses a self-lockout.
 */

function parseV4(ip: string): bigint | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let out = 0n;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out = (out << 8n) | BigInt(n);
  }
  return out;
}

function parseV6(ip: string): bigint | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  // Embedded IPv4 tail (::ffff:1.2.3.4).
  const v4 = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (v4) {
    const tail = parseV4(v4[1]!);
    if (tail === null) return null;
    s = `${s.slice(0, -v4[1]!.length)}${(tail >> 16n).toString(16)}:${(tail & 0xffffn).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  let out = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    out = (out << 16n) | BigInt(parseInt(g, 16));
  }
  return out;
}

interface Parsed {
  v: 4 | 6;
  n: bigint;
}

export function parseIp(ip: string): Parsed | null {
  const s = ip.trim();
  if (s.includes(':')) {
    const n = parseV6(s);
    if (n === null) return null;
    // IPv4-mapped IPv6 compares as IPv4.
    if (n >> 32n === 0xffffn) return { v: 4, n: n & 0xffffffffn };
    return { v: 6, n };
  }
  const n = parseV4(s);
  return n === null ? null : { v: 4, n };
}

/** `cidr` is an address or address/prefix; invalid entries match nothing. */
export function ipInCidr(ip: string, cidr: string): boolean {
  const addr = parseIp(ip);
  const [base = '', prefixRaw] = cidr.trim().split('/');
  const net = parseIp(base);
  if (!addr || !net || addr.v !== net.v) return false;
  const bits = net.v === 4 ? 32 : 128;
  const prefix = prefixRaw === undefined ? bits : Number(prefixRaw);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > bits) return false;
  const shift = BigInt(bits - prefix);
  return addr.n >> shift === net.n >> shift;
}

export function ipInRanges(ip: string, ranges: readonly { cidr: string }[]): boolean {
  return ranges.some((r) => ipInCidr(ip, r.cidr));
}

/** Address or CIDR the contract accepts (IpRange.cidr), with a valid address part. */
export function isValidCidr(value: string): boolean {
  const [base = '', prefix] = value.trim().split('/');
  const parsed = parseIp(base);
  if (!parsed) return false;
  if (prefix === undefined) return true;
  const n = Number(prefix);
  return /^\d{1,3}$/.test(prefix) && n >= 0 && n <= (parsed.v === 4 ? 32 : 128);
}
