import { randomBytes } from 'node:crypto';
import { and, asc, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import {
  portalDocs,
  portalPosts,
  portalPublishes,
  portalPublishJobs,
  portalSites,
  portalVersions,
  type DbOrTx,
} from '@crewhall/db';
import type {
  CreatePortalSite,
  PortalOverview,
  PortalRevalidateTest,
  PortalSite,
  PortalSiteSettings,
  PortalSiteSummary,
  UpdatePortalSite,
} from '@crewhall/shared';
import type { Deps } from '../../deps';
import { AppError } from '../../http/errors';
import type { RequestInfo } from '../../http/types';
import { audit } from '../audit';
import {
  capabilities,
  iso,
  loadSite,
  requireManage,
  requireView,
  userSummaries,
  type PortalActor,
  type SiteRow,
} from './access';
import { pendingCount, rawChanges } from './changes';
import { defaultHome, defaultNavigation, defaultSettings } from './defaults';
import { createNode, ensureFolder, portalSpaceId } from './nodes';
import { toPublishJob, toPublishSummary } from './publish-view';
import { publicPathCount } from './public';
import { signedPost } from './revalidate';
import { hashTokenValue } from './token';

async function currentVersionName(db: DbOrTx, siteId: string) {
  const [v] = await db
    .select({ name: portalVersions.name })
    .from(portalVersions)
    .where(and(eq(portalVersions.siteId, siteId), eq(portalVersions.status, 'current')));
  return v?.name ?? null;
}

async function toSummary(db: DbOrTx, site: SiteRow): Promise<PortalSiteSummary> {
  return {
    id: site.id,
    slug: site.slug,
    name: site.name,
    domain: site.domain,
    status: site.lastPublishedAt ? 'live' : 'setup',
    locales: site.locales,
    currentVersion: await currentVersionName(db, site.id),
    publishedUrlCount: await publicPathCount(db, site),
    pendingCount: await pendingCount(db, site),
  };
}

export async function toSite(db: DbOrTx, a: PortalActor, site: SiteRow): Promise<PortalSite> {
  return {
    ...(await toSummary(db, site)),
    defaultLocale: site.defaultLocale,
    settings: site.settings as PortalSiteSettings,
    contentSpaceId: site.contentSpaceId,
    tokenHint: site.tokenHint,
    lastPublishedAt: iso(site.lastPublishedAt),
    capabilities: capabilities(a),
    createdAt: site.createdAt.toISOString(),
    updatedAt: site.updatedAt.toISOString(),
  };
}

export async function listSites(db: DbOrTx, a: PortalActor) {
  const caps = capabilities(a);
  if (!caps.edit && !caps.publish && !caps.manage) return { items: [], capabilities: caps };
  const rows = await db
    .select()
    .from(portalSites)
    .where(eq(portalSites.orgId, a.org.id))
    .orderBy(asc(portalSites.createdAt));
  const items: PortalSiteSummary[] = [];
  for (const row of rows) items.push(await toSummary(db, row));
  return { items, capabilities: caps };
}

export async function getSite(db: DbOrTx, a: PortalActor, siteId: string) {
  requireView(a);
  return toSite(db, a, await loadSite(db, a, siteId));
}

function assertLocales(locales: string[], defaultLocale: string) {
  if (new Set(locales).size !== locales.length || !locales.includes(defaultLocale)) {
    throw new AppError('portal_locale_unsupported', { defaultLocale });
  }
}

/** New site: Portal space folder, `next` + the first release (current), starter content. */
export async function createSite(
  db: DbOrTx,
  a: PortalActor,
  input: CreatePortalSite,
  req: RequestInfo,
): Promise<PortalSite> {
  requireManage(a);
  assertLocales(input.locales, input.defaultLocale);
  const [clash] = await db
    .select({ id: portalSites.id })
    .from(portalSites)
    .where(and(eq(portalSites.orgId, a.org.id), eq(portalSites.slug, input.slug)));
  if (clash) throw new AppError('portal_site_slug_taken');

  const spaceId = await portalSpaceId(db, a.org.id, a.userId);
  const rootNodeId = await createNode(db, {
    orgId: a.org.id,
    spaceId,
    parentId: null,
    type: 'folder',
    name: input.name,
    userId: a.userId,
  });
  const domain = input.domain ?? null;
  const [site] = await db
    .insert(portalSites)
    .values({
      orgId: a.org.id,
      slug: input.slug,
      name: input.name,
      domain,
      locales: input.locales,
      defaultLocale: input.defaultLocale,
      settings: defaultSettings(input.name, domain),
      contentSpaceId: spaceId,
      rootNodeId,
      navDraft: defaultNavigation(input.name, input.defaultLocale),
      homeDraft: defaultHome(input.name, input.defaultLocale),
      createdBy: a.userId,
    })
    .returning();
  if (!site) throw new AppError('internal');

  for (const [name, status] of [
    ['next', 'next'],
    [input.initialVersion, 'current'],
  ] as const) {
    const nodeId = await ensureFolder(db, {
      orgId: a.org.id,
      spaceId,
      parentId: rootNodeId,
      name,
      userId: a.userId,
    });
    await db.insert(portalVersions).values({
      orgId: a.org.id,
      siteId: site.id,
      name,
      label: name,
      status,
      showInPicker: status !== 'next',
      nodeId,
    });
  }
  await audit(
    db,
    {
      orgId: a.org.id,
      actorId: a.userId,
      action: 'portal.site.create',
      targetType: 'portal_site',
      targetId: site.id,
      meta: { slug: site.slug },
    },
    req,
  );
  return toSite(db, a, site);
}

export async function updateSite(
  db: DbOrTx,
  a: PortalActor,
  siteId: string,
  input: UpdatePortalSite,
  req: RequestInfo,
) {
  requireManage(a);
  const site = await loadSite(db, a, siteId);
  const locales = input.locales ?? site.locales;
  const defaultLocale = input.defaultLocale ?? site.defaultLocale;
  assertLocales(locales, defaultLocale);
  const settings = { ...(site.settings as PortalSiteSettings), ...(input.settings ?? {}) };
  const [row] = await db
    .update(portalSites)
    .set({
      name: input.name ?? site.name,
      domain: input.domain === undefined ? site.domain : input.domain,
      locales,
      defaultLocale,
      settings,
    })
    .where(eq(portalSites.id, site.id))
    .returning();
  await audit(
    db,
    {
      orgId: a.org.id,
      actorId: a.userId,
      action: 'portal.site.update',
      targetType: 'portal_site',
      targetId: site.id,
      meta: { fields: Object.keys(input) },
    },
    req,
  );
  return toSite(db, a, row!);
}

/** New read token for the Next.js site; shown once, only its hash is kept. */
export async function rotateToken(db: DbOrTx, a: PortalActor, siteId: string, req: RequestInfo) {
  requireManage(a);
  const site = await loadSite(db, a, siteId);
  const token = `chp_${randomBytes(32).toString('base64url')}`;
  const tokenHint = token.slice(-4);
  await db
    .update(portalSites)
    .set({ tokenHash: hashTokenValue(token), tokenHint })
    .where(eq(portalSites.id, site.id));
  await audit(
    db,
    {
      orgId: a.org.id,
      actorId: a.userId,
      action: 'portal.token.rotate',
      targetType: 'portal_site',
      targetId: site.id,
    },
    req,
  );
  return { token, tokenHint };
}

/** "Test et" (design 10.17): an empty, signed revalidate call. */
export async function testRevalidate(
  deps: Deps,
  a: PortalActor,
  siteId: string,
): Promise<PortalRevalidateTest> {
  requireManage(a);
  const site = await loadSite(deps.db, a, siteId);
  const url = (site.settings as PortalSiteSettings).revalidateUrl;
  if (!url) return { ok: false, status: null, ms: 0, error: 'revalidate_url_missing' };
  const result = await signedPost(deps.env, url, {
    site: site.slug,
    publish: null,
    paths: [],
    tags: [],
    ts: Date.now(),
  });
  return { ok: result.ok, status: result.status, ms: result.ms, error: result.error };
}

/** Design 10.1 dashboard numbers. */
export async function overview(
  db: DbOrTx,
  a: PortalActor,
  siteId: string,
): Promise<PortalOverview> {
  requireView(a);
  const site = await loadSite(db, a, siteId);
  const changes = await rawChanges(db, site);
  const people = new Set(changes.map((c) => c.changedBy).filter(Boolean));
  const oldest = changes.reduce<Date | null>(
    (min, c) => (min === null || c.changedAt < min ? c.changedAt : min),
    null,
  );

  const [docCounts] = await db
    .select({
      published: sql<number>`count(*) filter (where ${portalDocs.publishedRev} > 0 and ${portalDocs.deletedAt} is null and ${portalDocs.kind} = 'doc')`,
      drafts: sql<number>`count(*) filter (where ${portalDocs.publishedRev} = 0 and ${portalDocs.deletedAt} is null and ${portalDocs.kind} = 'doc')`,
    })
    .from(portalDocs)
    .where(eq(portalDocs.siteId, site.id));
  const [postCounts] = await db
    .select({
      published: sql<number>`count(*) filter (where ${portalPosts.publishedRev} > 0 and ${portalPosts.deletedAt} is null)`,
      drafts: sql<number>`count(*) filter (where ${portalPosts.publishedRev} = 0 and ${portalPosts.deletedAt} is null)`,
    })
    .from(portalPosts)
    .where(eq(portalPosts.siteId, site.id));

  const translations = await translationStats(db, site);

  const draftDocs = await db
    .select({
      id: portalDocs.id,
      title: portalDocs.title,
      version: portalVersions.name,
      locale: portalDocs.locale,
      updatedAt: portalDocs.updatedAt,
      updatedBy: portalDocs.updatedBy,
    })
    .from(portalDocs)
    .innerJoin(portalVersions, eq(portalVersions.id, portalDocs.versionId))
    .where(
      and(
        eq(portalDocs.siteId, site.id),
        eq(portalDocs.publishedRev, 0),
        eq(portalDocs.kind, 'doc'),
        isNull(portalDocs.deletedAt),
      ),
    )
    .orderBy(desc(portalDocs.updatedAt))
    .limit(5);
  const draftPosts = await db
    .select({
      id: portalPosts.id,
      title: portalPosts.title,
      locale: portalPosts.locale,
      updatedAt: portalPosts.updatedAt,
      updatedBy: portalPosts.updatedBy,
    })
    .from(portalPosts)
    .where(
      and(
        eq(portalPosts.siteId, site.id),
        eq(portalPosts.publishedRev, 0),
        isNull(portalPosts.deletedAt),
      ),
    )
    .orderBy(desc(portalPosts.updatedAt))
    .limit(5);
  const authors = await userSummaries(
    db,
    [...draftDocs, ...draftPosts].map((d) => d.updatedBy),
  );
  const recentDrafts = [
    ...draftDocs.map((d) => ({ kind: 'doc' as const, ...d })),
    ...draftPosts.map((d) => ({ kind: 'post' as const, version: null, ...d })),
  ]
    .sort((x, y) => y.updatedAt.getTime() - x.updatedAt.getTime())
    .slice(0, 5)
    .map((d) => ({
      kind: d.kind,
      id: d.id,
      title: d.title,
      version: d.version,
      locale: d.locale,
      updatedAt: d.updatedAt.toISOString(),
      updatedBy: d.updatedBy ? (authors.get(d.updatedBy) ?? null) : null,
    }));

  const publishes = await db
    .select()
    .from(portalPublishes)
    .where(eq(portalPublishes.siteId, site.id))
    .orderBy(desc(portalPublishes.number))
    .limit(5);
  const recent = await Promise.all(publishes.map((p) => toPublishSummary(db, p)));
  const [lastJob] = await db
    .select()
    .from(portalPublishJobs)
    .where(and(eq(portalPublishJobs.siteId, site.id), gt(portalPublishJobs.attempts, 0)))
    .orderBy(desc(portalPublishJobs.startedAt))
    .limit(1);

  return {
    publishedUrlCount: await publicPathCount(db, site),
    publishedDocCount: Number(docCounts?.published ?? 0),
    publishedPostCount: Number(postCounts?.published ?? 0),
    pending: { count: changes.length, people: people.size, oldestAt: iso(oldest) },
    drafts: { docs: Number(docCounts?.drafts ?? 0), posts: Number(postCounts?.drafts ?? 0) },
    translations,
    recentDrafts,
    lastPublish: recent[0] ?? null,
    lastJob: lastJob ? toPublishJob(lastJob) : null,
    recentPublishes: recent,
  };
}

/** Translated / total per locale and top-level section, current version (design 10.1). */
async function translationStats(
  db: DbOrTx,
  site: SiteRow,
): Promise<PortalOverview['translations']> {
  const [current] = await db
    .select({ id: portalVersions.id })
    .from(portalVersions)
    .where(and(eq(portalVersions.siteId, site.id), eq(portalVersions.status, 'current')));
  if (!current) return [];
  const rows = await db
    .select({
      groupId: portalDocs.groupId,
      parentGroupId: portalDocs.parentGroupId,
      kind: portalDocs.kind,
      locale: portalDocs.locale,
      title: portalDocs.title,
      rev: portalDocs.rev,
      sourceRev: portalDocs.sourceRev,
    })
    .from(portalDocs)
    .where(and(eq(portalDocs.versionId, current.id), isNull(portalDocs.deletedAt)));
  const source = rows.filter((r) => r.locale === site.defaultLocale);
  const byGroup = new Map(source.map((r) => [r.groupId, r]));
  const topOf = (groupId: string): string => {
    let g = byGroup.get(groupId);
    let top = groupId;
    for (let i = 0; g && g.parentGroupId && i < 50; i++) {
      top = g.parentGroupId;
      g = byGroup.get(g.parentGroupId);
    }
    return top;
  };
  const docs = source.filter((r) => r.kind === 'doc');
  return site.locales
    .filter((l) => l !== site.defaultLocale)
    .map((locale) => {
      const translated = new Map(
        rows.filter((r) => r.locale === locale).map((r) => [r.groupId, r]),
      );
      const sections = new Map<
        string,
        { title: string; translated: number; total: number; outdated: number }
      >();
      let t = 0;
      let o = 0;
      for (const d of docs) {
        const top = topOf(d.groupId);
        const title = byGroup.get(top)?.title ?? d.title;
        const s = sections.get(top) ?? { title, translated: 0, total: 0, outdated: 0 };
        s.total++;
        const tr = translated.get(d.groupId);
        if (tr) {
          s.translated++;
          t++;
          if ((tr.sourceRev ?? 0) < d.rev) {
            s.outdated++;
            o++;
          }
        }
        sections.set(top, s);
      }
      return {
        locale,
        translated: t,
        total: docs.length,
        outdated: o,
        sections: [...sections.entries()].map(([groupId, s]) => ({ groupId, ...s })),
      };
    });
}
