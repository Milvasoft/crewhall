import { readFile } from 'node:fs/promises';
import { and, eq, isNull } from 'drizzle-orm';
import {
  portalAuthors,
  portalDocs,
  portalImports,
  portalMedia,
  portalPosts,
  portalSites,
  portalVersions,
  type DbOrTx,
  type PortalSiteSettingsData,
} from '@crewhall/db';
import {
  codeBlockCount,
  docToMarkdown,
  emptyDoc,
  markdownToDoc,
  wordCount,
  type EditorDoc,
  toPublicDoc,
} from '@crewhall/editor';
import type {
  PortalHome,
  PortalImportEntry,
  PortalImportReport,
  PortalNavigation,
  PortalSiteSettings,
} from '@crewhall/shared';
import type { Deps } from '../../deps';
import { requireStorage } from '../drive/files';
import { audit } from '../audit';
import { requireManage, type PortalActor, type SiteRow } from './access';
import { parentFolder, type VersionRow } from './docs';
import { storeMediaBytes } from './media';
import { createNode, ensureFolder } from './nodes';
import { publish } from './publish';
import { addAutoRedirects } from './redirects';
import { createSite } from './sites';
import { rawChanges } from './changes';

/**
 * Writes a parsed Docusaurus site (tools/portal-import `ImportBundle`, structurally typed here
 * so the backend does not depend on the tool) into a portal site as drafts (design 10.15,
 * 10.16; doc 17 §9 "Tek seferlik içe aktarma"). Re-running updates what changed: docs are
 * matched by version + locale + slug, posts by locale + slug, media by path, authors by key.
 */
export interface ImportInput {
  source: string;
  site: {
    name: string;
    locales: string[];
    defaultLocale: string;
    settings: Partial<PortalSiteSettings>;
  };
  currentVersion: string;
  versions: {
    name: string;
    label: string;
    status: 'current' | 'archived' | 'next';
    showInPicker: boolean;
  }[];
  categories: {
    version: string;
    locale: string;
    dir: string;
    parentDir: string;
    slug: string;
    label: string;
    position: number;
    description: string | null;
    link: 'generated-index' | 'doc' | 'none';
    linkSlug: string | null;
    collapsed: boolean | null;
    unlisted?: boolean;
  }[];
  docs: {
    version: string;
    locale: string;
    sourcePath: string;
    dir: string;
    slug: string;
    title: string;
    sidebarLabel: string | null;
    position: number;
    description: string | null;
    unlisted: boolean;
    frontMatter: Record<string, unknown>;
    markdown: string;
    sameAsSource: boolean;
  }[];
  authors: {
    key: string;
    name: string;
    title: string | null;
    url: string | null;
    imageUrl: string | null;
  }[];
  posts: {
    locale: string;
    sourcePath: string;
    slug: string;
    title: string;
    description: string | null;
    date: string;
    authorKeys: string[];
    tags: string[];
    cover: string | null;
    frontMatter: Record<string, unknown>;
    markdown: string;
  }[];
  media: { path: string; file: string; mime: string; size: number }[];
  home: PortalHome | null;
  navigation: PortalNavigation | null;
  entries: {
    type: PortalImportEntry['type'];
    source: string;
    action: string;
    target:
      | { kind: 'doc'; version: string; locale: string; slug: string }
      | { kind: 'post'; locale: string; slug: string }
      | null;
  }[];
  fileCount: number;
  urls: string[];
}

export interface ImportOptions {
  siteSlug: string;
  /** Old site URLs (sitemap) for the comparison line of the report. */
  urlComparison?: { expected: number; matched: number; missing: string[] };
  /** Copy the current version into `next` as drafts (design 10.15 checkbox). */
  seedNext?: boolean;
  /** Publish everything except `next` and unlisted docs right after the import. */
  publish?: boolean;
  /** Next.js endpoints of the site. */
  revalidateUrl?: string | null;
  previewUrl?: string | null;
}

export interface ImportResult {
  siteId: string;
  created: boolean;
  report: PortalImportReport;
  publishNumber: number | null;
}

/** JSON with sorted keys: jsonb does not keep key order, so plain stringify misreports changes. */
function stable(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
        )
      : v,
  );
}

const LINK_TO_CATEGORY = {
  'generated-index': 'generated-index',
  doc: 'doc',
  none: 'none',
} as const;

async function upsertSite(db: DbOrTx, a: PortalActor, input: ImportInput, opts: ImportOptions) {
  const [existing] = await db
    .select()
    .from(portalSites)
    .where(and(eq(portalSites.orgId, a.org.id), eq(portalSites.slug, opts.siteSlug)));
  let site: SiteRow;
  let created = false;
  if (existing) site = existing;
  else {
    const made = await createSite(
      db,
      a,
      {
        name: input.site.name,
        slug: opts.siteSlug,
        domain: input.site.settings.url ? new URL(input.site.settings.url).host : null,
        locales: input.site.locales,
        defaultLocale: input.site.defaultLocale,
        initialVersion: input.currentVersion,
      },
      { ip: null, userAgent: 'portal-import', locale: null },
    );
    [site] = (await db.select().from(portalSites).where(eq(portalSites.id, made.id))) as [SiteRow];
    created = true;
  }
  const settings: PortalSiteSettingsData = {
    ...(site.settings as PortalSiteSettingsData),
    ...(input.site.settings as Partial<PortalSiteSettingsData>),
    ...(opts.revalidateUrl !== undefined ? { revalidateUrl: opts.revalidateUrl } : {}),
    ...(opts.previewUrl !== undefined ? { previewUrl: opts.previewUrl } : {}),
  };
  const [row] = await db
    .update(portalSites)
    .set({
      locales: input.site.locales,
      defaultLocale: input.site.defaultLocale,
      settings,
      ...(input.home && stable(input.home) !== stable(site.homeDraft)
        ? {
            homeDraft: input.home,
            homeRev: site.homeRev + 1,
            homeUpdatedBy: a.userId,
            homeUpdatedAt: new Date(),
          }
        : {}),
      ...(input.navigation && stable(input.navigation) !== stable(site.navDraft)
        ? {
            navDraft: input.navigation,
            navRev: site.navRev + 1,
            navUpdatedBy: a.userId,
            navUpdatedAt: new Date(),
          }
        : {}),
    })
    .where(eq(portalSites.id, site.id))
    .returning();
  return { site: row!, created };
}

async function upsertVersions(db: DbOrTx, site: SiteRow, input: ImportInput, userId: string) {
  const out = new Map<string, VersionRow>();
  const all = [...input.versions];
  if (!all.some((v) => v.name === 'next'))
    all.push({ name: 'next', label: 'next', status: 'next', showInPicker: false });
  // The current one last, so the single-current index never sees two.
  all.sort((x, y) => (x.status === 'current' ? 1 : 0) - (y.status === 'current' ? 1 : 0));
  for (const v of all) {
    if (v.status === 'current') {
      await db
        .update(portalVersions)
        .set({ status: 'archived', frozenAt: new Date() })
        .where(and(eq(portalVersions.siteId, site.id), eq(portalVersions.status, 'current')));
    }
    const nodeId = await ensureFolder(db, {
      orgId: site.orgId,
      spaceId: site.contentSpaceId,
      parentId: site.rootNodeId,
      name: v.name,
      userId,
    });
    const [row] = await db
      .insert(portalVersions)
      .values({
        orgId: site.orgId,
        siteId: site.id,
        name: v.name,
        label: v.label,
        status: v.status,
        showInPicker: v.showInPicker,
        nodeId,
        frozenAt: v.status === 'archived' ? new Date() : null,
      })
      .onConflictDoUpdate({
        target: [portalVersions.siteId, portalVersions.name],
        set: { label: v.label, status: v.status, showInPicker: v.showInPicker },
      })
      .returning();
    out.set(v.name, row!);
  }
  return out;
}

type DocRow = typeof portalDocs.$inferSelect;

/** Inserts or updates one doc / category row; bumps `rev` only when something changed. */
async function upsertDoc(
  db: DbOrTx,
  site: SiteRow,
  version: VersionRow,
  userId: string,
  existing: DocRow | undefined,
  values: Omit<typeof portalDocs.$inferInsert, 'orgId' | 'siteId' | 'versionId' | 'nodeId'>,
) {
  if (existing) {
    const changed =
      existing.title !== values.title ||
      existing.description !== (values.description ?? null) ||
      existing.sidebarLabel !== (values.sidebarLabel ?? null) ||
      existing.position !== values.position ||
      existing.parentGroupId !== (values.parentGroupId ?? null) ||
      existing.unlisted !== values.unlisted ||
      existing.categoryLink !== values.categoryLink ||
      existing.categorySlug !== (values.categorySlug ?? null) ||
      stable(existing.content) !== stable(values.content) ||
      stable(existing.frontMatter) !== stable(values.frontMatter ?? {});
    if (!changed && !existing.deletedAt) return existing;
    const [row] = await db
      .update(portalDocs)
      .set({
        ...values,
        groupId: existing.groupId,
        rev: existing.rev + 1,
        deletedAt: null,
        updatedBy: userId,
      })
      .where(eq(portalDocs.id, existing.id))
      .returning();
    return row!;
  }
  const nodeId = await createNode(db, {
    orgId: site.orgId,
    spaceId: site.contentSpaceId,
    parentId: await parentFolder(
      db,
      site,
      version,
      values.locale,
      values.parentGroupId ?? null,
      userId,
    ),
    type: values.kind === 'category' ? 'folder' : 'page',
    name: values.title,
    userId,
  });
  const [row] = await db
    .insert(portalDocs)
    .values({
      ...values,
      orgId: site.orgId,
      siteId: site.id,
      versionId: version.id,
      nodeId,
      updatedBy: userId,
    })
    .returning();
  return row!;
}

const depth = (dir: string) => (dir ? dir.split('/').length : 0);

async function importDocs(
  db: DbOrTx,
  site: SiteRow,
  versions: Map<string, VersionRow>,
  input: ImportInput,
  userId: string,
) {
  let docs = 0;
  let categories = 0;
  let translations = 0;
  const docIds = new Map<string, string>();
  for (const [name, version] of versions) {
    const existing = await db.select().from(portalDocs).where(eq(portalDocs.versionId, version.id));
    const find = (kind: 'doc' | 'category', locale: string, slug: string) =>
      existing.find((r) => r.kind === kind && r.locale === locale && r.slug === slug);
    // dir → group id (shared by the locales of a version).
    const groupOfDir = new Map<string, string>();
    const cats = input.categories
      .filter((c) => c.version === name)
      .sort((x, y) =>
        x.locale === y.locale
          ? depth(x.dir) - depth(y.dir)
          : x.locale === site.defaultLocale
            ? -1
            : y.locale === site.defaultLocale
              ? 1
              : 0,
      );
    for (const c of cats) {
      const found = find('category', c.locale, c.slug);
      const groupId = groupOfDir.get(c.dir) ?? found?.groupId ?? crypto.randomUUID();
      groupOfDir.set(c.dir, groupId);
      const isSource = c.locale === site.defaultLocale;
      const sourceRow = isSource ? null : find('category', site.defaultLocale, c.slug);
      await upsertDoc(db, site, version, userId, found, {
        locale: c.locale,
        groupId,
        kind: 'category',
        parentGroupId: c.parentDir ? (groupOfDir.get(c.parentDir) ?? null) : null,
        title: c.label,
        slug: c.slug,
        description: c.description,
        sidebarLabel: null,
        position: c.position,
        unlisted: c.unlisted ?? false,
        categoryLink: LINK_TO_CATEGORY[c.link],
        categorySlug: c.linkSlug,
        frontMatter: c.collapsed === null ? {} : { collapsed: c.collapsed },
        content: emptyDoc(),
        sourceRev: isSource ? null : (sourceRow?.rev ?? 1),
      });
      categories++;
    }
    // Refresh: categories may have been created above.
    const fresh = await db.select().from(portalDocs).where(eq(portalDocs.versionId, version.id));
    const groupOfSlug = new Map<string, string>();
    for (const r of fresh) if (r.kind === 'doc') groupOfSlug.set(r.slug, r.groupId);
    const list = input.docs
      .filter((d) => d.version === name)
      .sort(
        (x, y) =>
          (x.locale === site.defaultLocale ? 0 : 1) - (y.locale === site.defaultLocale ? 0 : 1),
      );
    for (const d of list) {
      const isSource = d.locale === site.defaultLocale;
      // A translation identical to its source counts as untranslated (design 10.15 option).
      if (!isSource && d.sameAsSource) continue;
      const found = fresh.find(
        (r) => r.kind === 'doc' && r.locale === d.locale && r.slug === d.slug,
      );
      const groupId = groupOfSlug.get(d.slug) ?? crypto.randomUUID();
      groupOfSlug.set(d.slug, groupId);
      const source = isSource
        ? null
        : fresh.find(
            (r) => r.kind === 'doc' && r.locale === site.defaultLocale && r.slug === d.slug,
          );
      const content = markdownToDoc(d.markdown).doc;
      const row = await upsertDoc(db, site, version, userId, found, {
        locale: d.locale,
        groupId,
        kind: 'doc',
        parentGroupId: d.dir ? (groupOfDir.get(d.dir) ?? null) : null,
        title: d.title,
        slug: d.slug,
        description: d.description,
        sidebarLabel: d.sidebarLabel,
        position: d.position,
        unlisted: d.unlisted,
        categoryLink: 'none',
        categorySlug: null,
        frontMatter: d.frontMatter,
        content,
        wordCount: wordCount(content),
        sourceRev: isSource ? null : (source?.rev ?? 1),
      });
      if (!found) fresh.push(row);
      docIds.set(`${name}|${d.locale}|${d.slug}`, row.id);
      if (isSource) docs++;
      else translations++;
    }
  }
  return { docs, categories, translations, docIds };
}

/** "next taslağını güncel versiyondan oluştur": drafts in next with the same groups. */
async function seedNext(
  db: DbOrTx,
  site: SiteRow,
  versions: Map<string, VersionRow>,
  current: string,
  userId: string,
) {
  const next = versions.get('next');
  const from = versions.get(current);
  if (!next || !from) return 0;
  const [has] = await db
    .select({ id: portalDocs.id })
    .from(portalDocs)
    .where(eq(portalDocs.versionId, next.id))
    .limit(1);
  if (has) return 0;
  const rows = await db
    .select()
    .from(portalDocs)
    .where(and(eq(portalDocs.versionId, from.id), isNull(portalDocs.deletedAt)));
  const byGroup = new Map(rows.map((r) => [r.groupId, r]));
  const lvl = (r: DocRow) => {
    let n = 0;
    for (let g = r.parentGroupId; g && n < 50; g = byGroup.get(g)?.parentGroupId ?? null) n++;
    return n;
  };
  rows.sort(
    (x, y) =>
      lvl(x) - lvl(y) ||
      (x.kind === 'category' ? -1 : 1) ||
      (x.locale === site.defaultLocale ? -1 : 1),
  );
  for (const r of rows) {
    const nodeId = await createNode(db, {
      orgId: site.orgId,
      spaceId: site.contentSpaceId,
      parentId: await parentFolder(db, site, next, r.locale, r.parentGroupId, userId),
      type: r.kind === 'category' ? 'folder' : 'page',
      name: r.title,
      userId,
    });
    await db.insert(portalDocs).values({
      orgId: r.orgId,
      siteId: r.siteId,
      versionId: next.id,
      locale: r.locale,
      groupId: r.groupId,
      kind: r.kind,
      nodeId,
      parentGroupId: r.parentGroupId,
      title: r.title,
      slug: r.slug,
      description: r.description,
      sidebarLabel: r.sidebarLabel,
      position: r.position,
      unlisted: r.unlisted,
      categoryLink: r.categoryLink,
      categorySlug: r.categorySlug,
      frontMatter: r.frontMatter,
      seo: r.seo,
      content: r.content,
      wordCount: r.wordCount,
      rev: r.rev,
      sourceRev: r.sourceRev,
      updatedBy: userId,
      // A copy of the release starts "published" (visible only in preview or when next is
      // public), so only real edits in next show up in the publish queue.
      publishedRev: r.rev,
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
      pubSourceRev: r.sourceRev,
      publishedAt: new Date(),
      publishedBy: userId,
    });
  }
  return rows.length;
}

async function importBlog(db: DbOrTx, site: SiteRow, input: ImportInput, userId: string) {
  const authorIds = new Map<string, string>();
  for (const au of input.authors) {
    const [row] = await db
      .insert(portalAuthors)
      .values({
        orgId: site.orgId,
        siteId: site.id,
        key: au.key,
        name: au.name,
        title: au.title,
        url: au.url,
        imageUrl: au.imageUrl,
      })
      .onConflictDoUpdate({
        target: [portalAuthors.siteId, portalAuthors.key],
        set: { name: au.name, title: au.title, url: au.url, imageUrl: au.imageUrl },
      })
      .returning();
    authorIds.set(au.key, row!.id);
  }
  const existing = await db
    .select()
    .from(portalPosts)
    .where(and(eq(portalPosts.siteId, site.id), isNull(portalPosts.deletedAt)));
  const groupOfSlug = new Map(existing.map((p) => [p.slug, p.groupId]));
  const postIds = new Map<string, string>();
  const posts = [...input.posts].sort(
    (x, y) => (x.locale === site.defaultLocale ? 0 : 1) - (y.locale === site.defaultLocale ? 0 : 1),
  );
  for (const p of posts) {
    const content = markdownToDoc(p.markdown).doc as EditorDoc;
    const values = {
      title: p.title,
      slug: p.slug,
      description: p.description,
      authorIds: p.authorKeys.map((k) => authorIds.get(k)).filter((id): id is string => !!id),
      tags: p.tags,
      date: new Date(p.date),
      cover: p.cover,
      frontMatter: p.frontMatter,
      content,
      wordCount: wordCount(content),
      codeBlocks: codeBlockCount(content),
      updatedBy: userId,
    };
    const found = existing.find((e) => e.locale === p.locale && e.slug === p.slug);
    const groupId = groupOfSlug.get(p.slug) ?? crypto.randomUUID();
    groupOfSlug.set(p.slug, groupId);
    if (found) {
      const changed =
        found.title !== values.title ||
        stable(found.content) !== stable(content) ||
        stable(found.tags) !== stable(values.tags) ||
        found.cover !== values.cover;
      if (changed) {
        await db
          .update(portalPosts)
          .set({ ...values, rev: found.rev + 1 })
          .where(eq(portalPosts.id, found.id));
      }
      postIds.set(`${p.locale}|${p.slug}`, found.id);
      continue;
    }
    const blog = await ensureFolder(db, {
      orgId: site.orgId,
      spaceId: site.contentSpaceId,
      parentId: site.rootNodeId,
      name: 'blog',
      userId,
    });
    const nodeId = await createNode(db, {
      orgId: site.orgId,
      spaceId: site.contentSpaceId,
      parentId: await ensureFolder(db, {
        orgId: site.orgId,
        spaceId: site.contentSpaceId,
        parentId: blog,
        name: p.locale,
        userId,
      }),
      type: 'page',
      name: p.title,
      userId,
    });
    const [row] = await db
      .insert(portalPosts)
      .values({ ...values, orgId: site.orgId, siteId: site.id, locale: p.locale, groupId, nodeId })
      .returning();
    postIds.set(`${p.locale}|${p.slug}`, row!.id);
  }
  return { authors: input.authors.length, posts: input.posts.length, postIds };
}

async function importMedia(deps: Deps, site: SiteRow, input: ImportInput, userId: string) {
  const storage = requireStorage(deps);
  let count = 0;
  let bytes = 0;
  for (const m of input.media) {
    const [existing] = await deps.db
      .select()
      .from(portalMedia)
      .where(and(eq(portalMedia.siteId, site.id), eq(portalMedia.path, m.path)));
    if (existing?.blobId && existing.size === m.size) {
      count++;
      bytes += m.size;
      continue;
    }
    const row =
      existing ??
      (
        await deps.db
          .insert(portalMedia)
          .values({
            orgId: site.orgId,
            siteId: site.id,
            path: m.path,
            fileName: m.path.split('/').pop() ?? m.path,
            mime: m.mime,
            size: m.size,
            createdBy: userId,
          })
          .returning()
      )[0]!;
    await storeMediaBytes(deps.db, storage, site, row, await readFile(m.file), m.mime);
    count++;
    bytes += m.size;
  }
  return { count, bytes };
}

/** Pages the import does not carry (Docusaurus src/pages) redirect to the home page. */
async function pageRedirects(db: DbOrTx, site: SiteRow, input: ImportInput, userId: string) {
  const moves: { from: string; to: string }[] = [];
  for (const e of input.entries) {
    const m = /^src\/pages\/(.+)\.mdx?$/.exec(e.source);
    if (e.type !== 'skipped' || !m) continue;
    const name = m[1]!.replace(/\/index$/, '');
    for (const l of site.locales) {
      const prefix = l === site.defaultLocale ? '' : `/${l}`;
      moves.push({ from: `${prefix}/${name}`, to: prefix || '/' });
    }
  }
  await addAutoRedirects(db, site, moves, userId);
  return moves.length;
}

export async function importSite(
  deps: Deps,
  a: PortalActor,
  input: ImportInput,
  opts: ImportOptions,
): Promise<ImportResult> {
  requireManage(a);
  const startedAt = new Date();
  const { site, created, counts, docIds, postIds } = await deps.db.transaction(async (tx) => {
    const { site, created } = await upsertSite(tx, a, input, opts);
    const versions = await upsertVersions(tx, site, input, a.userId);
    const d = await importDocs(tx, site, versions, input, a.userId);
    if (opts.seedNext !== false) await seedNext(tx, site, versions, input.currentVersion, a.userId);
    const b = await importBlog(tx, site, input, a.userId);
    await pageRedirects(tx, site, input, a.userId);
    return {
      site,
      created,
      counts: {
        docs: d.docs,
        categories: d.categories,
        translations: d.translations,
        posts: b.posts,
        authors: b.authors,
      },
      docIds: d.docIds,
      postIds: b.postIds,
    };
  });
  const media = await importMedia(deps, site, input, a.userId);

  const entries = input.entries.map((e) => {
    const targetId = !e.target
      ? null
      : e.target.kind === 'doc'
        ? (docIds.get(`${e.target.version}|${e.target.locale}|${e.target.slug}`) ??
          docIds.get(`${e.target.version}|${site.defaultLocale}|${e.target.slug}`) ??
          null)
        : (postIds.get(`${e.target.locale}|${e.target.slug}`) ?? null);
    return {
      type: e.type,
      source: e.source,
      action: e.action,
      targetKind: targetId && e.target ? e.target.kind : null,
      targetId,
    };
  });
  const finishedAt = new Date();
  const report: Omit<PortalImportReport, 'id' | 'actor'> = {
    source: input.source,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    counts: {
      files: input.fileCount,
      ...counts,
      media: media.count,
      mediaBytes: media.bytes,
      warnings: entries.filter((e) => e.type !== 'skipped').length,
      skipped: entries.filter((e) => e.type === 'skipped').length,
    },
    urls: opts.urlComparison ?? {
      expected: input.urls.length,
      matched: input.urls.length,
      missing: [],
    },
    entries,
  };
  const [saved] = await deps.db
    .insert(portalImports)
    .values({ orgId: site.orgId, siteId: site.id, actorId: a.userId, report })
    .returning();
  await audit(deps.db, {
    orgId: site.orgId,
    actorId: a.userId,
    action: 'portal.import',
    targetType: 'portal_site',
    targetId: site.id,
    meta: { source: input.source, docs: counts.docs, posts: counts.posts, media: media.count },
  });

  let publishNumber: number | null = null;
  if (opts.publish) {
    // First publish: everything except `next` and docs Docusaurus never routed.
    const [fresh] = await deps.db.select().from(portalSites).where(eq(portalSites.id, site.id));
    const changes = await rawChanges(deps.db, fresh!);
    const hidden = new Set(
      (
        await deps.db
          .select({
            id: portalDocs.id,
            unlisted: portalDocs.unlisted,
            version: portalVersions.name,
          })
          .from(portalDocs)
          .innerJoin(portalVersions, eq(portalVersions.id, portalDocs.versionId))
          .where(eq(portalDocs.siteId, site.id))
      )
        .filter((r) => r.unlisted || r.version === 'next')
        .map((r) => r.id),
    );
    const keys = changes
      .filter((c) => !(c.kind === 'doc' && c.id && hidden.has(c.id)))
      .map((c) => c.key);
    if (keys.length) {
      const p = await publish(
        deps,
        a,
        site.id,
        { keys, note: input.source },
        { ip: null, userAgent: 'portal-import', locale: null },
      );
      publishNumber = p.number;
    }
  }
  return {
    siteId: site.id,
    created,
    report: { ...report, id: saved!.id, actor: null },
    publishNumber,
  };
}
