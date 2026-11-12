import { and, desc, eq, lt, sql } from 'drizzle-orm';
import {
  portalDocs,
  portalPosts,
  portalPublishes,
  portalPublishJobs,
  portalRevisions,
  portalSites,
  portalVersions,
  type DbOrTx,
  type PortalPublishItemData,
} from '@crewhall/db';
import {
  docToMarkdown,
  readingMinutes,
  splitAtTruncate,
  type EditorDoc,
  toPublicDoc,
} from '@crewhall/editor';
import type {
  PortalPublish,
  PortalPublishPreview,
  PortalPublishRequest,
  PortalPublishSummary,
} from '@crewhall/shared';
import type { Deps } from '../../deps';
import { AppError } from '../../http/errors';
import type { RequestInfo } from '../../http/types';
import { audit } from '../audit';
import {
  loadSite,
  requireEdit,
  requirePublish,
  requireView,
  type PortalActor,
  type SiteRow,
} from './access';
import { rawChanges, toChanges, type RawChange } from './changes';
import type { DocRow } from './docs';
import type { PostRow } from './posts';
import { toPublish, toPublishJob, toPublishSummary } from './publish-view';
import { publicPathCount } from './public';
import { addAutoRedirects, dropRedirectsFrom } from './redirects';
import { settlePublish } from './revalidate';
import { blogPath, docPath, homePath, postPath, tagSlug, TAGS } from './urls';

// --- snapshots ---------------------------------------------------------------

/** The published columns of a doc; null = not on the site. */
interface DocSnapshot {
  pubTitle: string;
  pubSlug: string;
  pubDescription: string | null;
  pubSidebarLabel: string | null;
  pubPosition: number;
  pubParentGroupId: string | null;
  pubUnlisted: boolean;
  pubCategoryLink: DocRow['categoryLink'];
  pubCategorySlug: string | null;
  pubFrontMatter: Record<string, unknown>;
  pubSeo: Record<string, unknown>;
  contentMd: string | null;
  pubSourceRev: number | null;
  publishedRev: number;
}

function docSnapshotOf(row: DocRow): DocSnapshot | null {
  if (row.publishedRev === 0 || row.pubSlug === null || row.pubTitle === null) return null;
  return {
    pubTitle: row.pubTitle,
    pubSlug: row.pubSlug,
    pubDescription: row.pubDescription,
    pubSidebarLabel: row.pubSidebarLabel,
    pubPosition: row.pubPosition ?? 0,
    pubParentGroupId: row.pubParentGroupId,
    pubUnlisted: row.pubUnlisted ?? false,
    pubCategoryLink: row.pubCategoryLink ?? 'none',
    pubCategorySlug: row.pubCategorySlug,
    pubFrontMatter: row.pubFrontMatter ?? {},
    pubSeo: row.pubSeo ?? {},
    contentMd: row.contentMd,
    pubSourceRev: row.pubSourceRev,
    publishedRev: row.publishedRev,
  };
}

/** The draft turned into a snapshot: markdown is frozen here (doc 17 §9 step 2). */
function docDraftSnapshot(row: DocRow): DocSnapshot {
  return {
    pubTitle: row.title,
    pubSlug: row.slug,
    pubDescription: row.description,
    pubSidebarLabel: row.sidebarLabel,
    pubPosition: row.position,
    pubParentGroupId: row.parentGroupId,
    pubUnlisted: row.unlisted,
    pubCategoryLink: row.categoryLink,
    pubCategorySlug: row.categorySlug,
    pubFrontMatter: row.frontMatter,
    pubSeo: row.seo,
    contentMd: row.kind === 'doc' ? docToMarkdown(toPublicDoc(row.content as EditorDoc)) : null,
    pubSourceRev: row.sourceRev,
    publishedRev: row.rev,
  };
}

async function writeDocSnapshot(
  db: DbOrTx,
  id: string,
  snap: DocSnapshot | null,
  actorId: string | null,
) {
  if (snap) {
    await db
      .update(portalDocs)
      .set({ ...snap, publishedAt: new Date(), publishedBy: actorId })
      .where(eq(portalDocs.id, id));
  } else {
    await db
      .update(portalDocs)
      .set({
        publishedRev: 0,
        pubTitle: null,
        pubSlug: null,
        pubDescription: null,
        pubSidebarLabel: null,
        pubPosition: null,
        pubParentGroupId: null,
        pubUnlisted: null,
        pubCategoryLink: null,
        pubCategorySlug: null,
        pubFrontMatter: null,
        pubSeo: null,
        contentMd: null,
        pubSourceRev: null,
        publishedAt: null,
        publishedBy: null,
      })
      .where(eq(portalDocs.id, id));
  }
}

interface PostSnapshot {
  pubTitle: string;
  pubSlug: string;
  pubDescription: string | null;
  pubAuthorIds: string[];
  pubTags: string[];
  pubDate: string;
  pubCover: string | null;
  pubFrontMatter: Record<string, unknown>;
  pubSeo: Record<string, unknown>;
  contentMd: string;
  excerptMd: string;
  truncated: boolean;
  readingMinutes: number;
  visibleAt: string;
  publishedRev: number;
}

function postSnapshotOf(row: PostRow): PostSnapshot | null {
  if (row.publishedRev === 0 || !row.pubSlug || !row.pubTitle || !row.visibleAt) return null;
  return {
    pubTitle: row.pubTitle,
    pubSlug: row.pubSlug,
    pubDescription: row.pubDescription,
    pubAuthorIds: row.pubAuthorIds ?? [],
    pubTags: row.pubTags ?? [],
    pubDate: (row.pubDate ?? row.visibleAt).toISOString(),
    pubCover: row.pubCover,
    pubFrontMatter: row.pubFrontMatter ?? {},
    pubSeo: row.pubSeo ?? {},
    contentMd: row.contentMd ?? '',
    excerptMd: row.excerptMd ?? '',
    truncated: row.truncated ?? false,
    readingMinutes: row.readingMinutes ?? 1,
    visibleAt: row.visibleAt.toISOString(),
    publishedRev: row.publishedRev,
  };
}

function postDraftSnapshot(row: PostRow, before: PostSnapshot | null, now: Date): PostSnapshot {
  // Hub-only nodes (mentions, embeds) never reach the site (design 10.13).
  const content = toPublicDoc(row.content as EditorDoc);
  const { excerpt, truncated } = splitAtTruncate(content);
  const future = row.scheduledAt && row.scheduledAt.getTime() > now.getTime();
  const visibleAt = future ? row.scheduledAt! : before ? new Date(before.visibleAt) : now;
  return {
    pubTitle: row.title,
    pubSlug: row.slug,
    pubDescription: row.description,
    pubAuthorIds: row.authorIds,
    pubTags: row.tags,
    pubDate: (row.date ?? (before ? new Date(before.pubDate) : visibleAt)).toISOString(),
    pubCover: row.cover,
    pubFrontMatter: row.frontMatter,
    pubSeo: row.seo,
    contentMd: docToMarkdown(content),
    excerptMd: docToMarkdown(excerpt),
    truncated,
    readingMinutes: readingMinutes(content),
    visibleAt: visibleAt.toISOString(),
    publishedRev: row.rev,
  };
}

async function writePostSnapshot(
  db: DbOrTx,
  id: string,
  snap: PostSnapshot | null,
  actorId: string | null,
) {
  if (snap) {
    await db
      .update(portalPosts)
      .set({
        ...snap,
        pubDate: new Date(snap.pubDate),
        visibleAt: new Date(snap.visibleAt),
        publishedAt: new Date(),
        publishedBy: actorId,
      })
      .where(eq(portalPosts.id, id));
  } else {
    await db
      .update(portalPosts)
      .set({
        publishedRev: 0,
        pubTitle: null,
        pubSlug: null,
        pubDescription: null,
        pubAuthorIds: null,
        pubTags: null,
        pubDate: null,
        pubCover: null,
        pubFrontMatter: null,
        pubSeo: null,
        contentMd: null,
        excerptMd: null,
        truncated: null,
        readingMinutes: null,
        visibleAt: null,
        publishedAt: null,
        publishedBy: null,
      })
      .where(eq(portalPosts.id, id));
  }
}

// --- effects -----------------------------------------------------------------

/** Tags and paths to revalidate now and at later times (scheduled posts). */
class Effects {
  readonly tags = new Set<string>();
  readonly paths = new Set<string>();
  readonly later = new Map<number, { tags: Set<string>; paths: Set<string> }>();
  readonly moves: { from: string; to: string }[] = [];
  readonly served: string[] = [];
  everything = false;

  at(when: Date | null) {
    if (!when || when.getTime() <= Date.now()) return { tags: this.tags, paths: this.paths };
    const key = when.getTime();
    let bucket = this.later.get(key);
    if (!bucket) {
      bucket = { tags: new Set(), paths: new Set() };
      this.later.set(key, bucket);
    }
    return bucket;
  }
}

const docPageSlug = (kind: DocRow['kind'], s: DocSnapshot | null) =>
  !s
    ? null
    : kind === 'doc'
      ? s.pubSlug
      : s.pubCategoryLink === 'generated-index'
        ? s.pubCategorySlug
        : null;

const STRUCTURE_KEYS: (keyof DocSnapshot)[] = [
  'pubTitle',
  'pubSlug',
  'pubSidebarLabel',
  'pubPosition',
  'pubParentGroupId',
  'pubUnlisted',
  'pubCategoryLink',
  'pubCategorySlug',
  'pubDescription',
];

function docEffects(
  eff: Effects,
  site: SiteRow,
  version: string,
  row: Pick<DocRow, 'kind' | 'locale'>,
  before: DocSnapshot | null,
  after: DocSnapshot | null,
) {
  // Untranslated pages in other locales show the source, so a source change touches all.
  const locales = row.locale === site.defaultLocale ? site.locales : [row.locale];
  const structural =
    !before ||
    !after ||
    STRUCTURE_KEYS.some((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
  const oldSlug = docPageSlug(row.kind, before);
  const newSlug = docPageSlug(row.kind, after);
  for (const l of locales) {
    for (const slug of new Set([oldSlug, newSlug])) {
      if (!slug) continue;
      eff.tags.add(TAGS.page(version, l, slug));
      eff.paths.add(docPath(l, site.defaultLocale, version, slug));
    }
    if (structural) eff.tags.add(TAGS.sidebar(version, l));
    if (oldSlug && newSlug && oldSlug !== newSlug) {
      eff.moves.push({
        from: docPath(l, site.defaultLocale, version, oldSlug),
        to: docPath(l, site.defaultLocale, version, newSlug),
      });
    }
    if (newSlug && oldSlug !== newSlug)
      eff.served.push(docPath(l, site.defaultLocale, version, newSlug));
  }
  if (oldSlug !== newSlug) {
    eff.tags.add(TAGS.paths);
    eff.paths.add('/sitemap.xml');
  }
}

function postEffects(
  eff: Effects,
  site: SiteRow,
  row: Pick<PostRow, 'locale'>,
  before: PostSnapshot | null,
  after: PostSnapshot | null,
) {
  const locales = row.locale === site.defaultLocale ? site.locales : [row.locale];
  const when = after ? new Date(after.visibleAt) : null;
  const bucket = eff.at(when);
  const tags = new Set([...(before?.pubTags ?? []), ...(after?.pubTags ?? [])]);
  for (const l of locales) {
    for (const slug of new Set([before?.pubSlug, after?.pubSlug])) {
      if (!slug) continue;
      bucket.tags.add(TAGS.post(l, slug));
      bucket.paths.add(postPath(l, site.defaultLocale, slug));
    }
    bucket.paths.add(blogPath(l, site.defaultLocale));
    bucket.paths.add(blogPath(l, site.defaultLocale, 'rss.xml'));
    bucket.paths.add(blogPath(l, site.defaultLocale, 'atom.xml'));
    for (const t of tags) bucket.paths.add(blogPath(l, site.defaultLocale, `tags/${tagSlug(t)}`));
    if (before?.pubSlug && after?.pubSlug && before.pubSlug !== after.pubSlug) {
      eff.moves.push({
        from: postPath(l, site.defaultLocale, before.pubSlug),
        to: postPath(l, site.defaultLocale, after.pubSlug),
      });
    }
    if (after?.pubSlug && before?.pubSlug !== after.pubSlug) {
      eff.served.push(postPath(l, site.defaultLocale, after.pubSlug));
    }
  }
  bucket.tags.add(TAGS.blog);
  if (before?.pubSlug !== after?.pubSlug) {
    bucket.tags.add(TAGS.paths);
    bucket.paths.add('/sitemap.xml');
  }
}

// --- applying changes ----------------------------------------------------------

interface Applied {
  item: PortalPublishItemData;
  revision: { kind: string; entityId: string | null; snapshot: Record<string, unknown> | null };
}

async function versionNames(db: DbOrTx, siteId: string) {
  const rows = await db
    .select({ id: portalVersions.id, name: portalVersions.name })
    .from(portalVersions)
    .where(eq(portalVersions.siteId, siteId));
  return new Map(rows.map((r) => [r.id, r.name]));
}

async function applyDoc(
  db: DbOrTx,
  site: SiteRow,
  versions: Map<string, string>,
  row: DocRow,
  target: DocSnapshot | null,
  actorId: string | null,
  eff: Effects,
  action: PortalPublishItemData['action'],
): Promise<Applied> {
  const before = docSnapshotOf(row);
  await writeDocSnapshot(db, row.id, target, actorId);
  const version = versions.get(row.versionId) ?? '';
  docEffects(eff, site, version, row, before, target);
  return {
    item: {
      kind: 'doc',
      id: row.id,
      title: target?.pubTitle ?? row.title,
      version,
      locale: row.locale,
      action,
      rev: target?.publishedRev ?? 0,
      scheduledAt: null,
    },
    revision: { kind: 'doc', entityId: row.id, snapshot: target as Record<string, unknown> | null },
  };
}

async function applyPost(
  db: DbOrTx,
  site: SiteRow,
  row: PostRow,
  target: PostSnapshot | null,
  actorId: string | null,
  eff: Effects,
  action: PortalPublishItemData['action'],
): Promise<Applied> {
  const before = postSnapshotOf(row);
  await writePostSnapshot(db, row.id, target, actorId);
  postEffects(eff, site, row, before, target);
  const scheduled =
    target && new Date(target.visibleAt).getTime() > Date.now() ? target.visibleAt : null;
  return {
    item: {
      kind: 'post',
      id: row.id,
      title: target?.pubTitle ?? row.title,
      version: null,
      locale: row.locale,
      action: scheduled ? 'schedule' : action,
      rev: target?.publishedRev ?? 0,
      scheduledAt: scheduled,
    },
    revision: {
      kind: 'post',
      entityId: row.id,
      snapshot: target as Record<string, unknown> | null,
    },
  };
}

async function applySiteContent(
  db: DbOrTx,
  site: SiteRow,
  kind: 'home' | 'navigation',
  target: { content: unknown; rev: number } | null,
  eff: Effects,
  action: PortalPublishItemData['action'],
): Promise<Applied> {
  if (kind === 'home') {
    await db
      .update(portalSites)
      .set({ home: target?.content ?? null, homePublishedRev: target?.rev ?? 0 })
      .where(eq(portalSites.id, site.id));
    for (const l of site.locales) eff.paths.add(homePath(l, site.defaultLocale));
    eff.tags.add(TAGS.site);
  } else {
    await db
      .update(portalSites)
      .set({ nav: target?.content ?? null, navPublishedRev: target?.rev ?? 0 })
      .where(eq(portalSites.id, site.id));
    // The navbar and footer are on every page (design 10.9: "418 URL").
    eff.tags.add(TAGS.all);
    eff.everything = true;
    for (const l of site.locales) eff.paths.add(homePath(l, site.defaultLocale));
  }
  return {
    item: {
      kind,
      id: null,
      title: kind,
      version: null,
      locale: null,
      action,
      rev: target?.rev ?? 0,
      scheduledAt: null,
    },
    revision: {
      kind,
      entityId: null,
      snapshot: target ? { content: target.content, rev: target.rev } : null,
    },
  };
}

async function applyChange(
  db: DbOrTx,
  site: SiteRow,
  versions: Map<string, string>,
  change: RawChange,
  actorId: string,
  eff: Effects,
  now: Date,
): Promise<Applied | null> {
  if (change.kind === 'doc' && change.id) {
    const [row] = await db.select().from(portalDocs).where(eq(portalDocs.id, change.id));
    if (!row) return null;
    const target = row.deletedAt ? null : docDraftSnapshot(row);
    return applyDoc(db, site, versions, row, target, actorId, eff, change.action);
  }
  if (change.kind === 'post' && change.id) {
    const [row] = await db.select().from(portalPosts).where(eq(portalPosts.id, change.id));
    if (!row) return null;
    const target = row.deletedAt ? null : postDraftSnapshot(row, postSnapshotOf(row), now);
    return applyPost(db, site, row, target, actorId, eff, change.action);
  }
  if (change.kind === 'home') {
    return applySiteContent(
      db,
      site,
      'home',
      { content: site.homeDraft, rev: site.homeRev },
      eff,
      change.action,
    );
  }
  if (change.kind === 'navigation') {
    return applySiteContent(
      db,
      site,
      'navigation',
      { content: site.navDraft, rev: site.navRev },
      eff,
      change.action,
    );
  }
  return null;
}

// --- publish -----------------------------------------------------------------

interface PublishResult {
  publish: typeof portalPublishes.$inferSelect;
  jobs: { id: string; runAt: Date }[];
}

/** Writes the publish record, its revisions, redirects and revalidation jobs. */
async function record(
  db: DbOrTx,
  site: SiteRow,
  applied: Applied[],
  eff: Effects,
  input: { note: string | null; actorId: string; revertOf: string | null },
): Promise<PublishResult> {
  const [locked] = await db
    .select({ seq: portalSites.publishSeq })
    .from(portalSites)
    .where(eq(portalSites.id, site.id))
    .for('update');
  const number = (locked?.seq ?? 0) + 1;
  if (eff.moves.length) {
    await addAutoRedirects(db, site, eff.moves, input.actorId);
    eff.tags.add(TAGS.redirects);
  }
  if (eff.served.length && (await dropRedirectsFrom(db, site.id, eff.served)) > 0) {
    eff.tags.add(TAGS.redirects);
  }
  const laterPaths = [...eff.later.values()].reduce((n, b) => n + b.paths.size, 0);
  // Counted on the state after this publish (the site counts as published from now on).
  const pathCount = eff.everything
    ? await publicPathCount(db, { ...site, lastPublishedAt: new Date() })
    : eff.paths.size + laterPaths;
  const [publish] = await db
    .insert(portalPublishes)
    .values({
      orgId: site.orgId,
      siteId: site.id,
      number,
      note: input.note,
      actorId: input.actorId,
      status: 'queued',
      items: applied.map((x) => x.item),
      pathCount,
      revertOf: input.revertOf,
    })
    .returning();
  await db
    .update(portalSites)
    .set({ publishSeq: number, lastPublishedAt: new Date() })
    .where(eq(portalSites.id, site.id));
  for (const x of applied) {
    await db.insert(portalRevisions).values({
      orgId: site.orgId,
      siteId: site.id,
      publishId: publish!.id,
      kind: x.revision.kind,
      entityId: x.revision.entityId,
      snapshot: x.revision.snapshot,
    });
  }
  const scope = [...new Set(applied.map((x) => x.item.kind))].join(',');
  const jobs: { id: string; runAt: Date }[] = [];
  const buckets: [Date, { tags: Set<string>; paths: Set<string> }][] = [
    [new Date(), { tags: eff.tags, paths: eff.paths }],
    ...[...eff.later.entries()].map(([ms, b]) => [new Date(ms), b] as [Date, typeof b]),
  ];
  for (const [runAt, b] of buckets) {
    if (!b.tags.size && !b.paths.size) continue;
    const [job] = await db
      .insert(portalPublishJobs)
      .values({
        orgId: site.orgId,
        siteId: site.id,
        publishId: publish!.id,
        scope,
        tags: [...b.tags],
        paths: [...b.paths],
        runAt,
        actorId: input.actorId,
      })
      .returning({ id: portalPublishJobs.id, runAt: portalPublishJobs.runAt });
    jobs.push(job!);
  }
  return { publish: publish!, jobs };
}

class Rollback extends Error {
  constructor(readonly preview: PortalPublishPreview) {
    super('rollback');
  }
}

async function selectedChanges(db: DbOrTx, site: SiteRow, keys: string[] | undefined) {
  const all = await rawChanges(db, site);
  const chosen = keys?.length ? all.filter((c) => keys.includes(c.key)) : all;
  if (!chosen.length) throw new AppError('portal_nothing_to_publish');
  return chosen;
}

export async function listChanges(db: DbOrTx, a: PortalActor, siteId: string) {
  requireView(a);
  const site = await loadSite(db, a, siteId);
  return { items: await toChanges(db, await rawChanges(db, site)) };
}

/** Same computation as publish, rolled back: what would be refreshed (design 10.11). */
export async function previewPublish(
  deps: Deps,
  a: PortalActor,
  siteId: string,
  input: PortalPublishRequest,
): Promise<PortalPublishPreview> {
  requireEdit(a);
  try {
    await deps.db.transaction(async (tx) => {
      const site = await loadSite(tx, a, siteId);
      const chosen = await selectedChanges(tx, site, input.keys);
      const versions = await versionNames(tx, site.id);
      const eff = new Effects();
      const now = new Date();
      for (const c of chosen) await applyChange(tx, site, versions, c, a.userId, eff, now);
      throw new Rollback({
        changes: await toChanges(tx, chosen),
        paths: [...eff.paths].sort(),
        scheduled: [...eff.later.entries()]
          .sort(([x], [y]) => x - y)
          .map(([ms, b]) => ({ at: new Date(ms).toISOString(), paths: [...b.paths].sort() })),
      });
    });
  } catch (err) {
    if (err instanceof Rollback) return err.preview;
    throw err;
  }
  throw new AppError('internal');
}

async function sendJobs(deps: Deps, jobs: { id: string; runAt: Date }[]) {
  for (const job of jobs) {
    // Scheduled posts: the revalidation waits for their time.
    const delay = Math.ceil((job.runAt.getTime() - Date.now()) / 1000);
    await deps.jobs.send(
      'portal.revalidate',
      { jobId: job.id },
      delay > 1 ? { startAfterSeconds: delay } : {},
    );
  }
}

/** "Yayınla" (doc 17 §9 steps 2-4): snapshots + publish record in one transaction, then jobs. */
export async function publish(
  deps: Deps,
  a: PortalActor,
  siteId: string,
  input: PortalPublishRequest,
  req: RequestInfo,
): Promise<PortalPublish> {
  requirePublish(a);
  const result = await deps.db.transaction(async (tx) => {
    const site = await loadSite(tx, a, siteId);
    const chosen = await selectedChanges(tx, site, input.keys);
    const versions = await versionNames(tx, site.id);
    const eff = new Effects();
    const now = new Date();
    const applied: Applied[] = [];
    for (const c of chosen) {
      const x = await applyChange(tx, site, versions, c, a.userId, eff, now);
      if (x) applied.push(x);
    }
    const res = await record(tx, site, applied, eff, {
      note: input.note ?? null,
      actorId: a.userId,
      revertOf: null,
    });
    await audit(
      tx,
      {
        orgId: site.orgId,
        actorId: a.userId,
        action: 'portal.publish',
        targetType: 'portal_site',
        targetId: site.id,
        meta: { number: res.publish.number, items: applied.length, paths: res.publish.pathCount },
      },
      req,
    );
    return res;
  });
  await sendJobs(deps, result.jobs);
  return getPublishRow(deps.db, result.publish.id);
}

async function getPublishRow(db: DbOrTx, id: string) {
  const [row] = await db.select().from(portalPublishes).where(eq(portalPublishes.id, id));
  if (!row) throw new AppError('not_found');
  return toPublish(db, row);
}

async function loadPublish(db: DbOrTx, a: PortalActor, publishId: string) {
  const [row] = await db
    .select()
    .from(portalPublishes)
    .where(and(eq(portalPublishes.id, publishId), eq(portalPublishes.orgId, a.org.id)));
  if (!row) throw new AppError('not_found');
  return row;
}

export async function getPublish(db: DbOrTx, a: PortalActor, publishId: string) {
  requireView(a);
  return toPublish(db, await loadPublish(db, a, publishId));
}

export async function listPublishes(
  db: DbOrTx,
  a: PortalActor,
  siteId: string,
  q: { cursor?: string | undefined; limit: number },
): Promise<{ items: PortalPublishSummary[]; nextCursor: string | null }> {
  requireView(a);
  const site = await loadSite(db, a, siteId);
  const before = q.cursor ? Number(q.cursor) : null;
  const rows = await db
    .select()
    .from(portalPublishes)
    .where(
      and(
        eq(portalPublishes.siteId, site.id),
        before !== null && Number.isFinite(before) ? lt(portalPublishes.number, before) : undefined,
      ),
    )
    .orderBy(desc(portalPublishes.number))
    .limit(q.limit + 1);
  const page = rows.slice(0, q.limit);
  return {
    items: await Promise.all(page.map((p) => toPublishSummary(db, p))),
    nextCursor: rows.length > q.limit ? String(page[page.length - 1]!.number) : null,
  };
}

/**
 * "Geri al" (design 10.12): republishes each item's snapshot from before this publish as a
 * new publish; history is kept, so a revert can itself be reverted.
 */
export async function revertPublish(
  deps: Deps,
  a: PortalActor,
  publishId: string,
  input: { keys?: string[] | undefined; note?: string | null | undefined },
  req: RequestInfo,
): Promise<PortalPublish> {
  requirePublish(a);
  const result = await deps.db.transaction(async (tx) => {
    const original = await loadPublish(tx, a, publishId);
    const site = await loadSite(tx, a, original.siteId);
    const versions = await versionNames(tx, site.id);
    const items = original.items.filter(
      (i) => !input.keys?.length || input.keys.includes(`${i.kind}:${i.id ?? 'site'}`),
    );
    if (!items.length) throw new AppError('portal_nothing_to_publish');
    const eff = new Effects();
    const applied: Applied[] = [];
    for (const item of items) {
      // The latest snapshot of this item from a publish before the reverted one.
      const [prev] = await tx
        .select({ snapshot: portalRevisions.snapshot })
        .from(portalRevisions)
        .innerJoin(portalPublishes, eq(portalPublishes.id, portalRevisions.publishId))
        .where(
          and(
            eq(portalRevisions.siteId, site.id),
            eq(portalRevisions.kind, item.kind),
            item.id
              ? eq(portalRevisions.entityId, item.id)
              : sql`${portalRevisions.entityId} is null`,
            lt(portalPublishes.number, original.number),
          ),
        )
        .orderBy(desc(portalPublishes.number))
        .limit(1);
      const snapshot = prev?.snapshot ?? null;
      const action = snapshot ? 'update' : 'remove';
      if (item.kind === 'doc' && item.id) {
        const [row] = await tx.select().from(portalDocs).where(eq(portalDocs.id, item.id));
        if (row)
          applied.push(
            await applyDoc(
              tx,
              site,
              versions,
              row,
              snapshot as DocSnapshot | null,
              a.userId,
              eff,
              action,
            ),
          );
      } else if (item.kind === 'post' && item.id) {
        const [row] = await tx.select().from(portalPosts).where(eq(portalPosts.id, item.id));
        if (row)
          applied.push(
            await applyPost(tx, site, row, snapshot as PostSnapshot | null, a.userId, eff, action),
          );
      } else if (item.kind === 'home' || item.kind === 'navigation') {
        const s = snapshot as { content: unknown; rev: number } | null;
        applied.push(await applySiteContent(tx, site, item.kind, s, eff, action));
      }
    }
    const res = await record(tx, site, applied, eff, {
      note: input.note ?? null,
      actorId: a.userId,
      revertOf: original.id,
    });
    await tx
      .update(portalPublishes)
      .set({ revertedBy: res.publish.id })
      .where(eq(portalPublishes.id, original.id));
    await audit(
      tx,
      {
        orgId: site.orgId,
        actorId: a.userId,
        action: 'portal.revert',
        targetType: 'portal_site',
        targetId: site.id,
        meta: { reverted: original.number, number: res.publish.number },
      },
      req,
    );
    return res;
  });
  await sendJobs(deps, result.jobs);
  return getPublishRow(deps.db, result.publish.id);
}

/** "Yeniden dene" on a failed revalidation job. */
export async function retryJob(deps: Deps, a: PortalActor, jobId: string) {
  requirePublish(a);
  const [job] = await deps.db
    .select()
    .from(portalPublishJobs)
    .where(and(eq(portalPublishJobs.id, jobId), eq(portalPublishJobs.orgId, a.org.id)));
  if (!job) throw new AppError('not_found');
  if (job.status !== 'failed') throw new AppError('conflict', { status: job.status });
  await deps.db
    .update(portalPublishJobs)
    .set({
      status: 'queued',
      attempts: 0,
      error: null,
      httpStatus: null,
      finishedAt: null,
      runAt: new Date(),
    })
    .where(eq(portalPublishJobs.id, job.id));
  if (job.publishId) await settlePublish(deps.db, job.publishId);
  await deps.jobs.send('portal.revalidate', { jobId: job.id });
  const [fresh] = await deps.db
    .select()
    .from(portalPublishJobs)
    .where(eq(portalPublishJobs.id, job.id));
  return toPublishJob(fresh!);
}

/** A site-wide revalidation without content changes (version settings, freeze). */
export async function revalidateEverything(
  deps: Deps,
  site: SiteRow,
  actorId: string,
  scope: string,
) {
  const [job] = await deps.db
    .insert(portalPublishJobs)
    .values({
      orgId: site.orgId,
      siteId: site.id,
      publishId: null,
      scope,
      tags: [TAGS.all],
      paths: site.locales.map((l) => homePath(l, site.defaultLocale)),
      actorId,
    })
    .returning({ id: portalPublishJobs.id, runAt: portalPublishJobs.runAt });
  await sendJobs(deps, [job!]);
}
