import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { linkChecks, links, type Db, type DbOrTx } from '@crewhall/db';
import type { Link, LinkStatus } from '@crewhall/shared';
import type { Logger } from '../../logger';
import { BlockedAddressError, outboundFetch, outboundTls } from '../../net/outbound';

/**
 * Link health (doc 17 §10, design 2.12): HEAD, then GET when HEAD is not supported;
 * 10 s timeout, up to 5 redirects. 2xx, 3xx, 401 and 403 are up (login-protected tools
 * still work); slower than 1.5 s or a certificate ending within 14 days is a warning;
 * anything else is a failure, and 3 failures in a row turn the link red.
 */
export const SLOW_MS = 1500;
const TIMEOUT_MS = 10_000;
const TLS_WARN_DAYS = 14;
const FAILURES_FOR_DOWN = 3;
const RETRY_AFTER_FAILURE_S = 30;
const USER_AGENT = 'Crewhall-LinkCheck/1.0';

export type LinkRow = typeof links.$inferSelect;

export interface CheckResult {
  ok: boolean;
  warn: boolean;
  httpStatus: number | null;
  latencyMs: number | null;
  tlsExpiresAt: Date | null;
  reason: string | null;
  /**
   * The address is internal (private, loopback…) and not on PRIVATE_FETCH_ALLOWLIST: it cannot
   * be checked from here. Not a failure: the link shows "unknown" with reason `internal`.
   */
  blocked?: boolean;
}

export const normalizeUrl = (raw: string) => new URL(raw.trim()).href;
export const urlHash = (url: string) => createHash('sha256').update(url).digest('hex');

async function tlsExpiry(url: URL): Promise<Date | null> {
  if (url.protocol !== 'https:') return null;
  let socket: Awaited<ReturnType<typeof outboundTls>>;
  try {
    socket = await outboundTls(url, { timeoutMs: 5000 });
  } catch {
    return null;
  }
  return new Promise((resolve) => {
    const done = (value: Date | null) => {
      socket.destroy();
      resolve(value);
    };
    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate();
      done(cert?.valid_to ? new Date(cert.valid_to) : null);
    });
    socket.once('error', () => done(null));
    socket.once('timeout', () => done(null));
  });
}

async function request(url: string, method: 'HEAD' | 'GET') {
  let current = url;
  for (let hop = 0; hop <= 5; hop++) {
    // Each hop is checked and pinned (net/outbound): a redirect cannot lead inside.
    const res = await outboundFetch(current, {
      method,
      redirect: 'manual',
      timeoutMs: TIMEOUT_MS,
      headers: { 'user-agent': USER_AGENT, accept: '*/*' },
    });
    if (method === 'GET') await res.body?.cancel().catch(() => undefined);
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location && hop < 5) {
      current = new URL(location, current).href;
      continue;
    }
    return res.status;
  }
  return 310;
}

function failureReason(err: unknown): string {
  const e = err as { name?: string; cause?: { code?: string } };
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return 'timeout';
  const code = e?.cause?.code ?? '';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dns';
  if (code.startsWith('ERR_TLS') || code.includes('CERT')) return 'tls';
  if (code === 'ECONNREFUSED') return 'refused';
  return 'network';
}

export async function checkUrl(rawUrl: string): Promise<CheckResult> {
  const url = new URL(rawUrl);
  const started = performance.now();
  let status: number;
  try {
    status = await request(url.href, 'HEAD');
    if (status === 405 || status === 501) status = await request(url.href, 'GET');
  } catch (err) {
    return {
      ok: false,
      warn: false,
      httpStatus: null,
      latencyMs: null,
      tlsExpiresAt: null,
      reason: err instanceof BlockedAddressError ? 'internal' : failureReason(err),
      ...(err instanceof BlockedAddressError ? { blocked: true } : {}),
    };
  }
  const latencyMs = Math.round(performance.now() - started);
  const tlsExpiresAt = await tlsExpiry(url);
  const up = (status >= 200 && status < 400) || status === 401 || status === 403;
  if (!up) {
    return {
      ok: false,
      warn: false,
      httpStatus: status,
      latencyMs,
      tlsExpiresAt,
      reason: `http_${status}`,
    };
  }
  const certSoon =
    tlsExpiresAt !== null && tlsExpiresAt.getTime() - Date.now() < TLS_WARN_DAYS * 86_400_000;
  const slow = latencyMs > SLOW_MS;
  return {
    ok: true,
    warn: slow || certSoon,
    httpStatus: status,
    latencyMs,
    tlsExpiresAt,
    reason: certSoon ? 'cert_expiring' : slow ? 'slow' : null,
  };
}

/** Applies a check result: status, counters, history row and the next due time. */
export async function recordCheck(
  db: DbOrTx,
  link: LinkRow,
  result: CheckResult,
  now = new Date(),
) {
  // An internal address is not checked from here: "unknown", never a failure.
  const failures = result.ok || result.blocked ? 0 : link.consecutiveFailures + 1;
  let status: LinkStatus;
  if (result.blocked) status = 'unknown';
  else if (result.ok) status = result.warn ? 'warn' : 'up';
  else status = failures >= FAILURES_FOR_DOWN ? 'down' : link.status;
  const checkStatus: LinkStatus = result.blocked
    ? 'unknown'
    : result.ok
      ? result.warn
        ? 'warn'
        : 'up'
      : 'down';
  // After a failure, confirm sooner (at most 30 s) so 3 failures in a row turn the link red
  // well within the 4 minutes of phase 1; healthy links keep their interval.
  const delayMs =
    result.ok || result.blocked || failures >= FAILURES_FOR_DOWN
      ? link.intervalSeconds * 1000
      : Math.min(link.intervalSeconds, RETRY_AFTER_FAILURE_S) * 1000;
  const jitter = Math.round(delayMs * 0.1 * Math.random());
  const [row] = await db
    .update(links)
    .set({
      status,
      statusSince: status !== link.status ? now : link.statusSince,
      consecutiveFailures: failures,
      lastCheckedAt: now,
      nextCheckAt: new Date(now.getTime() + delayMs + jitter),
      lastHttpStatus: result.httpStatus,
      lastLatencyMs: result.latencyMs,
      tlsExpiresAt: result.tlsExpiresAt ?? link.tlsExpiresAt,
      lastReason: result.reason,
      lastUpAt: result.ok ? now : link.lastUpAt,
    })
    .where(eq(links.id, link.id))
    .returning();
  await db.insert(linkChecks).values({
    orgId: link.orgId,
    linkId: link.id,
    at: now,
    status: checkStatus,
    httpStatus: result.httpStatus,
    latencyMs: result.latencyMs,
    tlsExpiresAt: result.tlsExpiresAt,
    error: result.ok ? null : result.reason,
  });
  return row!;
}

/** Claims due links shown on at least one card (SKIP LOCKED) and checks them, 5 at a time. */
export async function checkDueLinks(
  deps: {
    db: Db;
    logger: Logger;
    /** Status changes go to WebSocket clients and notifications (chat module). */
    onStatusChange?: (before: LinkRow, after: LinkRow) => Promise<void>;
  },
  batch = 25,
) {
  const claimed = await deps.db.execute<LinkRow & Record<string, unknown>>(sql`
    update ${links} set next_check_at = now() + make_interval(secs => ${links.intervalSeconds})
    where ${links.id} in (
      select l.id from ${links} l
      where l.check_enabled and (l.next_check_at is null or l.next_check_at <= now())
        and exists (
          select 1 from surface_cards c
          where c.deleted_at is null and c.org_id = l.org_id
            and jsonb_path_exists(c.config, '$.**.linkId ? (@ == $id)', jsonb_build_object('id', l.id::text))
        )
      order by l.next_check_at nulls first
      limit ${batch}
      for update skip locked
    )
    returning id`);
  const ids = claimed.rows.map((r) => String(r.id));
  for (let i = 0; i < ids.length; i += 5) {
    await Promise.all(
      ids.slice(i, i + 5).map(async (id) => {
        const [link] = await deps.db.select().from(links).where(eq(links.id, id));
        if (!link) return;
        const result = await checkUrl(link.url).catch((err) => {
          deps.logger.warn({ err, linkId: id }, 'link check crashed');
          return null;
        });
        if (!result) return;
        const after = await recordCheck(deps.db, link, result);
        if (after.status !== link.status && deps.onStatusChange) {
          await deps.onStatusChange(link, after).catch((err: unknown) => {
            deps.logger.warn({ err, linkId: id }, 'link status event failed');
          });
        }
      }),
    );
  }
  return ids.length;
}

export function toLinkHealth(l: LinkRow): Link['health'] {
  return {
    status: l.status,
    since: l.statusSince?.toISOString() ?? null,
    checkedAt: l.lastCheckedAt?.toISOString() ?? null,
    httpStatus: l.lastHttpStatus,
    latencyMs: l.lastLatencyMs,
    tlsExpiresAt: l.tlsExpiresAt?.toISOString() ?? null,
    reason: l.lastReason,
    lastUpAt: l.lastUpAt?.toISOString() ?? null,
  };
}
