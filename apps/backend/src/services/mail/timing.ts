import { AsyncLocalStorage } from 'node:async_hooks';
import type { Context } from 'hono';
import type { Logger } from '../../logger';

/**
 * Where a mail request spends its time (doc: kararlar.md "Posta hızı, ikinci tur"). Each step
 * adds to its phase; a nested step's time counts only for itself (IMAP time without the
 * database writes inside it). The response carries the phases as `Server-Timing` (browser
 * devtools show them next to the request) and a request slower than SLOW_MS is logged with the
 * same breakdown, so the test server tells which step waits without a profiler.
 */

export type MailPhase = 'connect' | 'imap' | 'db' | 'body' | 'sanitize';

const SLOW_MS = 300;

interface Frame {
  phases: Map<MailPhase, number>;
  parent: MailPhase | null;
}
const store = new AsyncLocalStorage<Frame>();

function add(frame: Frame, phase: MailPhase, ms: number) {
  frame.phases.set(phase, (frame.phases.get(phase) ?? 0) + ms);
  if (frame.parent) frame.phases.set(frame.parent, (frame.phases.get(frame.parent) ?? 0) - ms);
}

/** Adds the time `fn` takes to `phase` of the current request (no-op outside one). */
export async function timed<T>(phase: MailPhase, fn: () => Promise<T>): Promise<T> {
  const frame = store.getStore();
  if (!frame) return fn();
  const t0 = performance.now();
  try {
    return await store.run({ phases: frame.phases, parent: phase }, fn);
  } finally {
    add(frame, phase, performance.now() - t0);
  }
}

/** Synchronous variant (HTML cleaning). */
export function timedSync<T>(phase: MailPhase, fn: () => T): T {
  const frame = store.getStore();
  if (!frame) return fn();
  const t0 = performance.now();
  try {
    return store.run({ phases: frame.phases, parent: phase }, fn);
  } finally {
    add(frame, phase, performance.now() - t0);
  }
}

export function serverTiming(phases: Map<MailPhase, number>, total: number) {
  return [...phases, ['total', total] as const]
    .map(([name, ms]) => `${name};dur=${Math.max(0, ms).toFixed(1)}`)
    .join(', ');
}

/** Runs one mail endpoint with its phases recorded. */
export async function traced<T>(
  c: Context,
  logger: Logger,
  endpoint: string,
  fn: () => Promise<T>,
): Promise<T> {
  const phases = new Map<MailPhase, number>();
  const t0 = performance.now();
  try {
    return await store.run({ phases, parent: null }, fn);
  } finally {
    const total = performance.now() - t0;
    c.header('Server-Timing', serverTiming(phases, total));
    if (total > SLOW_MS) {
      logger.info(
        {
          endpoint,
          ms: Math.round(total),
          phases: Object.fromEntries([...phases].map(([k, v]) => [k, Math.max(0, Math.round(v))])),
        },
        'mail request slow',
      );
    }
  }
}
