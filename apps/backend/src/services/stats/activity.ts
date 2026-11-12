import { sql } from 'drizzle-orm';
import { activityDaily, type DbOrTx } from '@crewhall/db';
import { MODULE_OF_ENDPOINT, type EndpointName, type StatsArea } from '@crewhall/shared';
import type { Logger } from '../../logger';

/**
 * Activity counting for admin statistics (roadmap 21). Every org request adds one to an
 * in-memory counter (person, UTC day, area); the counters go to activity_daily in one upsert
 * every FLUSH_MS or when MAX_PENDING keys pile up, and once more when the server closes. A
 * request never waits for the database because of this.
 */

const FLUSH_MS = 30_000;
const MAX_PENDING = 2000;
const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/**
 * Writes the apps make on their own when something is seen or opened: they count as requests
 * but not as actions, or reading a busy chat would look like heavy use.
 */
export const STATS_IGNORE_WRITES = new Set<string>([
  'markConversationRead',
  'markAnnouncementRead',
  'markNodeOpened',
  'recordLinkOpen',
  'previewLink',
] satisfies EndpointName[]);

/**
 * Endpoints the apps call on their own only with a certain body: opening a mail thread marks it
 * seen through mailUpdateFlags, which also stars and marks unread on purpose.
 */
const AUTOMATIC_WHEN: Partial<Record<EndpointName, (body: Record<string, unknown>) => boolean>> = {
  mailUpdateFlags: (b) => b.seen === true && b.flagged === undefined,
};

export function countsAsWrite(endpoint: string, method: string, body?: unknown) {
  if (!WRITES.has(method) || STATS_IGNORE_WRITES.has(endpoint)) return false;
  const automatic = AUTOMATIC_WHEN[endpoint as EndpointName];
  if (automatic && body && typeof body === 'object' && automatic(body as Record<string, unknown>)) {
    return false;
  }
  return true;
}

/** Core endpoints have no module; their first path segment says which core area they are. */
const CORE_AREAS: Record<string, StatsArea> = {
  nodes: 'drive',
  uploads: 'drive',
  shares: 'drive',
  surfaces: 'quick',
  cards: 'quick',
  links: 'quick',
};

export function areaOf(endpoint: string, path: string): StatsArea {
  const mod = MODULE_OF_ENDPOINT[endpoint];
  if (mod) return mod;
  const segment = path.split('/')[3] ?? '';
  return CORE_AREAS[segment] ?? 'core';
}

export const utcDay = (d: Date) => d.toISOString().slice(0, 10);

interface Entry {
  orgId: string;
  userId: string;
  day: string;
  area: StatsArea;
  requests: number;
  writes: number;
}

interface Buffer {
  entries: Map<string, Entry>;
  timer: ReturnType<typeof setTimeout> | null;
  logger: Logger | null;
}

/** One buffer per database (tests run several apps in one process). */
const buffers = new WeakMap<object, Buffer>();

function bufferOf(db: DbOrTx): Buffer {
  let b = buffers.get(db);
  if (!b) {
    b = { entries: new Map(), timer: null, logger: null };
    buffers.set(db, b);
  }
  return b;
}

export function recordActivity(
  deps: { db: DbOrTx; logger: Logger },
  input: {
    orgId: string;
    userId: string;
    endpoint: string;
    method: string;
    path: string;
    body?: unknown;
  },
  now = new Date(),
) {
  const b = bufferOf(deps.db);
  b.logger = deps.logger;
  const day = utcDay(now);
  const area = areaOf(input.endpoint, input.path);
  const key = `${input.orgId}|${input.userId}|${day}|${area}`;
  const write = countsAsWrite(input.endpoint, input.method, input.body) ? 1 : 0;
  const e = b.entries.get(key);
  if (e) {
    e.requests++;
    e.writes += write;
  } else {
    b.entries.set(key, {
      orgId: input.orgId,
      userId: input.userId,
      day,
      area,
      requests: 1,
      writes: write,
    });
  }
  if (b.entries.size >= MAX_PENDING) {
    void flushActivity(deps.db);
  } else if (!b.timer) {
    b.timer = setTimeout(() => void flushActivity(deps.db), FLUSH_MS);
    b.timer.unref?.();
  }
}

/** Writes the pending counters; safe to call at any time (tests, refresh, shutdown). */
export async function flushActivity(db: DbOrTx) {
  const b = buffers.get(db);
  if (!b) return;
  if (b.timer) clearTimeout(b.timer);
  b.timer = null;
  if (!b.entries.size) return;
  const rows = [...b.entries.values()];
  b.entries.clear();
  try {
    await db
      .insert(activityDaily)
      .values(rows)
      .onConflictDoUpdate({
        target: [activityDaily.orgId, activityDaily.day, activityDaily.userId, activityDaily.area],
        set: {
          requests: sql`${activityDaily.requests} + excluded.requests`,
          writes: sql`${activityDaily.writes} + excluded.writes`,
        },
      });
  } catch (err) {
    // Statistics are best effort: a lost batch must never break requests.
    b.logger?.warn({ err, rows: rows.length }, 'activity flush failed');
  }
}
