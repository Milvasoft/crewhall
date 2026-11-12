import { and, eq, lt, or, sql } from 'drizzle-orm';
import { pageExports, users, type Db, type DbOrTx } from '@crewhall/db';
import {
  pagePath,
  type PageExportFormat,
  type PageExportJob,
  withQuery,
} from '@crewhall/shared';
import type { Env } from '../../../env';
import { AppError } from '../../../http/errors';
import type { Jobs } from '../../../jobs/queue';
import type { Logger } from '../../../logger';
import type { Bus } from '../../../realtime/bus';
import type { Storage } from '../../../storage/s3';
import type { DriveActor } from '../../drive/access';
import { isModuleEnabled } from '../../identity/modules';
import { notify } from '../../notifications/notify';
import { actorFor, loadPage } from '../access';
import { buildExport } from './build';

/**
 * Page export jobs (roadmap 6): the api records the request and queues `page.export`; the
 * worker builds the file, puts it in object storage and marks the row ready. The creator polls
 * the row (the export dialog downloads when it is ready); an export that took a while also
 * notifies (`page.export_ready`). Files are kept 7 days.
 */

const KEEP_DAYS = 7;
/** Exports that finish sooner are picked up by the open dialog; no notification. */
const NOTIFY_AFTER_MS = 10_000;

type Row = typeof pageExports.$inferSelect;

export function toJob(row: Row): PageExportJob {
  return {
    id: row.id,
    nodeId: row.nodeId,
    format: row.format,
    children: row.children,
    status: row.status,
    fileName: row.fileName,
    sizeBytes: row.sizeBytes,
    pageCount: row.pageCount,
    skipped: row.skipped,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
  };
}

export async function createPageExport(
  deps: { db: Db; jobs: Jobs },
  a: DriveActor,
  nodeId: string,
  input: { format: PageExportFormat; children: boolean },
) {
  // Anyone who can open the page can export it (and only the sub-pages they can open).
  const access = await loadPage(deps.db, a, nodeId);
  const [row] = await deps.db
    .insert(pageExports)
    .values({
      orgId: a.org.id,
      nodeId: access.node.id,
      userId: a.userId,
      format: input.format,
      children: input.children,
    })
    .returning();
  await deps.jobs.send('page.export', { exportId: row!.id });
  return getPageExport(deps.db, a, row!.id);
}

async function ownRow(db: DbOrTx, a: DriveActor, exportId: string) {
  const [row] = await db
    .select()
    .from(pageExports)
    .where(
      and(
        eq(pageExports.id, exportId),
        eq(pageExports.orgId, a.org.id),
        eq(pageExports.userId, a.userId),
      ),
    );
  if (!row) throw new AppError('not_found');
  return row;
}

export async function getPageExport(db: DbOrTx, a: DriveActor, exportId: string) {
  return toJob(await ownRow(db, a, exportId));
}

/** A short-lived URL to the file (the raw route redirects to it). */
export async function pageExportUrl(
  deps: { db: DbOrTx; storage: Storage | null },
  a: DriveActor,
  exportId: string,
) {
  const row = await ownRow(deps.db, a, exportId);
  if (row.status !== 'ready' || !row.storageKey || !row.fileName) {
    throw new AppError('not_found');
  }
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) throw new AppError('not_found');
  if (!deps.storage) throw new AppError('internal', { reason: 'storage_not_configured' });
  return (await deps.storage.presignGet(row.storageKey, { fileName: row.fileName })).url;
}

export interface ExportJobDeps {
  db: Db;
  storage: Storage | null;
  env: Env;
  logger: Logger;
  jobs: Jobs;
  bus: Bus;
}

export async function runPageExport(deps: ExportJobDeps, exportId: string) {
  const { db, logger } = deps;
  const [row] = await db.select().from(pageExports).where(eq(pageExports.id, exportId));
  if (!row || row.status === 'ready') return;
  const fail = async (error: string) => {
    await db
      .update(pageExports)
      .set({ status: 'failed', error, finishedAt: new Date() })
      .where(eq(pageExports.id, exportId));
  };
  await db.update(pageExports).set({ status: 'running' }).where(eq(pageExports.id, exportId));

  const a = await actorFor(db, row.orgId, row.userId);
  if (!a) return fail('forbidden');
  if (!(await isModuleEnabled(db, row.orgId, 'wiki'))) return fail('module_disabled');
  if (!deps.storage) return fail('storage_unavailable');
  const [user] = await db
    .select({ locale: users.locale })
    .from(users)
    .where(eq(users.id, row.userId));

  try {
    const built = await buildExport({ db, storage: deps.storage, hubUrl: deps.env.HUB_URL }, a, {
      nodeId: row.nodeId,
      format: row.format,
      children: row.children,
      locale: user?.locale === 'en' ? 'en' : 'tr',
    });
    const key = `orgs/${row.orgId}/exports/${row.id}`;
    await deps.storage.put(key, built.data, built.contentType);
    const finishedAt = new Date();
    await db
      .update(pageExports)
      .set({
        status: 'ready',
        storageKey: key,
        fileName: built.fileName,
        sizeBytes: built.data.length,
        pageCount: built.pageCount,
        skipped: built.skipped,
        finishedAt,
        expiresAt: new Date(finishedAt.getTime() + KEEP_DAYS * 86_400_000),
      })
      .where(eq(pageExports.id, exportId));

    if (finishedAt.getTime() - row.createdAt.getTime() >= NOTIFY_AFTER_MS) {
      const page = await loadPage(db, a, row.nodeId).catch(() => null);
      if (page) {
        await notify(deps, [
          {
            orgId: row.orgId,
            userId: row.userId,
            type: 'page.export_ready',
            category: 'share',
            actorId: null,
            target: { type: 'node', id: row.nodeId, spaceId: page.space.id },
            data: { name: page.node.name, fileName: built.fileName },
            url: withQuery(pagePath(page.node), { export: row.id }),
          },
        ]).catch((err: unknown) => logger.warn({ err, exportId }, 'export notification failed'));
      }
    }
  } catch (err) {
    logger.error({ err, exportId }, 'page export failed');
    await fail(err instanceof AppError ? err.code : 'export_failed');
  }
}

/** Expired exports, and failed ones after a day: the file and the row go. */
export async function purgePageExports(deps: { db: Db; storage: Storage | null; logger: Logger }) {
  const rows = await deps.db
    .select({ id: pageExports.id, key: pageExports.storageKey })
    .from(pageExports)
    .where(
      or(
        lt(pageExports.expiresAt, new Date()),
        and(
          eq(pageExports.status, 'failed'),
          lt(pageExports.createdAt, sql`now() - interval '1 day'`),
        ),
      ),
    )
    .limit(500);
  for (const r of rows) {
    if (r.key && deps.storage) {
      await deps.storage.delete(r.key).catch((err: unknown) => {
        deps.logger.warn({ err, exportId: r.id }, 'export file delete failed');
      });
    }
    await deps.db.delete(pageExports).where(eq(pageExports.id, r.id));
  }
  return rows.length;
}
