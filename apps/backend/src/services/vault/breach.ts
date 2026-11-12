import type { DbOrTx } from '@crewhall/db';
import { VAULT_BREACH_DEFAULT_URL } from '@crewhall/shared';
import { AppError } from '../../http/errors';
import { getPolicy } from './policy';

/**
 * Leaked password check relay (roadmap 20). The device sends five hex digits of a SHA-1; the
 * server fetches that range from the Have I Been Pwned range API (or the org's mirror or
 * proxy, for installations without internet) and hands it back unchanged. The server never
 * sees a password or a full hash, and the prefix is not logged.
 *
 * Ranges are cached in memory for a few hours: they change rarely, and a vault scan asks for
 * hundreds of prefixes that many people share.
 */

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const CACHE_MAX = 5000;
const TIMEOUT_MS = 8000;
/** A padded range is ~30-40 KB; anything far above is not a range answer. */
const MAX_BYTES = 1024 * 1024;

const cache = new Map<string, { at: number; range: string }>();

/** Replaceable in tests. */
export const breachFetch: { fn: typeof fetch } = { fn: (input, init) => fetch(input, init) };

export function clearBreachCache() {
  cache.clear();
}

export async function breachRange(db: DbOrTx, orgId: string, prefix: string, now = Date.now()) {
  if (!/^[0-9A-F]{5}$/.test(prefix)) throw new AppError('not_found');
  const policy = await getPolicy(db, orgId);
  if (!policy.breachCheck) throw new AppError('vault_breach_disabled');
  const base = (policy.breachRangeUrl ?? VAULT_BREACH_DEFAULT_URL).replace(/\/+$/, '');
  const key = `${base}|${prefix}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_TTL_MS) return { range: hit.range };

  let range: string;
  try {
    const res = await breachFetch.fn(`${base}/range/${prefix}`, {
      headers: { 'Add-Padding': 'true', 'User-Agent': 'Crewhall-Vault' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    range = await res.text();
  } catch {
    throw new AppError('vault_breach_unavailable');
  }
  if (range.length > MAX_BYTES) throw new AppError('vault_breach_unavailable');

  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { at: now, range });
  return { range };
}
