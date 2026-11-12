import { asc, eq, inArray } from 'drizzle-orm';
import { portalPublishes, portalPublishJobs, type DbOrTx } from '@crewhall/db';
import type { PortalPublish, PortalPublishJob, PortalPublishSummary } from '@crewhall/shared';
import { iso, userSummaries } from './access';

type PublishRow = typeof portalPublishes.$inferSelect;
type JobRow = typeof portalPublishJobs.$inferSelect;

export function toPublishJob(j: JobRow): PortalPublishJob {
  return {
    id: j.id,
    status: j.status,
    runAt: j.runAt.toISOString(),
    attempts: j.attempts,
    paths: j.paths,
    tags: j.tags,
    httpStatus: j.httpStatus,
    error: j.error,
    startedAt: iso(j.startedAt),
    finishedAt: iso(j.finishedAt),
    durationMs: j.durationMs,
  };
}

async function numbersOf(db: DbOrTx, ids: (string | null)[]) {
  const wanted = ids.filter((v): v is string => !!v);
  if (!wanted.length) return new Map<string, number>();
  const rows = await db
    .select({ id: portalPublishes.id, number: portalPublishes.number })
    .from(portalPublishes)
    .where(inArray(portalPublishes.id, wanted));
  return new Map(rows.map((r) => [r.id, r.number]));
}

export async function toPublishSummary(db: DbOrTx, p: PublishRow): Promise<PortalPublishSummary> {
  const [people, numbers] = await Promise.all([
    userSummaries(db, [p.actorId]),
    numbersOf(db, [p.revertOf, p.revertedBy]),
  ]);
  return {
    id: p.id,
    number: p.number,
    note: p.note,
    actor: p.actorId ? (people.get(p.actorId) ?? null) : null,
    status: p.status,
    itemCount: p.items.length,
    titles: p.items.slice(0, 5).map((i) => i.title),
    pathCount: p.pathCount,
    durationMs: p.durationMs,
    revertOf: p.revertOf ? (numbers.get(p.revertOf) ?? null) : null,
    revertedBy: p.revertedBy ? (numbers.get(p.revertedBy) ?? null) : null,
    createdAt: p.createdAt.toISOString(),
  };
}

export async function toPublish(db: DbOrTx, p: PublishRow): Promise<PortalPublish> {
  const jobs = await db
    .select()
    .from(portalPublishJobs)
    .where(eq(portalPublishJobs.publishId, p.id))
    .orderBy(asc(portalPublishJobs.runAt));
  return {
    ...(await toPublishSummary(db, p)),
    items: p.items.map((i) => ({ ...i })),
    jobs: jobs.map(toPublishJob),
  };
}
