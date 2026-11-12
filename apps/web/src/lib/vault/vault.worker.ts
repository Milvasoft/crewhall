/// <reference lib="webworker" />
import { VaultEngine, type EngineRow, type Measure } from './engine';

/**
 * Vault worker (H13): decrypts list summaries and runs the health scan off the main thread.
 * Vault keys arrive by postMessage from this same origin and live only in this worker's memory;
 * "lock" wipes them. zxcvbn's dictionaries load here, never in the page.
 *
 * The leaked password check (roadmap 20) asks the page for ranges: the page holds the session
 * and calls the API; only the 5-digit SHA-1 prefix crosses over.
 */

export type WorkerRequest =
  | { kind: 'setKey'; vaultId: string; keyVersion: number; key: Uint8Array }
  | { kind: 'summarize'; id: number; rows: EngineRow[] }
  | { kind: 'health'; id: number; itemIds: string[]; now: number; breach: boolean }
  | { kind: 'rangeResult'; rid: number; range: string | null }
  | { kind: 'lock' };

/** Worker → page: a range the leak check needs. */
export interface RangeRequest {
  kind: 'range';
  rid: number;
  prefix: string;
}

const engine = new VaultEngine();
let measure: Promise<Measure> | null = null;

const loadMeasure = () =>
  (measure ??= import('@crewhall/crypto/strength').then(
    (m) => (pw: string) => m.measureStrength(pw).score,
  ));

const post = (msg: unknown) => (self as unknown as Worker).postMessage(msg);
const yieldNow = () => new Promise<void>((r) => setTimeout(r, 0));

let rid = 0;
const ranges = new Map<number, (range: string | null) => void>();
const fetchRange = (prefix: string) =>
  new Promise<string>((resolve, reject) => {
    const id = ++rid;
    ranges.set(id, (range) => (range === null ? reject(new Error('range')) : resolve(range)));
    post({ kind: 'range', rid: id, prefix } satisfies RangeRequest);
  });

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  switch (msg.kind) {
    case 'setKey':
      engine.setKey(msg.vaultId, msg.keyVersion, msg.key);
      msg.key.fill(0);
      return;
    case 'summarize':
      post({ id: msg.id, results: engine.summarize(msg.rows), stats: engine.stats });
      return;
    case 'health': {
      const m = await loadMeasure();
      const report = await engine.health(
        msg.itemIds,
        new Date(msg.now),
        m,
        yieldNow,
        msg.breach ? fetchRange : null,
      );
      post({ id: msg.id, report, stats: engine.stats });
      return;
    }
    case 'rangeResult':
      ranges.get(msg.rid)?.(msg.range);
      ranges.delete(msg.rid);
      return;
    case 'lock':
      for (const done of ranges.values()) done(null);
      ranges.clear();
      engine.lock();
      return;
  }
};
