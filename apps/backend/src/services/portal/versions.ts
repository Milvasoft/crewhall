import { and, eq, isNull, sql } from 'drizzle-orm';
import { portalDocs, portalVersions, type DbOrTx } from '@crewhall/db';
import { docToMarkdown, type EditorDoc, toPublicDoc } from '@crewhall/editor';
import type { FreezePortalVersion, PortalVersion, PortalVersionDiff } from '@crewhall/shared';
import type { Deps } from '../../deps';
import { AppError } from '../../http/errors';
import type { RequestInfo } from '../../http/types';
import { audit } from '../audit';
import {
  iso,
  loadSite,
  requireEdit,
  requirePublish,
  requireView,
  type PortalActor,
  type SiteRow,
} from './access';
import { parentFolder, versionByName, type DocRow, type VersionRow } from './docs';
import { createNode, ensureFolder } from './nodes';
import { revalidateEverything } from './publish';
import { compareVersions } from './urls';

async function toVersions(db: DbOrTx, site: SiteRow, rows: VersionRow[]): Promise<PortalVersion[]> {
  const counts = await db
    .select({
      versionId: portalDocs.versionId,
      locale: portalDocs.locale,
      docs: sql<number>`count(*) filter (where ${portalDocs.kind} = 'doc' and ${portalDocs.deletedAt} is null)`,
      pending: sql<number>`count(*) filter (where (${portalDocs.deletedAt} is null and ${portalDocs.rev} > ${portalDocs.publishedRev}) or (${portalDocs.deletedAt} is not null and ${portalDocs.publishedRev} > 0))`,
    })
    .from(portalDocs)
    .where(eq(portalDocs.siteId, site.id))
    .groupBy(portalDocs.versionId, portalDocs.locale);
  return rows
    .sort((x, y) => compareVersions(y.name, x.name))
    .map((v) => {
      const mine = counts.filter((c) => c.versionId === v.id);
      return {
        id: v.id,
        name: v.name,
        label: v.label,
        status: v.status,
        showInPicker: v.showInPicker,
        docCounts: Object.fromEntries(
          site.locales.map((l) => [l, Number(mine.find((c) => c.locale === l)?.docs ?? 0)]),
        ),
        pendingCount: mine.reduce((n, c) => n + Number(c.pending), 0),
        frozenAt: iso(v.frozenAt),
        createdAt: v.createdAt.toISOString(),
      };
    });
}

export async function listVersions(db: DbOrTx, a: PortalActor, siteId: string) {
  requireView(a);
  const site = await loadSite(db, a, siteId);
  const rows = await db.select().from(portalVersions).where(eq(portalVersions.siteId, site.id));
  return { items: await toVersions(db, site, rows) };
}

/**
 * "Yeni versiyon dondur" (design 10.5): copies `next` as it is into a new release and
 * publishes it right away; the old current version is archived when the new one becomes
 * current. Old URLs keep working (no redirects needed).
 */
export async function freezeVersion(
  deps: Deps,
  a: PortalActor,
  siteId: string,
  input: FreezePortalVersion,
  req: RequestInfo,
): Promise<PortalVersion> {
  requirePublish(a);
  const { site, version } = await deps.db.transaction(async (tx) => {
    const site = await loadSite(tx, a, siteId);
    const all = await tx.select().from(portalVersions).where(eq(portalVersions.siteId, site.id));
    if (all.some((v) => v.name === input.name)) throw new AppError('portal_version_exists');
    const releases = all.filter((v) => v.name !== 'next');
    if (releases.some((v) => compareVersions(input.name, v.name) <= 0)) {
      throw new AppError('portal_version_invalid', { latest: releases.map((r) => r.name) });
    }
    const next = all.find((v) => v.name === 'next');
    if (!next) throw new AppError('not_found', { version: 'next' });

    const now = new Date();
    if (input.makeCurrent) {
      await tx
        .update(portalVersions)
        .set({ status: 'archived', frozenAt: now })
        .where(and(eq(portalVersions.siteId, site.id), eq(portalVersions.status, 'current')));
    }
    const nodeId = await ensureFolder(tx, {
      orgId: site.orgId,
      spaceId: site.contentSpaceId,
      parentId: site.rootNodeId,
      name: input.name,
      userId: a.userId,
    });
    const [version] = await tx
      .insert(portalVersions)
      .values({
        orgId: site.orgId,
        siteId: site.id,
        name: input.name,
        label: input.label || input.name,
        status: input.makeCurrent ? 'current' : 'archived',
        showInPicker: true,
        nodeId,
        frozenAt: input.makeCurrent ? null : now,
      })
      .returning();

    const rows = await tx
      .select()
      .from(portalDocs)
      .where(and(eq(portalDocs.versionId, next.id), isNull(portalDocs.deletedAt)));
    const copy = rows.filter((r) => input.includeTranslations || r.locale === site.defaultLocale);
    // Parents before children so category folders exist when their docs are copied.
    const depth = (r: DocRow): number => {
      let d = 0;
      let g = r.parentGroupId;
      const byGroup = new Map(rows.map((x) => [x.groupId, x]));
      while (g && d < 50) {
        d++;
        g = byGroup.get(g)?.parentGroupId ?? null;
      }
      return d;
    };
    copy.sort((x, y) => depth(x) - depth(y) || (x.kind === 'category' ? -1 : 1));
    const sourceRevOf = new Map(
      rows.filter((s) => s.locale === site.defaultLocale).map((s) => [s.groupId, s.rev]),
    );
    for (const r of copy) {
      // A translation stays current (or outdated) against its copied source, now at rev 1.
      const trRev =
        r.sourceRev === null ? null : r.sourceRev >= (sourceRevOf.get(r.groupId) ?? 0) ? 1 : 0;
      const node = await createNode(tx, {
        orgId: site.orgId,
        spaceId: site.contentSpaceId,
        parentId: await parentFolder(tx, site, version!, r.locale, r.parentGroupId, a.userId),
        type: r.kind === 'category' ? 'folder' : 'page',
        name: r.title,
        userId: a.userId,
      });
      const { id: _id, createdAt: _c, updatedAt: _u, search: _s, ...rest } = r;
      await tx.insert(portalDocs).values({
        ...rest,
        versionId: version!.id,
        nodeId: node,
        rev: 1,
        // Frozen = published as is (design 10.5: "dondurulursa 1.1.0'da yayına girer").
        publishedRev: 1,
        pubTitle: r.title,
        pubSlug: r.slug,
        pubDescription: r.description,
        pubSidebarLabel: r.sidebarLabel,
        pubPosition: r.position,
        pubParentGroupId: r.parentGroupId,
        pubUnlisted: r.unlisted,
        pubCategoryLink: r.categoryLink,
        pubCategorySlug: r.categorySlug,
        pubFrontMatter: r.frontMatter,
        pubSeo: r.seo,
        contentMd: r.kind === 'doc' ? docToMarkdown(toPublicDoc(r.content as EditorDoc)) : null,
        pubSourceRev: trRev,
        sourceRev: trRev,
        publishedAt: now,
        publishedBy: a.userId,
        updatedBy: a.userId,
      });
    }
    await audit(
      tx,
      {
        orgId: site.orgId,
        actorId: a.userId,
        action: 'portal.version.freeze',
        targetType: 'portal_site',
        targetId: site.id,
        meta: { version: input.name, docs: copy.length, makeCurrent: input.makeCurrent },
      },
      req,
    );
    return { site, version: version! };
  });
  await revalidateEverything(deps, site, a.userId, 'version');
  return (await toVersions(deps.db, site, [version]))[0]!;
}

export async function updateVersion(
  deps: Deps,
  a: PortalActor,
  versionId: string,
  input: {
    label?: string | undefined;
    showInPicker?: boolean | undefined;
    makeCurrent?: true | undefined;
  },
): Promise<PortalVersion> {
  requirePublish(a);
  const [row] = await deps.db
    .select()
    .from(portalVersions)
    .where(and(eq(portalVersions.id, versionId), eq(portalVersions.orgId, a.org.id)));
  if (!row) throw new AppError('not_found');
  const site = await loadSite(deps.db, a, row.siteId);
  if (input.makeCurrent && row.status !== 'current') {
    if (row.name === 'next') throw new AppError('invalid_target', { reason: 'next' });
    await deps.db
      .update(portalVersions)
      .set({ status: 'archived', frozenAt: new Date() })
      .where(and(eq(portalVersions.siteId, site.id), eq(portalVersions.status, 'current')));
    await deps.db
      .update(portalVersions)
      .set({ status: 'current', frozenAt: null })
      .where(eq(portalVersions.id, row.id));
  }
  const [updated] = await deps.db
    .update(portalVersions)
    .set({
      label: input.label ?? row.label,
      showInPicker: input.showInPicker ?? row.showInPicker,
    })
    .where(eq(portalVersions.id, row.id))
    .returning();
  await revalidateEverything(deps, site, a.userId, 'version');
  return (await toVersions(deps.db, site, [updated!]))[0]!;
}

/** What `from` (usually next) adds, changes and removes against `to` (design 10.4). */
export async function diffVersions(
  db: DbOrTx,
  a: PortalActor,
  siteId: string,
  q: { from: string; to: string; locale?: string | undefined },
): Promise<PortalVersionDiff> {
  requireEdit(a);
  const site = await loadSite(db, a, siteId);
  const locale = q.locale ?? site.defaultLocale;
  const load = async (name: string) => {
    const v = await versionByName(db, site, name);
    return db
      .select({
        groupId: portalDocs.groupId,
        title: portalDocs.title,
        slug: portalDocs.slug,
        content: portalDocs.content,
      })
      .from(portalDocs)
      .where(
        and(
          eq(portalDocs.versionId, v.id),
          eq(portalDocs.locale, locale),
          eq(portalDocs.kind, 'doc'),
          isNull(portalDocs.deletedAt),
        ),
      );
  };
  const [from, to] = await Promise.all([load(q.from), load(q.to)]);
  const toBy = new Map(to.map((d) => [d.groupId, d]));
  const fromBy = new Map(from.map((d) => [d.groupId, d]));
  const pick = (d: { slug: string; title: string }) => ({ slug: d.slug, title: d.title });
  return {
    added: from.filter((d) => !toBy.has(d.groupId)).map(pick),
    changed: from
      .filter((d) => {
        const o = toBy.get(d.groupId);
        return (
          o &&
          (o.title !== d.title ||
            o.slug !== d.slug ||
            JSON.stringify(o.content) !== JSON.stringify(d.content))
        );
      })
      .map(pick),
    removed: to.filter((d) => !fromBy.has(d.groupId)).map(pick),
  };
}
