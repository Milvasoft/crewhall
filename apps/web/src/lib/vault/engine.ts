import {
  decryptItem,
  healthFacts,
  healthReport,
  healthSecret,
  itemSummary,
  pwnedCount,
  pwnedQuery,
  secretDigest,
  wipe,
  type FetchRange,
  type HealthFacts,
  type HealthReport,
  type ItemSummary,
  type ItemType,
  type PwnedQuery,
} from '@crewhall/crypto';

/**
 * The heavy vault work, kept apart from React (H13): decrypting items into list summaries and
 * the health scan with password strength. It runs inside a Web Worker (`vault.worker.ts`); the
 * same class runs in the page where workers are missing (tests). Memory only: lock() wipes the
 * keys and every fact; passwords waiting for a strength score are dropped once scored.
 */

/** The encrypted row as the API returns it (only the fields the engine needs). */
export interface EngineRow {
  id: string;
  vaultId: string;
  type: string;
  revision: number;
  keyVersion: number;
  ciphertext: string;
  nonce: string;
  itemKeyWrapped: string;
  updatedAt: string;
}

export interface SummaryResult {
  id: string;
  /** `id:revision:keyVersion`: summaries are cached per revision. */
  cacheKey: string;
  summary: ItemSummary | null;
}

export const cacheKeyOf = (r: Pick<EngineRow, 'id' | 'revision' | 'keyVersion'>) =>
  `${r.id}:${r.revision}:${r.keyVersion}`;

export type Measure = (password: string) => number;

interface Fact {
  cacheKey: string;
  facts: HealthFacts;
  /** Login password not scored yet; cleared as soon as it is. */
  pending: string | null;
  /**
   * SHA-1 split for the leaked password check (roadmap 20) while not checked yet; only the
   * prefix ever leaves the worker. Cleared once the answer is in.
   */
  pwned: PwnedQuery | null;
}

/** Passwords scored between two yields. */
const SCORE_CHUNK = 8;
/** Range requests in flight at once during a leak check. */
const RANGE_CONCURRENCY = 4;

export class VaultEngine {
  private readonly keys = new Map<string, { keyVersion: number; key: Uint8Array }>();
  private readonly facts = new Map<string, Fact>();
  /** Strength scores per secret digest (the same password scores once). */
  private readonly scores = new Map<string, number>();
  /** Breach counts per secret digest (the same password is looked up once per unlock). */
  private readonly breaches = new Map<string, number>();
  private generation = 0;
  /** Counters for the performance test. */
  readonly stats = { decrypted: 0, scored: 0, rangeCalls: 0, breachErrors: 0 };

  setKey(vaultId: string, keyVersion: number, key: Uint8Array) {
    const old = this.keys.get(vaultId);
    if (old && old.keyVersion === keyVersion) return;
    if (old) wipe(old.key);
    this.keys.set(vaultId, { keyVersion, key: key.slice() });
  }

  /** Decrypts rows into summaries (and health facts); rows without a key come back null. */
  summarize(rows: EngineRow[]): SummaryResult[] {
    return rows.map((r) => {
      const cacheKey = cacheKeyOf(r);
      const k = this.keys.get(r.vaultId);
      if (!k || k.keyVersion !== r.keyVersion) return { id: r.id, cacheKey, summary: null };
      try {
        const payload = decryptItem(
          k.key,
          {
            vaultId: r.vaultId,
            itemId: r.id,
            revision: r.revision,
            keyVersion: r.keyVersion,
            type: r.type as ItemType,
          },
          r,
        );
        this.stats.decrypted++;
        const facts = healthFacts(r.id, r.vaultId, payload, r.updatedAt, secretDigest);
        const secret = healthSecret(payload);
        const known = facts.secretKey ? this.scores.get(facts.secretKey) : undefined;
        const breached = facts.secretKey ? this.breaches.get(facts.secretKey) : undefined;
        this.facts.set(r.id, {
          cacheKey,
          facts: {
            ...facts,
            ...(known === undefined ? {} : { score: known }),
            ...(breached === undefined ? {} : { breached }),
          },
          pending: secret && known === undefined ? secret : null,
          pwned: secret && breached === undefined ? pwnedQuery(secret) : null,
        });
        return { id: r.id, cacheKey, summary: itemSummary(payload) };
      } catch {
        return { id: r.id, cacheKey, summary: null };
      }
    });
  }

  /**
   * Health report over the given live items. Strength is measured gradually, a few passwords
   * at a time with a yield in between, so a lock or new work is never stuck behind it.
   */
  async health(
    itemIds: string[],
    now: Date,
    measure: Measure | null,
    yieldNow: () => Promise<void>,
    fetchRange: FetchRange | null = null,
  ): Promise<HealthReport | null> {
    const generation = this.generation;
    const live = itemIds.map((id) => this.facts.get(id)).filter((f): f is Fact => Boolean(f));
    if (measure) {
      const todo = live.filter((f) => f.pending !== null);
      for (let i = 0; i < todo.length; i += SCORE_CHUNK) {
        for (const f of todo.slice(i, i + SCORE_CHUNK)) {
          if (f.pending === null) continue;
          const cached = this.scores.get(f.facts.secretKey);
          const score = cached ?? measure(f.pending);
          if (cached === undefined) this.stats.scored++;
          this.scores.set(f.facts.secretKey, score);
          f.facts = { ...f.facts, score };
          f.pending = null;
        }
        await yieldNow();
        if (generation !== this.generation) return null;
      }
    }
    if (fetchRange && !(await this.checkLeaks(live, fetchRange, generation))) return null;
    return healthReport(
      live.map((f) => f.facts),
      now,
    );
  }

  /**
   * Leaked password check (roadmap 20): one range request per distinct 5-digit prefix, a few
   * at a time. A failed request leaves those items unchecked (retried on the next scan) and is
   * counted in stats.breachErrors. Returns false when a lock interrupted it.
   */
  private async checkLeaks(live: Fact[], fetchRange: FetchRange, generation: number) {
    this.stats.breachErrors = 0;
    const byPrefix = new Map<string, Fact[]>();
    for (const f of live) {
      if (!f.pwned) continue;
      const cached = this.breaches.get(f.facts.secretKey);
      if (cached !== undefined) {
        f.facts = { ...f.facts, breached: cached };
        f.pwned = null;
        continue;
      }
      const list = byPrefix.get(f.pwned.prefix);
      if (list) list.push(f);
      else byPrefix.set(f.pwned.prefix, [f]);
    }
    const prefixes = [...byPrefix.keys()];
    for (let i = 0; i < prefixes.length; i += RANGE_CONCURRENCY) {
      await Promise.all(
        prefixes.slice(i, i + RANGE_CONCURRENCY).map(async (prefix) => {
          let range: string;
          try {
            this.stats.rangeCalls++;
            range = await fetchRange(prefix);
          } catch {
            this.stats.breachErrors++;
            return;
          }
          if (generation !== this.generation) return;
          for (const f of byPrefix.get(prefix) ?? []) {
            if (!f.pwned) continue;
            const count = pwnedCount(range, f.pwned.suffix);
            this.breaches.set(f.facts.secretKey, count);
            f.facts = { ...f.facts, breached: count };
            f.pwned = null;
          }
        }),
      );
      if (generation !== this.generation) return false;
    }
    return true;
  }

  lock() {
    this.generation++;
    for (const k of this.keys.values()) wipe(k.key);
    this.keys.clear();
    this.facts.clear();
    this.scores.clear();
    this.breaches.clear();
  }
}
