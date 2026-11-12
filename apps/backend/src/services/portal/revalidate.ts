import { createHmac } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  portalPublishes,
  portalPublishJobs,
  portalSites,
  type DbOrTx,
  type PortalSiteSettingsData,
} from '@crewhall/db';
import type { PortalRevalidatePayload } from '@crewhall/shared';
import type { Env } from '../../env';
import type { Logger } from '../../logger';
import { portalEnabled } from './module';

/** One try plus three retries (design 10.12: "Hub üç kez yeniden dener"). */
export const MAX_REVALIDATE_ATTEMPTS = 4;
const TIMEOUT_MS = 10_000;

export const signPayload = (secret: string, body: string) =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

export interface SignedPostResult {
  ok: boolean;
  status: number | null;
  ms: number;
  error: string | null;
}

/** POSTs the payload to the site's /api/revalidate with the HMAC signature (doc 17 §2). */
export async function signedPost(
  env: Pick<Env, 'PORTAL_REVALIDATE_SECRET'>,
  url: string,
  payload: PortalRevalidatePayload,
): Promise<SignedPostResult> {
  const started = performance.now();
  const secret = env.PORTAL_REVALIDATE_SECRET;
  if (!secret) return { ok: false, status: null, ms: 0, error: 'revalidate_secret_missing' };
  const body = JSON.stringify(payload);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Portal-Signature': signPayload(secret, body),
      },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const ms = Math.round(performance.now() - started);
    await res.body?.cancel().catch(() => undefined);
    return { ok: res.ok, status: res.status, ms, error: res.ok ? null : `HTTP ${res.status}` };
  } catch (err) {
    const ms = Math.round(performance.now() - started);
    return { ok: false, status: null, ms, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface RevalidateDeps {
  db: DbOrTx;
  env: Pick<Env, 'PORTAL_REVALIDATE_SECRET'>;
  logger: Logger;
}

/**
 * portal.revalidate (doc 17 §9 step 4). Idempotent: a finished job is skipped. A failed call
 * throws so pg-boss retries it with exponential backoff; after the last attempt the job is
 * marked failed and the site keeps serving the old page (design 10.12).
 */
export async function runRevalidateJob(deps: RevalidateDeps, jobId: string) {
  const { db, logger } = deps;
  const [job] = await db.select().from(portalPublishJobs).where(eq(portalPublishJobs.id, jobId));
  if (!job || job.status === 'done' || job.status === 'failed') return;
  const [site] = await db.select().from(portalSites).where(eq(portalSites.id, job.siteId));
  if (!site) return;
  if (!(await portalEnabled(db, site.orgId))) {
    await db
      .update(portalPublishJobs)
      .set({ status: 'failed', error: 'module_disabled', finishedAt: new Date() })
      .where(eq(portalPublishJobs.id, job.id));
    if (job.publishId) await settlePublish(db, job.publishId);
    return;
  }

  const attempts = job.attempts + 1;
  const startedAt = new Date();
  await db
    .update(portalPublishJobs)
    .set({ status: 'running', attempts, startedAt })
    .where(eq(portalPublishJobs.id, job.id));

  const url = (site.settings as PortalSiteSettingsData).revalidateUrl;
  let publishNumber: number | null = null;
  if (job.publishId) {
    const [p] = await db
      .select({ number: portalPublishes.number })
      .from(portalPublishes)
      .where(eq(portalPublishes.id, job.publishId));
    publishNumber = p?.number ?? null;
  }

  // Without a connected site there is nothing to refresh; the publish itself succeeded.
  const result: SignedPostResult = url
    ? await signedPost(deps.env, url, {
        site: site.slug,
        publish: publishNumber,
        paths: job.paths,
        tags: job.tags,
        ts: Date.now(),
      })
    : { ok: true, status: null, ms: 0, error: 'revalidate_url_missing' };

  const finishedAt = new Date();
  const final = result.ok || attempts >= MAX_REVALIDATE_ATTEMPTS;
  await db
    .update(portalPublishJobs)
    .set({
      status: result.ok ? 'done' : final ? 'failed' : 'queued',
      httpStatus: result.status,
      error: result.error,
      finishedAt: final ? finishedAt : null,
      durationMs: result.ms,
    })
    .where(eq(portalPublishJobs.id, job.id));
  if (job.publishId) await settlePublish(db, job.publishId);
  if (!result.ok) {
    logger.warn({ jobId, attempts, error: result.error }, 'portal revalidate failed');
    if (!final) throw new Error(`portal revalidate failed: ${result.error}`);
  }
}

/** Publish status from its jobs: done, failed, partial or still running. */
export async function settlePublish(db: DbOrTx, publishId: string) {
  const jobs = await db
    .select({
      status: portalPublishJobs.status,
      runAt: portalPublishJobs.runAt,
      finishedAt: portalPublishJobs.finishedAt,
    })
    .from(portalPublishJobs)
    .where(eq(portalPublishJobs.publishId, publishId));
  const now = Date.now();
  // Jobs for a later schedule do not hold the publish open.
  const due = jobs.filter((j) => j.runAt.getTime() <= now + 1000);
  const pending = due.some((j) => j.status === 'queued' || j.status === 'running');
  const failed = due.filter((j) => j.status === 'failed').length;
  const status = pending
    ? 'running'
    : failed === 0
      ? 'done'
      : failed === due.length
        ? 'failed'
        : 'partial';
  const [publish] = await db
    .select({ createdAt: portalPublishes.createdAt, finishedAt: portalPublishes.finishedAt })
    .from(portalPublishes)
    .where(eq(portalPublishes.id, publishId));
  if (!publish) return;
  const lastFinish = due.reduce<number>((max, j) => Math.max(max, j.finishedAt?.getTime() ?? 0), 0);
  await db
    .update(portalPublishes)
    .set({
      status,
      finishedAt: pending ? null : new Date(lastFinish || now),
      durationMs: pending ? null : Math.max(0, (lastFinish || now) - publish.createdAt.getTime()),
    })
    .where(eq(portalPublishes.id, publishId));
}
