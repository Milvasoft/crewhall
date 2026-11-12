import { sha1 } from '@noble/hashes/legacy.js';
import { toHex, utf8 } from './bytes';

/**
 * Leaked password check with k-anonymity (roadmap 20), the Have I Been Pwned "range" model:
 * the device hashes the password with SHA-1 and sends only the first five hex digits. The
 * answer lists every known suffix under that prefix (padded with zero-count decoys), and the
 * device looks for its own suffix locally. Neither the password nor its full hash leaves the
 * device; the server that relays the query sees five hex digits shared by ~800 hashes.
 */

export const PWNED_PREFIX_LENGTH = 5;

export interface PwnedQuery {
  /** First five hex digits of SHA-1, upper case: the only part sent. */
  prefix: string;
  /** The remaining 35 hex digits, upper case: stays on the device. */
  suffix: string;
}

/** HIBP hashes the password's UTF-8 bytes as typed (no normalization). */
export function pwnedQuery(password: string): PwnedQuery {
  const hash = toHex(sha1(utf8(password))).toUpperCase();
  return { prefix: hash.slice(0, PWNED_PREFIX_LENGTH), suffix: hash.slice(PWNED_PREFIX_LENGTH) };
}

export const isPwnedPrefix = (s: string) => /^[0-9A-F]{5}$/.test(s);

/**
 * How often `suffix` appears in a range answer (`SUFFIX:COUNT` per line). Padding lines carry
 * a count of 0 and therefore never match.
 */
export function pwnedCount(range: string, suffix: string): number {
  const want = suffix.toUpperCase();
  for (const line of range.split('\n')) {
    const colon = line.indexOf(':');
    if (colon !== 35) continue;
    if (line.slice(0, 35).toUpperCase() !== want) continue;
    const n = parseInt(line.slice(36).trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }
  return 0;
}

export type FetchRange = (prefix: string) => Promise<string>;

/** Times the password appears in known breaches (0 = not found). */
export async function checkPwned(password: string, fetchRange: FetchRange): Promise<number> {
  if (!password) return 0;
  const { prefix, suffix } = pwnedQuery(password);
  return pwnedCount(await fetchRange(prefix), suffix);
}
