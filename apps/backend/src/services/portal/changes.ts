import { and, eq, gt, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { portalDocs, portalPosts, portalVersions, type DbOrTx } from '@crewhall/db';
import type { PortalChange } from '@crewhall/shared';
import { iso, userSummaries, type SiteRow } from './access';

/**
 * The site's single queue of unpublished changes (design 10.1, 10.11): docs and posts whose
 * draft is newer than the published snapshot, deleted items still on the site, and the home
 * page / navigation drafts. Keys are `<kind>:<id>` (`home:site`, `navigation:site`).
 */
export interface RawChange {
  key: string;
  kind: PortalChange['kind'];
  id: string | null;
  title: string;
  version: string | null;
  locale: string | null;
  action: PortalChange['action'];
  scheduledAt: Date | null;
  changedAt: Date;
  changedBy: string | null;
}

export async function rawChanges(db: DbOrTx, site: SiteRow): Promise<RawChange[]> {
  const docs = await db
    .select({
      id: portalDocs.id,
      title: portalDocs.title,
      kind: portalDocs.kind,
      locale: portalDocs.locale,
      version: portalVersions.name,
      rev: portalDocs.rev,
      publishedRev: portalDocs.publishedRev,
      deletedAt: portalDocs.deletedAt,
      updatedAt: portalDocs.updatedAt,
      updatedBy: portalDocs.updatedBy,
      deletedBy: portalDocs.deletedBy,
    })
    .from(portalDocs)
    .innerJoin(portalVersions, eq(portalVersions.id, portalDocs.versionId))
    .where(
      and(
        eq(portalDocs.siteId, site.id),
        or(
          and(isNull(portalDocs.deletedAt), gt(portalDocs.rev, portalDocs.publishedRev)),
          and(isNotNull(portalDocs.deletedAt), gt(portalDocs.publishedRev, 0)),
        ),
      ),
    );
  const posts = await db
    .select({
      id: portalPosts.id,
      title: portalPosts.title,
      locale: portalPosts.locale,
      rev: portalPosts.rev,
      publishedRev: portalPosts.publishedRev,
      scheduledAt: portalPosts.scheduledAt,
      deletedAt: portalPosts.deletedAt,
      updatedAt: portalPosts.updatedAt,
      updatedBy: portalPosts.updatedBy,
      deletedBy: portalPosts.deletedBy,
    })
    .from(portalPosts)
    .where(
      and(
        eq(portalPosts.siteId, site.id),
        or(
          and(isNull(portalPosts.deletedAt), gt(portalPosts.rev, portalPosts.publishedRev)),
          and(isNotNull(portalPosts.deletedAt), gt(portalPosts.publishedRev, 0)),
        ),
      ),
    );

  const now = Date.now();
  const out: RawChange[] = [];
  for (const d of docs) {
    const removed = d.deletedAt !== null;
    out.push({
      key: `doc:${d.id}`,
      kind: 'doc',
      id: d.id,
      title: d.title,
      version: d.version,
      locale: d.locale,
      action: removed ? 'remove' : d.publishedRev === 0 ? 'create' : 'update',
      scheduledAt: null,
      changedAt: removed ? d.deletedAt! : d.updatedAt,
      changedBy: removed ? d.deletedBy : d.updatedBy,
    });
  }
  for (const p of posts) {
    const removed = p.deletedAt !== null;
    const scheduled = !removed && p.scheduledAt !== null && p.scheduledAt.getTime() > now;
    out.push({
      key: `post:${p.id}`,
      kind: 'post',
      id: p.id,
      title: p.title,
      version: null,
      locale: p.locale,
      action: removed
        ? 'remove'
        : scheduled
          ? 'schedule'
          : p.publishedRev === 0
            ? 'create'
            : 'update',
      scheduledAt: scheduled ? p.scheduledAt : null,
      changedAt: removed ? p.deletedAt! : p.updatedAt,
      changedBy: removed ? p.deletedBy : p.updatedBy,
    });
  }
  if (site.homeRev > site.homePublishedRev) {
    out.push({
      key: 'home:site',
      kind: 'home',
      id: null,
      title: 'home',
      version: null,
      locale: null,
      action: site.homePublishedRev === 0 ? 'create' : 'update',
      scheduledAt: null,
      changedAt: site.homeUpdatedAt ?? site.updatedAt,
      changedBy: site.homeUpdatedBy,
    });
  }
  if (site.navRev > site.navPublishedRev) {
    out.push({
      key: 'navigation:site',
      kind: 'navigation',
      id: null,
      title: 'navigation',
      version: null,
      locale: null,
      action: site.navPublishedRev === 0 ? 'create' : 'update',
      scheduledAt: null,
      changedAt: site.navUpdatedAt ?? site.updatedAt,
      changedBy: site.navUpdatedBy,
    });
  }
  return out.sort((a, b) => b.changedAt.getTime() - a.changedAt.getTime());
}

export async function toChanges(db: DbOrTx, raw: RawChange[]): Promise<PortalChange[]> {
  const people = await userSummaries(
    db,
    raw.map((c) => c.changedBy),
  );
  return raw.map((c) => ({
    key: c.key,
    kind: c.kind,
    id: c.id,
    title: c.title,
    version: c.version,
    locale: c.locale,
    action: c.action,
    scheduledAt: iso(c.scheduledAt),
    changedAt: c.changedAt.toISOString(),
    changedBy: c.changedBy ? (people.get(c.changedBy) ?? null) : null,
  }));
}

export async function pendingCount(db: DbOrTx, site: SiteRow) {
  const [row] = await db
    .execute<{ n: number }>(
      sql`
    select
      (select count(*) from ${portalDocs} where site_id = ${site.id}
        and ((deleted_at is null and rev > published_rev) or (deleted_at is not null and published_rev > 0)))
      + (select count(*) from ${portalPosts} where site_id = ${site.id}
        and ((deleted_at is null and rev > published_rev) or (deleted_at is not null and published_rev > 0)))
      as n`,
    )
    .then((r) => r.rows);
  return (
    Number(row?.n ?? 0) +
    (site.homeRev > site.homePublishedRev ? 1 : 0) +
    (site.navRev > site.navPublishedRev ? 1 : 0)
  );
}
