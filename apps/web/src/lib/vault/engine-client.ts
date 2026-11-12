import { type FetchRange, type HealthReport } from '@crewhall/crypto';
import { api } from '@/lib/api';
import { VaultEngine, type EngineRow, type SummaryResult } from './engine';
import type { RangeRequest, WorkerRequest } from './vault.worker';

/**
 * Page side of the vault engine: a module Web Worker when the browser has one, the same engine
 * in the page otherwise (tests, very old browsers). Callers get promises either way.
 */

export interface EngineStats {
  decrypted: number;
  scored: number;
  /** Leaked password check (roadmap 20): range requests made and failed in the last scan. */
  rangeCalls: number;
  breachErrors: number;
}

interface Client {
  setKey(vaultId: string, keyVersion: number, key: Uint8Array): void;
  summarize(rows: EngineRow[]): Promise<SummaryResult[]>;
  /** `breach`: also run the leaked password check (org policy allows it). */
  health(itemIds: string[], now: Date, breach?: boolean): Promise<HealthReport | null>;
  lock(): void;
  stats(): EngineStats;
}

/** Only the 5-digit SHA-1 prefix goes to the server, which relays the range (k-anonymity). */
export const fetchBreachRange: FetchRange = async (prefix) =>
  (await api.call('vaultBreachRange', { params: { prefix } })).range;

const EMPTY: EngineStats = { decrypted: 0, scored: 0, rangeCalls: 0, breachErrors: 0 };

type Reply = {
  id: number;
  results?: SummaryResult[];
  report?: HealthReport | null;
  stats: EngineStats;
};

function workerClient(worker: Worker): Client {
  let seq = 0;
  let last: EngineStats = EMPTY;
  const pending = new Map<number, (v: Omit<Reply, 'id'>) => void>();
  const send = (msg: WorkerRequest, transfer: Transferable[] = []) =>
    worker.postMessage(msg, transfer);
  worker.onmessage = (e: MessageEvent<Reply | RangeRequest>) => {
    const d = e.data;
    if ('kind' in d) {
      fetchBreachRange(d.prefix).then(
        (range) => send({ kind: 'rangeResult', rid: d.rid, range }),
        () => send({ kind: 'rangeResult', rid: d.rid, range: null }),
      );
      return;
    }
    last = d.stats;
    pending.get(d.id)?.(d);
    pending.delete(d.id);
  };
  const call = <T>(
    build: (id: number) => WorkerRequest,
    pick: (d: { results?: SummaryResult[]; report?: HealthReport | null }) => T,
  ) =>
    new Promise<T>((resolve) => {
      const id = ++seq;
      pending.set(id, (d) => resolve(pick(d)));
      send(build(id));
    });
  return {
    setKey(vaultId, keyVersion, key) {
      // A copy goes over and is zeroed there after use; the page keeps its own.
      const copy = key.slice();
      send({ kind: 'setKey', vaultId, keyVersion, key: copy }, [copy.buffer]);
    },
    summarize: (rows) =>
      call(
        (id) => ({ kind: 'summarize', id, rows }),
        (d) => d.results ?? [],
      ),
    health: (itemIds, now, breach = false) =>
      call(
        (id) => ({ kind: 'health', id, itemIds, now: now.getTime(), breach }),
        (d) => d.report ?? null,
      ),
    lock() {
      // Unanswered calls resolve empty: their results belong to the locked session.
      for (const resolve of pending.values()) resolve({ results: [], report: null, stats: last });
      pending.clear();
      send({ kind: 'lock' });
    },
    stats: () => last,
  };
}

function inPageClient(): Client {
  const engine = new VaultEngine();
  let measure: ((pw: string) => number) | null = null;
  return {
    setKey: (vaultId, keyVersion, key) => engine.setKey(vaultId, keyVersion, key),
    summarize: async (rows) => engine.summarize(rows),
    async health(itemIds, now, breach = false) {
      if (!measure) {
        const m = await import('@crewhall/crypto/strength');
        measure = (pw) => m.measureStrength(pw).score;
      }
      return engine.health(
        itemIds,
        now,
        measure,
        () => new Promise((r) => setTimeout(r, 0)),
        breach ? fetchBreachRange : null,
      );
    },
    lock: () => engine.lock(),
    stats: () => ({ ...engine.stats }),
  };
}

let client: Client | null = null;

export function engine(): Client {
  if (client) return client;
  if (typeof Worker !== 'undefined' && import.meta.env.MODE !== 'test') {
    try {
      client = workerClient(
        new Worker(new URL('./vault.worker.ts', import.meta.url), { type: 'module' }),
      );
      return client;
    } catch {
      // fall through to the in-page engine
    }
  }
  client = inPageClient();
  return client;
}
