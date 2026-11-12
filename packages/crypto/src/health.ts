import { sha256 } from '@noble/hashes/sha2.js';
import { concat, toHex, utf8 } from './bytes';
import type { ItemPayload } from './item';

/**
 * Vault health report (design 8.15), computed on the device: the server cannot see passwords,
 * so it cannot know which are weak or reused either.
 */

export type HealthIssue =
  | { kind: 'expired'; date: string }
  | { kind: 'expiring'; date: string; days: number }
  /** Found in known data breaches (k-anonymity check, roadmap 20); count = times seen. */
  | { kind: 'breached'; count: number }
  | { kind: 'reused'; with: string[] }
  | { kind: 'weak'; score: number }
  | { kind: 'old'; since: string };

export interface HealthInput {
  id: string;
  vaultId: string;
  payload: ItemPayload;
  /** Last change of the item (server metadata), ISO. */
  updatedAt: string;
}

export interface HealthRow {
  id: string;
  vaultId: string;
  issues: HealthIssue[];
}

export interface HealthReport {
  /** 0-100: share of checked items without issues. */
  score: number;
  checked: number;
  rows: HealthRow[];
  counts: {
    expired: number;
    breached: number;
    expiring: number;
    reused: number;
    weak: number;
    old: number;
  };
}

const DAY = 86_400_000;
export const EXPIRY_WARN_DAYS = 30;
/** Detail and list badges appear earlier (design 8.4: 14 days). */
export const EXPIRY_BADGE_DAYS = 14;
const OLD_DAYS = 365;

/** Expiry of an item (API key date, card month end), as a UTC midnight date; null when none. */
export function expiryOf(p: ItemPayload): Date | null {
  if (p.type === 'api_key' && p.expiresAt && /^\d{4}-\d{2}-\d{2}$/.test(p.expiresAt)) {
    const d = new Date(`${p.expiresAt}T00:00:00Z`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (p.type === 'card' && p.expYear && p.expMonth) {
    const y = Number(p.expYear);
    const m = Number(p.expMonth);
    if (y > 2000 && m >= 1 && m <= 12) return new Date(Date.UTC(y, m, 1));
  }
  return null;
}

/** Whole days until expiry (negative when past). */
export function daysUntil(date: Date, now: Date): number {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((date.getTime() - today) / DAY);
}

/**
 * What the report needs from one item, without the item itself: a key that is equal for equal
 * secrets (callers pass a hash, so the facts can be kept in memory without the password), the
 * strength score once measured, the expiry and the last change. Lets a worker scan large vaults
 * gradually and cache per revision.
 */
export interface HealthFacts {
  id: string;
  vaultId: string;
  /** Equal for equal secrets (e.g. a hash of the login password); '' when there is none. */
  secretKey: string;
  /** zxcvbn score 0-4 when measured; undefined while not measured yet. */
  score?: number;
  /** Times the secret appears in known breaches; undefined while not checked (or check off). */
  breached?: number;
  /** ISO date (YYYY-MM-DD) or null. */
  expiry: string | null;
  /** ISO timestamp of the last secret change. */
  lastChange: string;
}

/** The login password the report checks for strength and reuse; '' for other types. */
export function healthSecret(p: ItemPayload): string {
  return p.type === 'login' ? p.password : '';
}

export function healthFacts(
  id: string,
  vaultId: string,
  p: ItemPayload,
  updatedAt: string,
  secretKey: (secret: string) => string,
): HealthFacts {
  const h = p.passwordHistory[0]?.changedAt;
  const secret = healthSecret(p);
  const expiry = expiryOf(p);
  return {
    id,
    vaultId,
    secretKey: secret ? secretKey(secret) : '',
    expiry: expiry ? expiry.toISOString().slice(0, 10) : null,
    lastChange: h && !Number.isNaN(Date.parse(h)) ? h : updatedAt,
  };
}

export function healthReport(items: HealthFacts[], now = new Date()): HealthReport {
  const bySecret = new Map<string, string[]>();
  for (const i of items) {
    if (!i.secretKey) continue;
    const list = bySecret.get(i.secretKey);
    if (list) list.push(i.id);
    else bySecret.set(i.secretKey, [i.id]);
  }
  const rows: HealthRow[] = [];
  let checked = 0;
  const counts = { expired: 0, breached: 0, expiring: 0, reused: 0, weak: 0, old: 0 };
  for (const i of items) {
    if (!i.expiry && !i.secretKey) continue;
    const issues: HealthIssue[] = [];
    checked++;
    if (i.expiry) {
      const days = daysUntil(new Date(`${i.expiry}T00:00:00Z`), now);
      if (days < 0) issues.push({ kind: 'expired', date: i.expiry });
      else if (days <= EXPIRY_WARN_DAYS) issues.push({ kind: 'expiring', date: i.expiry, days });
    }
    if (i.secretKey && i.breached) issues.push({ kind: 'breached', count: i.breached });
    if (i.secretKey) {
      const same = (bySecret.get(i.secretKey) ?? []).filter((o) => o !== i.id);
      if (same.length) issues.push({ kind: 'reused', with: same });
      if (i.score !== undefined && i.score <= 2) issues.push({ kind: 'weak', score: i.score });
      if (now.getTime() - Date.parse(i.lastChange) > OLD_DAYS * DAY) {
        issues.push({ kind: 'old', since: i.lastChange });
      }
    }
    for (const issue of issues) counts[issue.kind]++;
    if (issues.length) rows.push({ id: i.id, vaultId: i.vaultId, issues });
  }
  const order = { expired: 0, breached: 1, expiring: 2, reused: 3, weak: 4, old: 5 } as const;
  rows.sort((a, b) => order[a.issues[0]!.kind] - order[b.issues[0]!.kind]);
  return {
    score: checked ? Math.round((100 * (checked - rows.length)) / checked) : 100,
    checked,
    rows,
    counts,
  };
}

/** Convenience over whole payloads (small vaults, tests). */
export function vaultHealth(
  items: HealthInput[],
  now = new Date(),
  measure?: (password: string) => number,
  breaches?: (password: string) => number,
): HealthReport {
  return healthReport(
    items.map((i) => {
      const f = healthFacts(i.id, i.vaultId, i.payload, i.updatedAt, (s) => s);
      const secret = healthSecret(i.payload);
      if (!secret) return f;
      return {
        ...f,
        ...(measure ? { score: measure(secret) } : {}),
        ...(breaches ? { breached: breaches(secret) } : {}),
      };
    }),
    now,
  );
}

/**
 * Comparable digest of a secret for reuse detection, so a scanner can keep facts in memory
 * without the secret itself.
 */
export function secretDigest(secret: string): string {
  return toHex(sha256(concat(utf8('crewhall/vault/v1/health'), utf8(secret))));
}
