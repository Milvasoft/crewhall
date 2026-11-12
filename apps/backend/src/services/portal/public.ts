import { and, eq, gt, inArray, isNull, lte, sql } from 'drizzle-orm';
import {
  portalAuthors,
  portalDocs,
  portalPosts,
  portalRedirects,
  portalSites,
  portalVersions,
  type DbOrTx,
  type PortalSiteSettingsData,
} from '@crewhall/db';
import {
  docToMarkdown,
  headings,
  markdownToDoc,
  readingMinutes,
  splitAtTruncate,
  type EditorDoc,
  toPublicDoc,
} from '@crewhall/editor';
import {
  PortalHome,
  PortalNavigation,
  type PortalHeading,
  type PortalPublicAuthor,
  type PortalPublicPage,
  type PortalPublicPath,
  type PortalPublicPost,
  type PortalPublicPostSummary,
  type PortalPublicSite,
  type PortalSearchHit,
  type PortalSeo,
  type PortalSidebarItem,
  type PortalTranslationState,
} from '@crewhall/shared';
import type { Context } from 'hono';
import type { Deps } from '../../deps';
import { AppError } from '../../http/errors';
import type { AppEnv } from '../../http/types';
import type { SiteRow } from './access';
import { defaultHome, defaultNavigation } from './defaults';
import { portalEnabled } from './module';
import { verifyPreview } from './preview';
import { normalizePath } from './redirects';
import { hashTokenValue } from './token';
import {
  blogPath,
  compareVersions,
  docPath,
  homePath,
  POSTS_PER_PAGE,
  postPath,
  tagSlug,
} from './urls';

/**
 * Read-only content API of the Next.js site (design 11; doc 17 §2 "portal → api"). The site
 * authenticates with its content token; only published snapshots are served, unless a valid
 * preview token (design 11.13) asks for drafts and `next`.
 */
export interface PublicCtx {
  db: DbOrTx;
  site: SiteRow;
  preview: boolean;
}

export async function publicContext(deps: Deps, c: Context<AppEnv>): Promise<PublicCtx> {
  const auth = c.req.header('authorization') ?? '';
  const token = /^Bearer\s+(\S+)$/i.exec(auth)?.[1];
  if (!token) throw new AppError('portal_token_invalid');
  const [site] = await deps.db
    .select()
    .from(portalSites)
    .where(eq(portalSites.tokenHash, hashTokenValue(token)));
  if (!site) throw new AppError('portal_token_invalid');
  // A disabled module serves nothing: the site shows 404s until it is switched on again.
  if (!(await portalEnabled(deps.db, site.orgId)))
    throw new AppError('not_found', { reason: 'module_disabled' });
  const previewSite = verifyPreview(deps.env, c.req.header('x-portal-preview'));
  return { db: deps.db, site, preview: previewSite === site.id };
}

const settingsOf = (site: SiteRow) => site.settings as PortalSiteSettingsData;
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

// --- versions -----------------------------------------------------------------

interface VersionView {
  id: string;
  name: string;
  label: string;
  status: 'next' | 'current' | 'archived';
  showInPicker: boolean;
}

async function publicVersions(ctx: PublicCtx): Promise<VersionView[]> {
  const rows = await ctx.db
    .select()
    .from(portalVersions)
    .where(eq(portalVersions.siteId, ctx.site.id));
  const nextVisible = ctx.preview || settingsOf(ctx.site).nextPublic;
  return rows
    .filter((v) => v.status !== 'next' || nextVisible)
    .sort((a, b) => compareVersions(b.name, a.name))
    .map((v) => ({
      id: v.id,
      name: v.name,
      label: v.label,
      status: v.status,
      showInPicker: v.showInPicker,
    }));
}

async function versionView(ctx: PublicCtx, name: string) {
  const v = (await publicVersions(ctx)).find((x) => x.name === name);
  if (!v) throw new AppError('not_found', { version: name });
  return v;
}

// --- site ---------------------------------------------------------------------

/** Doc nav items carry the resolved href, so links survive slug changes (design 10.9). */
async function resolveNavigation(ctx: PublicCtx, nav: PortalNavigation): Promise<PortalNavigation> {
  const groups = [
    ...nav.navbar.items.map((i) => i.docGroupId),
    ...nav.footer.columns.flatMap((c) => c.items.map((i) => i.docGroupId)),
  ].filter((g): g is string => !!g);
  if (!groups.length) return nav;
  const current = (await publicVersions(ctx)).find((v) => v.status === 'current');
  if (!current) return nav;
  const rows = await structure(ctx, current.id);
  const slugOf = new Map(
    rows.filter((r) => r.locale === ctx.site.defaultLocale).map((r) => [r.groupId, r.slug]),
  );
  const href = (g: string | null | undefined, fallback: string | null | undefined) => {
    const slug = g ? slugOf.get(g) : undefined;
    return slug ? `/docs/${current.name}/${slug}` : (fallback ?? null);
  };
  return {
    navbar: {
      ...nav.navbar,
      items: nav.navbar.items.map((i) => ({
        ...i,
        href: i.kind === 'doc' ? href(i.docGroupId, i.href) : (i.href ?? null),
      })),
    },
    footer: {
      ...nav.footer,
      columns: nav.footer.columns.map((c) => ({
        ...c,
        items: c.items.map((i) => ({
          ...i,
          href: i.docGroupId ? href(i.docGroupId, i.href) : (i.href ?? null),
        })),
      })),
    },
  };
}

export async function publicSite(ctx: PublicCtx): Promise<PortalPublicSite> {
  const { site } = ctx;
  const navRaw = ctx.preview
    ? site.navDraft
    : (site.nav ?? defaultNavigation(site.name, site.defaultLocale));
  const homeRaw = ctx.preview
    ? site.homeDraft
    : (site.home ?? defaultHome(site.name, site.defaultLocale));
  const { revalidateUrl: _r, previewUrl: _p, ...settings } = settingsOf(site);
  return {
    name: site.name,
    url: settings.url,
    locales: site.locales,
    defaultLocale: site.defaultLocale,
    settings,
    versions: (await publicVersions(ctx)).map(({ id: _id, ...v }) => v),
    navigation: await resolveNavigation(ctx, PortalNavigation.parse(navRaw)),
    home: PortalHome.parse(homeRaw),
    publishedAt: iso(site.lastPublishedAt),
    preview: ctx.preview,
  };
}

// --- doc structure ------------------------------------------------------------

interface DocView {
  id: string;
  groupId: string;
  locale: string;
  kind: 'doc' | 'category';
  title: string;
  slug: string;
  description: string | null;
  sidebarLabel: string | null;
  position: number;
  parentGroupId: string | null;
  unlisted: boolean;
  categoryLink: 'none' | 'generated-index' | 'doc';
  categorySlug: string | null;
  seo: PortalSeo;
  frontMatter: Record<string, unknown>;
  rev: number;
  sourceRev: number | null;
  at: Date;
}

/** Published (or, in preview, draft) structure of a version, every locale. */
async function structure(ctx: PublicCtx, versionId: string): Promise<DocView[]> {
  if (ctx.preview) {
    const rows = await ctx.db
      .select()
      .from(portalDocs)
      .where(and(eq(portalDocs.versionId, versionId), isNull(portalDocs.deletedAt)));
    return rows.map((r) => ({
      id: r.id,
      groupId: r.groupId,
      locale: r.locale,
      kind: r.kind,
      title: r.title,
      slug: r.slug,
      description: r.description,
      sidebarLabel: r.sidebarLabel,
      position: r.position,
      parentGroupId: r.parentGroupId,
      unlisted: r.unlisted,
      categoryLink: r.categoryLink,
      categorySlug: r.categorySlug,
      seo: r.seo as PortalSeo,
      frontMatter: r.frontMatter,
      rev: r.rev,
      sourceRev: r.sourceRev,
      at: r.updatedAt,
    }));
  }
  const rows = await ctx.db
    .select({
      id: portalDocs.id,
      groupId: portalDocs.groupId,
      locale: portalDocs.locale,
      kind: portalDocs.kind,
      title: portalDocs.pubTitle,
      slug: portalDocs.pubSlug,
      description: portalDocs.pubDescription,
      sidebarLabel: portalDocs.pubSidebarLabel,
      position: portalDocs.pubPosition,
      parentGroupId: portalDocs.pubParentGroupId,
      unlisted: portalDocs.pubUnlisted,
      categoryLink: portalDocs.pubCategoryLink,
      categorySlug: portalDocs.pubCategorySlug,
      seo: portalDocs.pubSeo,
      frontMatter: portalDocs.pubFrontMatter,
      rev: portalDocs.publishedRev,
      sourceRev: portalDocs.pubSourceRev,
      at: portalDocs.publishedAt,
    })
    .from(portalDocs)
    .where(and(eq(portalDocs.versionId, versionId), gt(portalDocs.publishedRev, 0)));
  return rows.map((r) => ({
    ...r,
    title: r.title ?? '',
    slug: r.slug ?? '',
    position: r.position ?? 0,
    unlisted: r.unlisted ?? false,
    categoryLink: r.categoryLink ?? 'none',
    seo: (r.seo ?? {}) as PortalSeo,
    frontMatter: r.frontMatter ?? {},
    at: r.at ?? new Date(0),
  }));
}

interface Tree {
  /** The rows shown for `locale`: own translation or the source. */
  rows: DocView[];
  byGroup: Map<string, DocView>;
  source: Map<string, DocView>;
  own: Map<string, DocView>;
}

function treeFor(all: DocView[], locale: string, defaultLocale: string): Tree {
  const source = new Map(all.filter((r) => r.locale === defaultLocale).map((r) => [r.groupId, r]));
  const own = new Map(all.filter((r) => r.locale === locale).map((r) => [r.groupId, r]));
  const groups = new Set([...source.keys(), ...own.keys()]);
  const byGroup = new Map<string, DocView>();
  for (const g of groups) {
    const src = source.get(g);
    const mine = own.get(g);
    // Structure from the source; title and texts from the translation when there is one.
    const base = src ?? mine!;
    byGroup.set(g, mine && src ? { ...src, ...pickTexts(mine) } : base);
  }
  return { rows: [...byGroup.values()], byGroup, source, own };
}

const pickTexts = (r: DocView) => ({
  id: r.id,
  locale: r.locale,
  title: r.title,
  sidebarLabel: r.sidebarLabel,
  description: r.description,
  seo: r.seo,
  frontMatter: r.frontMatter,
  rev: r.rev,
  sourceRev: r.sourceRev,
  at: r.at,
});

const categoryTarget = (c: DocView) => (c.categoryLink === 'none' ? null : c.categorySlug);

function children(tree: Tree, parent: string | null) {
  return tree.rows
    .filter((r) => r.parentGroupId === parent && !r.unlisted)
    .sort(
      (a, b) =>
        a.position - b.position ||
        (a.sidebarLabel ?? a.title).localeCompare(b.sidebarLabel ?? b.title),
    );
}

function sidebarItems(tree: Tree, parent: string | null, depth = 0): PortalSidebarItem[] {
  if (depth > 30) return [];
  const linkedDoc = parent ? tree.byGroup.get(parent) : null;
  return children(tree, parent)
    .filter(
      (r) =>
        !(
          linkedDoc?.categoryLink === 'doc' &&
          r.kind === 'doc' &&
          r.slug === linkedDoc.categorySlug
        ),
    )
    .map((r): PortalSidebarItem =>
      r.kind === 'category'
        ? {
            kind: 'category',
            label: r.sidebarLabel ?? r.title,
            slug: categoryTarget(r),
            collapsed:
              typeof r.frontMatter.collapsed === 'boolean' ? r.frontMatter.collapsed : true,
            items: sidebarItems(tree, r.groupId, depth + 1),
          }
        : { kind: 'doc', label: r.sidebarLabel ?? r.title, slug: r.slug, docSlug: r.slug },
    );
}

/** Pages in sidebar order, for previous / next (category index pages included). */
function flatten(items: PortalSidebarItem[], out: { title: string; slug: string }[] = []) {
  for (const i of items) {
    if (i.slug) out.push({ title: i.label, slug: i.slug });
    if (i.items) flatten(i.items, out);
  }
  return out;
}

export async function publicSidebar(ctx: PublicCtx, q: { version: string; locale: string }) {
  if (!ctx.site.locales.includes(q.locale)) throw new AppError('not_found');
  const version = await versionView(ctx, q.version);
  const tree = treeFor(await structure(ctx, version.id), q.locale, ctx.site.defaultLocale);
  return { items: sidebarItems(tree, null) };
}

async function markdownOf(ctx: PublicCtx, docId: string) {
  const [row] = await ctx.db
    .select({ md: portalDocs.contentMd, content: portalDocs.content })
    .from(portalDocs)
    .where(eq(portalDocs.id, docId));
  if (!row) return '';
  return ctx.preview ? docToMarkdown(toPublicDoc(row.content as EditorDoc)) : (row.md ?? '');
}

function toHeadings(markdown: string): PortalHeading[] {
  return headings(markdownToDoc(markdown).doc).map((h) => ({
    id: h.id,
    text: h.text,
    level: h.level,
  }));
}

function breadcrumbs(tree: Tree, row: DocView) {
  const out: { label: string; slug: string | null }[] = [];
  let g = row.parentGroupId;
  for (let i = 0; g && i < 30; i++) {
    const c = tree.byGroup.get(g);
    if (!c) break;
    out.unshift({ label: c.sidebarLabel ?? c.title, slug: categoryTarget(c) });
    g = c.parentGroupId;
  }
  return out;
}

function translationOf(
  tree: Tree,
  row: DocView,
  locale: string,
  defaultLocale: string,
): PortalTranslationState {
  if (locale === defaultLocale) return 'source';
  const mine = tree.own.get(row.groupId);
  const src = tree.source.get(row.groupId);
  if (!mine) return src ? 'missing' : 'source';
  if (!src) return 'source';
  return (mine.sourceRev ?? 0) < src.rev ? 'outdated' : 'current';
}

async function otherVersions(ctx: PublicCtx, slug: string, isCategory: boolean) {
  const out: { version: string; slug: string }[] = [];
  for (const v of await publicVersions(ctx)) {
    const rows = await structure(ctx, v.id);
    const hit = rows.find(
      (r) =>
        r.locale === ctx.site.defaultLocale &&
        (isCategory ? r.categorySlug === slug : r.kind === 'doc' && r.slug === slug),
    );
    if (hit) out.push({ version: v.name, slug });
  }
  return out;
}

export async function publicPage(
  ctx: PublicCtx,
  q: { version: string; locale: string; slug: string },
): Promise<PortalPublicPage> {
  if (!ctx.site.locales.includes(q.locale)) throw new AppError('not_found');
  const version = await versionView(ctx, q.version);
  const tree = treeFor(await structure(ctx, version.id), q.locale, ctx.site.defaultLocale);
  const slug = q.slug.replace(/^\/+|\/+$/g, '');
  const order = flatten(sidebarItems(tree, null));
  const idx = order.findIndex((p) => p.slug === slug);
  const previous = idx > 0 ? order[idx - 1]! : null;
  const next = idx >= 0 && idx < order.length - 1 ? order[idx + 1]! : null;

  if (slug.startsWith('category/')) {
    const cat = tree.rows.find(
      (r) =>
        r.kind === 'category' && r.categoryLink === 'generated-index' && r.categorySlug === slug,
    );
    if (!cat) throw new AppError('not_found');
    return {
      kind: 'category',
      title: cat.sidebarLabel ?? cat.title,
      description: cat.description,
      slug,
      version: version.name,
      contentLocale: cat.locale,
      items: children(tree, cat.groupId).map((r) => ({
        kind: r.kind,
        title: r.sidebarLabel ?? r.title,
        description: r.description,
        slug: r.kind === 'category' ? categoryTarget(r) : r.slug,
      })),
      breadcrumbs: breadcrumbs(tree, cat),
      previous,
      next,
      versions: await otherVersions(ctx, slug, true),
    };
  }

  const row = tree.rows.find((r) => r.kind === 'doc' && r.slug === slug);
  if (!row) throw new AppError('not_found');
  const markdown = await markdownOf(ctx, row.id);
  // Other locales' own translations (the tree above only knows the requested locale).
  const all = await structure(ctx, version.id);
  const translated = new Set(all.filter((r) => r.groupId === row.groupId).map((r) => r.locale));
  return {
    kind: 'doc',
    title: row.title,
    description: row.description,
    slug,
    version: version.name,
    contentLocale: row.locale,
    translation: translationOf(tree, row, q.locale, ctx.site.defaultLocale),
    markdown,
    headings: toHeadings(markdown),
    breadcrumbs: breadcrumbs(tree, row),
    previous,
    next,
    alternates: ctx.site.locales.filter((l) => translated.has(l)).map((l) => ({ locale: l, slug })),
    versions: await otherVersions(ctx, slug, false),
    seo: row.seo,
    frontMatter: row.frontMatter,
    publishedAt: iso(row.at),
    updatedAt: row.at.toISOString(),
  };
}

// --- posts --------------------------------------------------------------------

interface PostView {
  id: string;
  groupId: string;
  locale: string;
  slug: string;
  title: string;
  description: string | null;
  authorIds: string[];
  tags: string[];
  date: Date;
  cover: string | null;
  excerpt: string;
  truncated: boolean;
  readingMinutes: number;
  seo: PortalSeo;
  at: Date;
}

async function postRows(ctx: PublicCtx): Promise<PostView[]> {
  if (ctx.preview) {
    const rows = await ctx.db
      .select()
      .from(portalPosts)
      .where(and(eq(portalPosts.siteId, ctx.site.id), isNull(portalPosts.deletedAt)));
    return rows.map((r) => {
      const content = toPublicDoc(r.content as EditorDoc);
      const { excerpt, truncated } = splitAtTruncate(content);
      return {
        id: r.id,
        groupId: r.groupId,
        locale: r.locale,
        slug: r.slug,
        title: r.title,
        description: r.description,
        authorIds: r.authorIds,
        tags: r.tags,
        date: r.date ?? r.scheduledAt ?? r.updatedAt,
        cover: r.cover,
        excerpt: docToMarkdown(excerpt),
        truncated,
        readingMinutes: readingMinutes(content),
        seo: r.seo as PortalSeo,
        at: r.updatedAt,
      };
    });
  }
  const rows = await ctx.db
    .select()
    .from(portalPosts)
    .where(
      and(
        eq(portalPosts.siteId, ctx.site.id),
        gt(portalPosts.publishedRev, 0),
        lte(portalPosts.visibleAt, new Date()),
      ),
    );
  return rows.map((r) => ({
    id: r.id,
    groupId: r.groupId,
    locale: r.locale,
    slug: r.pubSlug ?? r.slug,
    title: r.pubTitle ?? r.title,
    description: r.pubDescription,
    authorIds: r.pubAuthorIds ?? [],
    tags: r.pubTags ?? [],
    date: r.pubDate ?? r.visibleAt ?? r.publishedAt ?? r.createdAt,
    cover: r.pubCover,
    excerpt: r.excerptMd ?? '',
    truncated: r.truncated ?? false,
    readingMinutes: r.readingMinutes ?? 1,
    seo: (r.pubSeo ?? {}) as PortalSeo,
    at: r.publishedAt ?? r.updatedAt,
  }));
}

/** Posts of a locale: own translations plus untranslated source posts, newest first. */
function postsFor(all: PostView[], locale: string, defaultLocale: string) {
  const own = all.filter((p) => p.locale === locale);
  const ownGroups = new Set(own.map((p) => p.groupId));
  const fallback =
    locale === defaultLocale
      ? []
      : all.filter((p) => p.locale === defaultLocale && !ownGroups.has(p.groupId));
  return [...own, ...fallback].sort(
    (a, b) => b.date.getTime() - a.date.getTime() || a.slug.localeCompare(b.slug),
  );
}

async function authorsMap(ctx: PublicCtx) {
  const rows = await ctx.db
    .select()
    .from(portalAuthors)
    .where(eq(portalAuthors.siteId, ctx.site.id));
  return new Map(
    rows.map((r): [string, PortalPublicAuthor & { id: string }] => [
      r.id,
      { id: r.id, key: r.key, name: r.name, title: r.title, url: r.url, imageUrl: r.imageUrl },
    ]),
  );
}

function summaryOf(
  p: PostView,
  authors: Map<string, PortalPublicAuthor & { id: string }>,
): PortalPublicPostSummary {
  return {
    slug: p.slug,
    title: p.title,
    description: p.description,
    date: p.date.toISOString(),
    contentLocale: p.locale,
    authors: p.authorIds
      .map((id) => authors.get(id))
      .filter((x): x is PortalPublicAuthor & { id: string } => !!x)
      .map(({ id: _id, ...rest }) => rest),
    tags: p.tags,
    readingMinutes: p.readingMinutes,
    cover: p.cover,
    excerpt: p.excerpt,
    truncated: p.truncated,
  };
}

export async function publicPosts(
  ctx: PublicCtx,
  q: {
    locale: string;
    tag?: string | undefined;
    author?: string | undefined;
    page: number;
    pageSize: number;
  },
) {
  if (!ctx.site.locales.includes(q.locale)) throw new AppError('not_found');
  const authors = await authorsMap(ctx);
  const authorId = q.author ? [...authors.values()].find((x) => x.key === q.author)?.id : undefined;
  let list = postsFor(await postRows(ctx), q.locale, ctx.site.defaultLocale);
  if (q.tag) list = list.filter((p) => p.tags.some((t) => tagSlug(t) === tagSlug(q.tag!)));
  if (q.author) list = authorId ? list.filter((p) => p.authorIds.includes(authorId)) : [];
  const size = q.pageSize === 0 ? Math.max(1, list.length) : q.pageSize;
  const pages = Math.max(1, Math.ceil(list.length / size));
  const items = list.slice((q.page - 1) * size, q.page * size).map((p) => summaryOf(p, authors));
  return { items, total: list.length, pages };
}

export async function publicPost(
  ctx: PublicCtx,
  q: { locale: string; slug: string },
): Promise<PortalPublicPost> {
  if (!ctx.site.locales.includes(q.locale)) throw new AppError('not_found');
  const all = await postRows(ctx);
  const list = postsFor(all, q.locale, ctx.site.defaultLocale);
  const idx = list.findIndex((p) => p.slug === q.slug);
  const post = list[idx];
  if (!post) throw new AppError('not_found');
  const authors = await authorsMap(ctx);
  const [row] = await ctx.db
    .select({ md: portalPosts.contentMd, content: portalPosts.content })
    .from(portalPosts)
    .where(eq(portalPosts.id, post.id));
  const markdown = ctx.preview
    ? docToMarkdown(toPublicDoc(row!.content as EditorDoc))
    : (row?.md ?? '');
  const newer = idx > 0 ? list[idx - 1]! : null;
  const older = idx < list.length - 1 ? list[idx + 1]! : null;
  const translated = new Set(all.filter((p) => p.groupId === post.groupId).map((p) => p.locale));
  return {
    ...summaryOf(post, authors),
    markdown,
    headings: toHeadings(markdown),
    newer: newer ? { title: newer.title, slug: newer.slug } : null,
    older: older ? { title: older.title, slug: older.slug } : null,
    seo: post.seo,
    alternates: ctx.site.locales
      .filter((l) => translated.has(l))
      .map((l) => ({ locale: l, slug: post.slug })),
    updatedAt: post.at.toISOString(),
  };
}

export async function publicTags(ctx: PublicCtx, locale: string) {
  if (!ctx.site.locales.includes(locale)) throw new AppError('not_found');
  const counts = new Map<string, number>();
  for (const p of postsFor(await postRows(ctx), locale, ctx.site.defaultLocale)) {
    for (const t of p.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return {
    items: [...counts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([tag, count]) => ({ tag, count })),
  };
}

export async function publicAuthors(ctx: PublicCtx) {
  const authors = await authorsMap(ctx);
  return { items: [...authors.values()].map(({ id: _id, ...a }) => a) };
}

// --- paths ----------------------------------------------------------------------

/** Every public page (sitemap, hreflang, the URL comparison of design 10.16). */
export async function publicPaths(ctx: PublicCtx): Promise<PortalPublicPath[]> {
  const { site } = ctx;
  const d = site.defaultLocale;
  const out: PortalPublicPath[] = [];
  const all = (fn: (l: string) => string) =>
    Object.fromEntries(site.locales.map((l) => [l, fn(l)]));
  const push = (
    kind: PortalPublicPath['kind'],
    fn: (l: string) => string,
    updatedAt: Date | null,
    noindex: boolean,
    locales = site.locales,
  ) => {
    const alternates = all(fn);
    for (const l of locales)
      out.push({ path: fn(l), locale: l, kind, updatedAt: iso(updatedAt), alternates, noindex });
  };
  push('home', (l) => homePath(l, d), site.lastPublishedAt, false);
  for (const v of await publicVersions(ctx)) {
    const rows = await structure(ctx, v.id);
    const source = rows.filter((r) => r.locale === d);
    const groups = new Set(source.map((r) => r.groupId));
    const noVersionIndex = v.status === 'next';
    for (const r of source) {
      if (r.unlisted) continue;
      const slug =
        r.kind === 'doc' ? r.slug : r.categoryLink === 'generated-index' ? r.categorySlug : null;
      if (!slug) continue;
      push(
        r.kind,
        (l) => docPath(l, d, v.name, slug),
        r.at,
        noVersionIndex || r.seo.noindex === true || r.seo.excludeFromSitemap === true,
      );
    }
    // Docs that exist only in a non-default locale.
    for (const r of rows) {
      if (r.locale === d || groups.has(r.groupId) || r.unlisted || r.kind !== 'doc') continue;
      out.push({
        path: docPath(r.locale, d, v.name, r.slug),
        locale: r.locale,
        kind: 'doc',
        updatedAt: iso(r.at),
        alternates: { [r.locale]: docPath(r.locale, d, v.name, r.slug) },
        noindex: noVersionIndex,
      });
    }
  }
  const posts = await postRows(ctx);
  if (posts.length) {
    const authors = new Set<string>();
    for (const l of site.locales) {
      const list = postsFor(posts, l, d);
      if (!list.length) continue;
      const pages = Math.ceil(list.length / POSTS_PER_PAGE);
      push('blog', () => blogPath(l, d), list[0]!.date, false, [l]);
      for (let n = 2; n <= pages; n++)
        push('blog', () => blogPath(l, d, `page/${n}`), null, false, [l]);
      for (const p of list) {
        p.authorIds.forEach((a) => authors.add(a));
        out.push({
          path: postPath(l, d, p.slug),
          locale: l,
          kind: 'post',
          updatedAt: iso(p.at),
          alternates: all((x) => postPath(x, d, p.slug)),
          noindex: p.seo.noindex === true || p.seo.excludeFromSitemap === true,
        });
      }
      const tags = new Map<string, number>();
      for (const p of list)
        for (const t of p.tags) tags.set(tagSlug(t), (tags.get(tagSlug(t)) ?? 0) + 1);
      push('tag', () => blogPath(l, d, 'tags'), null, false, [l]);
      for (const [t, count] of tags) {
        push('tag', () => blogPath(l, d, `tags/${t}`), null, false, [l]);
        for (let n = 2; n <= Math.ceil(count / POSTS_PER_PAGE); n++)
          push('tag', () => blogPath(l, d, `tags/${t}/page/${n}`), null, false, [l]);
      }
      push('blog', () => blogPath(l, d, 'archive'), null, false, [l]);
      push('blog', () => blogPath(l, d, 'authors'), null, false, [l]);
    }
  }
  push('page', (l) => `${l === d ? '' : `/${l}`}/search`, null, true);
  return out;
}

export async function publicPathCount(db: DbOrTx, site: SiteRow) {
  if (!site.lastPublishedAt) return 0;
  const paths = await publicPaths({ db, site, preview: false });
  return paths.filter((p) => !p.noindex).length;
}

// --- redirects and search ---------------------------------------------------------

export async function publicRedirect(ctx: PublicCtx, path: string) {
  const wanted = normalizePath(path.split('?')[0] ?? path);
  const [row] = await ctx.db
    .select()
    .from(portalRedirects)
    .where(and(eq(portalRedirects.siteId, ctx.site.id), eq(portalRedirects.fromPath, wanted)));
  if (!row) throw new AppError('not_found');
  return { to: row.toPath, code: row.code === 308 ? (308 as const) : (301 as const) };
}

/** ts_headline markers (chr(1) / chr(2)): cannot occur in content, replaced after escaping. */
const START_SEL = String.fromCharCode(1);
const STOP_SEL = String.fromCharCode(2);

function snippetHtml(raw: string) {
  const cleaned = raw
    .replace(/```[a-zA-Z0-9]*/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[#>\-*:]+\s*/gm, '')
    .replace(/[*_`|]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const escaped = cleaned
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  return escaped.split(START_SEL).join('<mark>').split(STOP_SEL).join('</mark>');
}

/**
 * GET /public/portal/search (doc 17 §9 "Arama"): portal_docs.search and portal_posts.search,
 * prefix matching per word, the requested locale and version first, ts_headline snippets.
 */
export async function publicSearch(
  ctx: PublicCtx,
  q: { q: string; locale?: string | undefined; version?: string | undefined; limit: number },
): Promise<PortalSearchHit[]> {
  const { site } = ctx;
  const locale = q.locale && site.locales.includes(q.locale) ? q.locale : site.defaultLocale;
  const words = q.q
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}_-]/gu, ''))
    .filter(Boolean)
    .slice(0, 8);
  if (!words.length) return [];
  const terms = words.map((w) => `${w.replace(/-/g, ' <-> ')}:*`);
  // Every word (ranked higher) or any word; and the words glued together against title + slug,
  // so a mistyped URL like /milvaion/quickstart still finds "Quick Start" (design 11.12).
  const tsqAll = terms.join(' & ');
  const tsqAny = terms.join(' | ');
  const compact = words
    .join('')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
  // Each query word found in the title counts ("redis cache" → Caching.Redis first).
  const titleWords = `{${words.map((w) => `"${w.replace(/["\\%_]/g, '')}"`).join(',')}}`;
  const compactLike = compact.length >= 4 ? `%${compact}%` : null;
  const like = `%${q.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  const versions = await publicVersions(ctx);
  if (!versions.length) return [];
  const versionIds = versions.map((v) => v.id);
  const versionName = new Map(versions.map((v) => [v.id, v.name]));
  const current = versions.find((v) => v.status === 'current');
  const preferred =
    q.version && versions.some((v) => v.name === q.version) ? q.version : (current?.name ?? null);
  const preferredId = versions.find((v) => v.name === preferred)?.id ?? null;
  const locales = [...new Set([locale, site.defaultLocale])];

  const docs = await ctx.db.execute<{
    id: string;
    group_id: string;
    version_id: string;
    locale: string;
    title: string;
    slug: string;
    parent: string | null;
    rank: number;
    snippet: string;
  }>(sql`
    select d.id, d.group_id, d.version_id, d.locale, d.pub_title as title, d.pub_slug as slug,
      d.pub_parent_group_id as parent,
      ts_rank_cd(d.search, qq.q, 32) + (case when d.search @@ qq.qa then 2 else 0 end)
        + (case when d.pub_title ilike ${like} then 5 else 0 end)
        + 1.5 * (select count(*) from unnest(${titleWords}::text[]) w where d.pub_title ilike '%' || w || '%')
        + (case when regexp_replace(lower(coalesce(d.pub_title, '') || coalesce(d.pub_slug, '')), '[^[:alnum:]]', '', 'g') like ${compactLike} then 4 else 0 end) as rank,
      ts_headline(c.cfg, coalesce(d.content_md, ''), qq.q,
        'StartSel=' || chr(1) || ',StopSel=' || chr(2) || ',MaxWords=26,MinWords=12,MaxFragments=1,ShortWord=2') as snippet
    from ${portalDocs} d
    cross join lateral (select (case when d.locale like 'tr%' then 'turkish' when d.locale like 'en%' then 'english' else 'simple' end)::regconfig as cfg) c
    cross join lateral (select to_tsquery(c.cfg, ${tsqAny}) as q, to_tsquery(c.cfg, ${tsqAll}) as qa) qq
    where d.site_id = ${site.id} and d.published_rev > 0 and d.kind = 'doc'
      and coalesce(d.pub_unlisted, false) = false
      and d.version_id in (${sql.join(
        versionIds.map((v) => sql`${v}`),
        sql`, `,
      )})
      and d.locale in (${sql.join(
        locales.map((l) => sql`${l}`),
        sql`, `,
      )})
      and (d.search @@ qq.q or d.pub_title ilike ${like}
        or regexp_replace(lower(coalesce(d.pub_title, '') || coalesce(d.pub_slug, '')), '[^[:alnum:]]', '', 'g') like ${compactLike})
    order by (d.version_id = ${preferredId}) desc, (d.locale = ${locale}) desc, rank desc
    limit ${q.limit * 6}`);

  // Category titles for the "section" line.
  const parents = [...new Set(docs.rows.map((r) => r.parent).filter((p): p is string => !!p))];
  const cats = parents.length
    ? await ctx.db
        .select({
          groupId: portalDocs.groupId,
          versionId: portalDocs.versionId,
          locale: portalDocs.locale,
          title: portalDocs.pubTitle,
        })
        .from(portalDocs)
        .where(
          and(
            eq(portalDocs.siteId, site.id),
            inArray(portalDocs.groupId, parents),
            gt(portalDocs.publishedRev, 0),
          ),
        )
    : [];
  const catTitle = (groupId: string, versionId: string) =>
    (
      cats.find((c) => c.groupId === groupId && c.versionId === versionId && c.locale === locale) ??
      cats.find((c) => c.groupId === groupId && c.versionId === versionId)
    )?.title ?? null;

  const seen = new Set<string>();
  const hits: (PortalSearchHit & { rank: number })[] = [];
  for (const r of docs.rows) {
    const key = r.group_id;
    if (seen.has(key)) continue;
    seen.add(key);
    const v = versionName.get(r.version_id) ?? '';
    hits.push({
      kind: 'doc',
      title: r.title,
      path: docPath(locale, site.defaultLocale, v, r.slug),
      section: r.parent ? catTitle(r.parent, r.version_id) : null,
      snippet: snippetHtml(r.snippet),
      locale: r.locale,
      version: v,
      rank: Number(r.rank) + (r.version_id === preferredId ? 0.5 : 0),
    });
  }

  const now = new Date();
  const posts = await ctx.db.execute<{
    group_id: string;
    locale: string;
    title: string;
    slug: string;
    rank: number;
    snippet: string;
  }>(sql`
    select p.group_id, p.locale, p.pub_title as title, p.pub_slug as slug,
      ts_rank_cd(p.search, qq.q, 32) + (case when p.search @@ qq.qa then 2 else 0 end)
        + (case when p.pub_title ilike ${like} then 5 else 0 end)
        + 1.5 * (select count(*) from unnest(${titleWords}::text[]) w where p.pub_title ilike '%' || w || '%')
        + (case when regexp_replace(lower(coalesce(p.pub_title, '') || coalesce(p.pub_slug, '')), '[^[:alnum:]]', '', 'g') like ${compactLike} then 4 else 0 end) as rank,
      ts_headline(c.cfg, coalesce(p.content_md, ''), qq.q,
        'StartSel=' || chr(1) || ',StopSel=' || chr(2) || ',MaxWords=26,MinWords=12,MaxFragments=1,ShortWord=2') as snippet
    from ${portalPosts} p
    cross join lateral (select (case when p.locale like 'tr%' then 'turkish' when p.locale like 'en%' then 'english' else 'simple' end)::regconfig as cfg) c
    cross join lateral (select to_tsquery(c.cfg, ${tsqAny}) as q, to_tsquery(c.cfg, ${tsqAll}) as qa) qq
    where p.site_id = ${site.id} and p.published_rev > 0 and p.visible_at <= ${now}
      and p.locale in (${sql.join(
        locales.map((l) => sql`${l}`),
        sql`, `,
      )})
      and (p.search @@ qq.q or p.pub_title ilike ${like}
        or regexp_replace(lower(coalesce(p.pub_title, '') || coalesce(p.pub_slug, '')), '[^[:alnum:]]', '', 'g') like ${compactLike})
    order by (p.locale = ${locale}) desc, rank desc
    limit ${q.limit * 3}`);
  const seenPosts = new Set<string>();
  for (const r of posts.rows) {
    if (seenPosts.has(r.group_id)) continue;
    seenPosts.add(r.group_id);
    hits.push({
      kind: 'post',
      title: r.title,
      path: postPath(locale, site.defaultLocale, r.slug),
      section: null,
      snippet: snippetHtml(r.snippet),
      locale: r.locale,
      version: null,
      rank: Number(r.rank) * 0.8,
    });
  }
  return hits
    .sort((a, b) => b.rank - a.rank)
    .slice(0, q.limit)
    .map(({ rank: _r, ...h }) => h);
}
