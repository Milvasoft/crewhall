import { docToMarkdown } from '@crewhall/editor';
import {
  can,
  type PortalChange,
  type PortalDoc,
  type PortalItemStatus,
  type PortalMedia,
  type PortalNavigation,
  type PortalPost,
  type PortalPostStatus,
  type PortalPostSummary,
  type PortalPublish,
  type PortalPublishJob,
  type PortalPublishSummary,
  type PortalRichDoc,
  type PortalSite,
  type PortalSiteSummary,
  type PortalTranslationState,
  type PortalTreeItem,
  type PortalVersion,
  type UserSummary,
} from '@crewhall/shared';
import { http, HttpResponse, type HttpHandler } from 'msw';
import {
  actorOf,
  memberOf,
  MockApiError,
  orgCtx,
  paginate,
  randomToken,
  requireUser,
  summary,
  type Resolvers,
} from './core';
import { db, newId } from './db';
import {
  md,
  seedPortal,
  type MockPortalDoc,
  type MockPortalPost,
  type MockPortalPublish,
  type MockPortalSite,
  type MockPortalVersion,
  type PortalState,
} from './portalSeed';
import { type MockState, type MockUser } from './seed';
import { mockPageSource } from './wiki';

/**
 * Portal CMS part of the contract mock (design 10): sites, versions, the doc tree with
 * translations, blog, home and navigation, media, redirects and the publish queue. Mutations
 * update the state so autosave (rev), publish (queue → history) and revert work end to end.
 */

type WithPortal = MockState & { portal?: PortalState };

export function portalState(s: MockState = db()): PortalState {
  const w = s as WithPortal;
  w.portal ??= seedPortal();
  return w.portal;
}

const now = () => new Date().toISOString();
const isFuture = (iso: string | null | undefined) =>
  Boolean(iso) && new Date(iso as string).getTime() > Date.now();

function userSummary(s: MockState, id: string | null): UserSummary | null {
  const u = id ? s.users.find((x) => x.id === id) : undefined;
  return u ? summary(u) : null;
}

// ---- permissions ----

type PortalNeed = 'read' | 'edit' | 'publish' | 'manage';

function capabilitiesOf(s: MockState, u: MockUser) {
  const actor = actorOf(s, u);
  const ctx = { type: 'org' as const, org: orgCtx(s) };
  const role = memberOf(s, u.id)?.role;
  return {
    edit: can(actor, 'portal.edit', ctx),
    publish: can(actor, 'portal.publish', ctx),
    manage: role === 'admin' || role === 'owner',
  };
}

function need(s: MockState, what: PortalNeed): MockUser {
  const u = requireUser(s);
  const c = capabilitiesOf(s, u);
  const ok =
    what === 'read'
      ? c.edit || c.publish
      : what === 'edit'
        ? c.edit
        : what === 'publish'
          ? c.publish
          : c.manage;
  if (!ok) throw new MockApiError('forbidden');
  return u;
}

// ---- lookups ----

function siteById(st: PortalState, id: string | undefined): MockPortalSite {
  const site = st.sites.find((x) => x.id === id);
  if (!site) throw new MockApiError('not_found');
  return site;
}

/** Hard-deleted rows are gone; deleted-but-published docs stay as "removed". */
const live = (d: { deletedAt: string | null; published: unknown }) =>
  !d.deletedAt || Boolean(d.published);

function docById(st: PortalState, id: string | undefined): MockPortalDoc {
  const d = st.docs.find((x) => x.id === id && live(x));
  if (!d) throw new MockApiError('not_found');
  return d;
}

function postById(st: PortalState, id: string | undefined): MockPortalPost {
  const p = st.posts.find((x) => x.id === id && live(x));
  if (!p) throw new MockApiError('not_found');
  return p;
}

function versionOf(st: PortalState, siteId: string, name: string): MockPortalVersion {
  const v = st.versions.find((x) => x.siteId === siteId && x.name === name);
  if (!v) throw new MockApiError('not_found');
  return v;
}

function sourceOf(st: PortalState, site: MockPortalSite, d: MockPortalDoc) {
  return st.docs.find((x) => x.groupId === d.groupId && x.locale === site.defaultLocale && live(x));
}

export function slugify(text: string): string {
  const map: Record<string, string> = { ç: 'c', ğ: 'g', ı: 'i', İ: 'i', ö: 'o', ş: 's', ü: 'u' };
  const out = text
    .toLocaleLowerCase('tr')
    .replace(/[çğıİöşü]/g, (c) => map[c] ?? c)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return out || 'page';
}

const localePrefix = (site: MockPortalSite, locale: string) =>
  locale === site.defaultLocale ? '' : `/${locale}`;

function docPath(
  site: MockPortalSite,
  d: Pick<MockPortalDoc, 'version' | 'locale' | 'slug' | 'kind' | 'categorySlug'>,
) {
  const slug = d.kind === 'category' && d.categorySlug ? d.categorySlug : d.slug;
  return `${localePrefix(site, d.locale)}/docs/${d.version}/${slug}`;
}

// ---- statuses ----

function docStatus(d: MockPortalDoc): PortalItemStatus {
  if (d.deletedAt) return 'removed';
  if (!d.published) return 'draft';
  return d.published.rev === d.rev ? 'published' : 'changed';
}

function translationState(
  st: PortalState,
  site: MockPortalSite,
  d: MockPortalDoc,
): PortalTranslationState {
  if (d.locale === site.defaultLocale) return 'source';
  const src = sourceOf(st, site, d);
  if (!src) return 'current';
  return (d.sourceRevMarked ?? 0) >= src.rev ? 'current' : 'outdated';
}

function postStatus(p: MockPortalPost): PortalPostStatus {
  if (p.deletedAt) return 'removed';
  if (!p.published) return isFuture(p.scheduledAt) ? 'scheduled' : 'draft';
  if (p.published.rev !== p.rev) return 'changed';
  return isFuture(p.published.at) ? 'scheduled' : 'published';
}

function postPending(p: MockPortalPost): boolean {
  if (p.deletedAt) return Boolean(p.published);
  return !p.published || p.published.rev !== p.rev;
}

function textOf(doc: PortalRichDoc): string {
  const parts: string[] = [];
  const walk = (n: { text?: string; content?: unknown[] }) => {
    if (n.text) parts.push(n.text);
    for (const c of (n.content ?? []) as { text?: string; content?: unknown[] }[]) walk(c);
  };
  walk(doc);
  return parts.join(' ');
}

const wordsOf = (doc: PortalRichDoc) => textOf(doc).split(/\s+/).filter(Boolean).length;

function codeBlocksOf(doc: PortalRichDoc): number {
  let n = 0;
  const walk = (x: { type?: string; content?: unknown[] }) => {
    if (x.type === 'codeBlock') n++;
    for (const c of (x.content ?? []) as { type?: string; content?: unknown[] }[]) walk(c);
  };
  walk(doc);
  return n;
}

// ---- converters ----

function toSummary(s: MockState, st: PortalState, site: MockPortalSite): PortalSiteSummary {
  const current = st.versions.find((v) => v.siteId === site.id && v.status === 'current');
  return {
    id: site.id,
    slug: site.slug,
    name: site.name,
    domain: site.domain,
    status: site.status,
    locales: site.locales,
    currentVersion: current?.name ?? null,
    publishedUrlCount: publishedUrlCount(st, site),
    pendingCount: changesOf(s, st, site).length,
  };
}

function toSite(s: MockState, st: PortalState, site: MockPortalSite, u: MockUser): PortalSite {
  const last = st.publishes
    .filter((p) => p.siteId === site.id)
    .sort((a, b) => b.number - a.number)[0];
  return {
    ...toSummary(s, st, site),
    defaultLocale: site.defaultLocale,
    settings: site.settings,
    contentSpaceId: site.contentSpaceId,
    tokenHint: site.tokenHint,
    lastPublishedAt: last?.createdAt ?? null,
    capabilities: capabilitiesOf(s, u),
    createdAt: site.createdAt,
    updatedAt: site.updatedAt,
  };
}

function publishedUrlCount(st: PortalState, site: MockPortalSite): number {
  const docs = st.docs.filter(
    (d) =>
      d.siteId === site.id &&
      d.published &&
      (d.kind === 'doc' || d.categoryLink === 'generated-index'),
  ).length;
  const posts = st.posts.filter((p) => p.siteId === site.id && p.published).length;
  const tags = new Set(
    st.posts.filter((p) => p.siteId === site.id && p.published).flatMap((p) => p.tags),
  ).size;
  return site.status === 'live' ? docs + posts + tags + site.locales.length * 3 : 0;
}

function toVersion(st: PortalState, v: MockPortalVersion): PortalVersion {
  const site = siteById(st, v.siteId);
  const docs = st.docs.filter((d) => d.siteId === v.siteId && d.version === v.name && live(d));
  const docCounts = Object.fromEntries(
    site.locales.map((l) => [
      l,
      docs.filter((d) => d.locale === l && d.kind === 'doc' && !d.deletedAt).length,
    ]),
  );
  return {
    id: v.id,
    name: v.name,
    label: v.label,
    status: v.status,
    showInPicker: v.showInPicker,
    docCounts,
    pendingCount: docs.filter((d) => docStatus(d) !== 'published').length,
    frozenAt: v.frozenAt,
    createdAt: v.createdAt,
  };
}

function toDoc(s: MockState, st: PortalState, d: MockPortalDoc): PortalDoc {
  const site = siteById(st, d.siteId);
  const version = versionOf(st, site.id, d.version);
  const src = sourceOf(st, site, d);
  const path: { groupId: string; title: string }[] = [];
  let parent = d.parentGroupId;
  for (let i = 0; parent && i < 20; i++) {
    const inGroup = st.docs.filter((x) => x.groupId === parent && live(x));
    const cat = inGroup.find((x) => x.locale === d.locale) ?? inGroup[0];
    if (!cat) break;
    path.unshift({ groupId: cat.groupId, title: cat.title });
    parent = cat.parentGroupId;
  }
  return {
    id: d.id,
    siteId: d.siteId,
    groupId: d.groupId,
    kind: d.kind,
    version: d.version,
    versionStatus: version.status,
    locale: d.locale,
    nodeId: d.nodeId,
    parentGroupId: d.parentGroupId,
    title: d.title,
    slug: d.slug,
    description: d.description,
    sidebarLabel: d.sidebarLabel,
    position: d.position,
    unlisted: d.unlisted,
    categoryLink: d.categoryLink,
    categorySlug: d.categorySlug,
    frontMatter: d.frontMatter,
    seo: d.seo,
    content: d.content,
    rev: d.rev,
    status: docStatus(d),
    published: d.published
      ? {
          rev: d.published.rev,
          slug: d.published.slug,
          at: d.published.at,
          by: userSummary(s, d.published.byId),
        }
      : null,
    translation: translationState(st, site, d),
    source: src && src.id !== d.id ? { id: src.id, rev: src.rev, updatedAt: src.updatedAt } : null,
    translations: site.locales.map((locale) => {
      const t = st.docs.find((x) => x.groupId === d.groupId && x.locale === locale && live(x));
      return {
        locale,
        docId: t?.id ?? null,
        state: t ? translationState(st, site, t) : 'missing',
        status: t ? docStatus(t) : null,
      };
    }),
    path,
    wordCount: wordsOf(d.content),
    updatedAt: d.updatedAt,
    updatedBy: userSummary(s, d.updatedById),
    sourceNodeId: d.sourceNodeId ?? null,
  };
}

function toPostSummary(s: MockState, st: PortalState, p: MockPortalPost): PortalPostSummary {
  const site = siteById(st, p.siteId);
  return {
    id: p.id,
    groupId: p.groupId,
    locale: p.locale,
    slug: p.slug,
    title: p.title,
    status: postStatus(p),
    authors: p.authorIds.flatMap((id) => {
      const a = st.authors.find((x) => x.id === id);
      return a ? [toAuthor(s, a)] : [];
    }),
    tags: p.tags,
    date: p.date,
    scheduledAt: p.scheduledAt,
    readingMinutes: Math.max(1, Math.ceil(wordsOf(p.content) / 200)),
    translations: site.locales.map((locale) => {
      const t = st.posts.find((x) => x.groupId === p.groupId && x.locale === locale && live(x));
      return { locale, postId: t?.id ?? null, status: t ? postStatus(t) : null };
    }),
    updatedAt: p.updatedAt,
  };
}

function toPost(s: MockState, st: PortalState, p: MockPortalPost): PortalPost {
  return {
    ...toPostSummary(s, st, p),
    siteId: p.siteId,
    nodeId: p.nodeId,
    description: p.description,
    cover: p.cover,
    frontMatter: p.frontMatter,
    seo: p.seo,
    content: p.content,
    rev: p.rev,
    wordCount: wordsOf(p.content),
    codeBlockCount: codeBlocksOf(p.content),
    published: p.published
      ? {
          rev: p.published.rev,
          slug: p.published.slug,
          at: p.published.at,
          by: userSummary(s, p.published.byId),
        }
      : null,
    updatedBy: userSummary(s, p.updatedById),
  };
}

function toAuthor(s: MockState, a: PortalState['authors'][number]) {
  return {
    id: a.id,
    key: a.key,
    name: a.name,
    title: a.title,
    url: a.url,
    imageUrl: a.imageUrl,
    user: userSummary(s, a.userId),
  };
}

function mediaUrl(siteId: string, path: string) {
  return `/api/v1/portal/sites/${siteId}/files${path.replace(/^\/media/, '')}`;
}

function toMedia(s: MockState, m: PortalState['media'][number]): PortalMedia {
  return {
    id: m.id,
    path: m.path,
    fileName: m.fileName,
    mime: m.mime,
    size: m.size,
    width: m.width,
    height: m.height,
    alt: m.alt,
    url: mediaUrl(m.siteId, m.path),
    status: m.status,
    usage: m.usage,
    createdAt: m.createdAt,
    createdBy: userSummary(s, m.createdById),
  };
}

function toPublishSummary(s: MockState, p: MockPortalPublish): PortalPublishSummary {
  return {
    id: p.id,
    number: p.number,
    note: p.note,
    actor: userSummary(s, p.actorId),
    status: p.status,
    itemCount: p.items.length,
    titles: p.titles,
    pathCount: p.pathCount,
    durationMs: p.durationMs,
    revertOf: p.revertOf,
    revertedBy: p.revertedBy,
    createdAt: p.createdAt,
  };
}

function toPublish(s: MockState, p: MockPortalPublish): PortalPublish {
  return { ...toPublishSummary(s, p), items: p.items, jobs: p.jobs };
}

// ---- changes queue ----

function changesOf(s: MockState, st: PortalState, site: MockPortalSite): PortalChange[] {
  const out: PortalChange[] = [];
  for (const d of st.docs) {
    if (d.siteId !== site.id || !live(d)) continue;
    const status = docStatus(d);
    if (status === 'published') continue;
    out.push({
      key: `doc:${d.id}`,
      kind: 'doc',
      id: d.id,
      title: d.title,
      version: d.version,
      locale: d.locale,
      action: status === 'draft' ? 'create' : status === 'removed' ? 'remove' : 'update',
      scheduledAt: null,
      changedAt: d.updatedAt,
      changedBy: userSummary(s, d.updatedById),
    });
  }
  for (const p of st.posts) {
    if (p.siteId !== site.id || !live(p) || !postPending(p)) continue;
    out.push({
      key: `post:${p.id}`,
      kind: 'post',
      id: p.id,
      title: p.title,
      version: null,
      locale: p.locale,
      action: p.deletedAt
        ? 'remove'
        : isFuture(p.scheduledAt)
          ? 'schedule'
          : p.published
            ? 'update'
            : 'create',
      scheduledAt: isFuture(p.scheduledAt) ? p.scheduledAt : null,
      changedAt: p.updatedAt,
      changedBy: userSummary(s, p.updatedById),
    });
  }
  const home = st.homes.find((h) => h.siteId === site.id);
  if (home && JSON.stringify(home.draft) !== JSON.stringify(home.published)) {
    out.push({
      key: `home:${site.id}`,
      kind: 'home',
      id: null,
      title: 'Home',
      version: null,
      locale: null,
      action: home.published ? 'update' : 'create',
      scheduledAt: null,
      changedAt: home.updatedAt ?? site.createdAt,
      changedBy: userSummary(s, home.updatedById),
    });
  }
  const nav = st.navigations.find((h) => h.siteId === site.id);
  if (nav && JSON.stringify(nav.draft) !== JSON.stringify(nav.published)) {
    out.push({
      key: `navigation:${site.id}`,
      kind: 'navigation',
      id: null,
      title: 'Navigation',
      version: null,
      locale: null,
      action: nav.published ? 'update' : 'create',
      scheduledAt: null,
      changedAt: nav.updatedAt ?? site.createdAt,
      changedBy: userSummary(s, nav.updatedById),
    });
  }
  return out.sort((a, b) => b.changedAt.localeCompare(a.changedAt));
}

/** Immediate paths and scheduled ones (doc 17 §9: page, category index, locale twin, sitemap). */
function pathsFor(st: PortalState, site: MockPortalSite, changes: PortalChange[]) {
  const immediate = new Set<string>();
  const scheduled = new Map<string, Set<string>>();
  for (const c of changes) {
    if (c.kind === 'doc') {
      const d = st.docs.find((x) => x.id === c.id);
      if (!d) continue;
      immediate.add(docPath(site, d));
      const parent = st.docs.find(
        (x) =>
          x.groupId === d.parentGroupId &&
          x.locale === d.locale &&
          x.categoryLink === 'generated-index',
      );
      if (parent) immediate.add(docPath(site, parent));
      immediate.add('/sitemap.xml');
      immediate.add('/search-index.json');
    } else if (c.kind === 'post') {
      const p = st.posts.find((x) => x.id === c.id);
      if (!p) continue;
      const pre = localePrefix(site, p.locale);
      const paths = [
        `${pre}/blog`,
        `${pre}/blog/${p.slug}`,
        ...p.tags.map((t) => `${pre}/blog/tags/${t}`),
        `${pre}/blog/rss.xml`,
      ];
      if (c.scheduledAt) {
        const set = scheduled.get(c.scheduledAt) ?? new Set<string>();
        paths.forEach((x) => set.add(x));
        scheduled.set(c.scheduledAt, set);
      } else paths.forEach((x) => immediate.add(x));
    } else if (c.kind === 'home') {
      for (const l of site.locales) immediate.add(localePrefix(site, l) || '/');
    } else {
      for (const l of site.locales) immediate.add(localePrefix(site, l) || '/');
      immediate.add('/blog');
      immediate.add('/sitemap.xml');
    }
  }
  return {
    paths: [...immediate],
    scheduled: [...scheduled.entries()].map(([at, set]) => ({ at, paths: [...set] })),
  };
}

function selectChanges(s: MockState, st: PortalState, site: MockPortalSite, keys?: string[]) {
  const all = changesOf(s, st, site);
  return keys && keys.length ? all.filter((c) => keys.includes(c.key)) : all;
}

function job(paths: string[], runAt: string, status: PortalPublishJob['status']): PortalPublishJob {
  return {
    id: newId(),
    status,
    runAt,
    attempts: status === 'queued' ? 0 : 1,
    paths,
    tags: [],
    httpStatus: null,
    error: null,
    startedAt: status === 'running' ? runAt : null,
    finishedAt: null,
    durationMs: null,
  };
}

function nextNumber(st: PortalState, siteId: string) {
  return Math.max(0, ...st.publishes.filter((p) => p.siteId === siteId).map((p) => p.number)) + 1;
}

/** Fresh publishes finish on their first read, so a poll sees the result. */
function advance(p: MockPortalPublish) {
  p.reads++;
  if (p.status !== 'running' && p.status !== 'queued') return;
  const t = now();
  let total = 0;
  for (const j of p.jobs) {
    if (j.status !== 'running') continue;
    const ms = 1800 + Math.round(Math.random() * 1400);
    Object.assign(j, { status: 'done', httpStatus: 200, finishedAt: t, durationMs: ms });
    total = Math.max(total, ms);
  }
  p.status = 'done';
  p.durationMs = total;
}

// ---- version helpers ----

function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => Number(x) || 0);
  const pb = b.split(/[.-]/).map((x) => Number(x) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

const emptyDoc = (): PortalRichDoc => ({ type: 'doc', content: [{ type: 'paragraph' }] });

function defaultNavigation(name: string): PortalNavigation {
  return {
    navbar: {
      title: { en: name },
      logo: { src: null, srcDark: null, alt: name },
      items: [
        { id: 'docs', kind: 'docs', position: 'left', label: { en: 'Docs' }, hidden: false },
        {
          id: 'blog',
          kind: 'blog',
          position: 'left',
          label: { en: 'Blog' },
          href: '/blog',
          hidden: false,
        },
        {
          id: 'locale',
          kind: 'localeDropdown',
          position: 'right',
          label: { en: 'Language' },
          hidden: false,
        },
        {
          id: 'version',
          kind: 'versionDropdown',
          position: 'right',
          label: { en: 'Version' },
          hidden: false,
        },
      ],
    },
    footer: { style: 'dark', columns: [], copyright: { en: `Copyright © {year} ${name}` } },
  };
}

function bump(d: { rev: number; updatedAt: string; updatedById: string | null }, u: MockUser) {
  d.rev++;
  d.updatedAt = now();
  d.updatedById = u.id;
}

// ---- raw routes (media bytes) ----

const BYTES = new Map<string, { type: string; data: ArrayBuffer }>();

function placeholderSvg(name: string): string {
  const hue = [...name].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
  const label = name.replace(/[<&>]/g, '');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400"><rect width="640" height="400" fill="hsl(${hue} 45% 52%)"/><path d="M0 320 L180 180 L300 280 L420 160 L640 340 L640 400 L0 400Z" fill="rgba(255,255,255,.22)"/><text x="320" y="210" font-family="sans-serif" font-size="26" fill="#fff" text-anchor="middle">${label}</text></svg>`;
}

export const portalRawHandlers: HttpHandler[] = [
  http.put('*/api/v1/portal/media/:mediaId/content', async ({ request, params }) => {
    const s = db();
    try {
      need(s, 'edit');
    } catch {
      return HttpResponse.json({ code: 'unauthenticated', message: 'No session' }, { status: 401 });
    }
    const m = portalState(s).media.find((x) => x.id === params.mediaId);
    if (!m) return HttpResponse.json({ code: 'not_found', message: 'not_found' }, { status: 404 });
    const data = await request.arrayBuffer();
    BYTES.set(m.id, {
      type: request.headers.get('content-type') ?? m.mime ?? 'application/octet-stream',
      data,
    });
    m.size = data.byteLength;
    m.status = 'ready';
    return new HttpResponse(null, { status: 204 });
  }),
  http.get('*/api/v1/portal/sites/:siteId/files/*', ({ request, params }) => {
    const st = portalState();
    const rest = decodeURIComponent(new URL(request.url).pathname.split('/files/')[1] ?? '');
    const m = st.media.find((x) => x.siteId === params.siteId && x.path === `/media/${rest}`);
    if (!m) return new HttpResponse(null, { status: 404 });
    const stored = BYTES.get(m.id);
    if (stored) return new HttpResponse(stored.data, { headers: { 'Content-Type': stored.type } });
    if (!m.mime?.startsWith('image/')) {
      return new HttpResponse('%PDF-1.4', {
        headers: { 'Content-Type': m.mime ?? 'application/octet-stream' },
      });
    }
    return new HttpResponse(placeholderSvg(m.fileName), {
      headers: { 'Content-Type': 'image/svg+xml' },
    });
  }),
];

// ---- resolvers ----

const publicOnly = () => {
  throw new MockApiError('portal_token_invalid');
};

type PortalName =
  | 'listPortalSites'
  | 'createPortalSite'
  | 'getPortalSite'
  | 'updatePortalSite'
  | 'rotatePortalToken'
  | 'testPortalRevalidate'
  | 'getPortalOverview'
  | 'listPortalVersions'
  | 'freezePortalVersion'
  | 'updatePortalVersion'
  | 'diffPortalVersions'
  | 'getPortalDocTree'
  | 'createPortalDoc'
  | 'createPortalDocFromPage'
  | 'getPortalDoc'
  | 'updatePortalDoc'
  | 'deletePortalDoc'
  | 'restorePortalDoc'
  | 'getPortalDocMarkdown'
  | 'markPortalTranslationCurrent'
  | 'applyPortalDocToNext'
  | 'listPortalPosts'
  | 'createPortalPost'
  | 'getPortalPost'
  | 'updatePortalPost'
  | 'deletePortalPost'
  | 'listPortalAuthors'
  | 'createPortalAuthor'
  | 'updatePortalAuthor'
  | 'getPortalHome'
  | 'updatePortalHome'
  | 'getPortalNavigation'
  | 'updatePortalNavigation'
  | 'listPortalMedia'
  | 'createPortalMedia'
  | 'updatePortalMedia'
  | 'deletePortalMedia'
  | 'listPortalRedirects'
  | 'createPortalRedirect'
  | 'deletePortalRedirect'
  | 'listPortalChanges'
  | 'previewPortalPublish'
  | 'publishPortal'
  | 'listPortalPublishes'
  | 'getPortalPublish'
  | 'revertPortalPublish'
  | 'retryPortalPublishJob'
  | 'createPortalPreview'
  | 'listPortalImports'
  | 'portalPublicSite'
  | 'portalPublicSidebar'
  | 'portalPublicPage'
  | 'portalPublicPaths'
  | 'portalPublicPosts'
  | 'portalPublicPost'
  | 'portalPublicTags'
  | 'portalPublicAuthors'
  | 'portalPublicRedirect'
  | 'portalPublicSearch';

export const portalResolvers: Resolvers<PortalName> = {
  // ---- sites ----
  listPortalSites: ({ s }) => {
    const u = need(s, 'read');
    const st = portalState(s);
    return {
      items: st.sites.map((site) => toSummary(s, st, site)),
      capabilities: capabilitiesOf(s, u),
    };
  },

  createPortalSite: ({ s, body }) => {
    const u = need(s, 'manage');
    const st = portalState(s);
    if (st.sites.some((x) => x.slug === body.slug)) {
      throw new MockApiError('portal_site_slug_taken');
    }
    if (!body.locales.includes(body.defaultLocale)) {
      throw new MockApiError('portal_locale_unsupported');
    }
    const t = now();
    const site: MockPortalSite = {
      id: newId(),
      slug: body.slug,
      name: body.name,
      domain: body.domain ?? null,
      status: 'setup',
      locales: body.locales,
      defaultLocale: body.defaultLocale,
      settings: {
        title: body.name,
        tagline: null,
        url: body.domain ? `https://${body.domain}` : null,
        revalidateUrl: null,
        previewUrl: null,
        timezone: 'Europe/Istanbul',
        titleTemplate: '{page} | {site}',
        logo: { src: null, srcDark: null, alt: body.name },
        favicon: null,
        socialImage: null,
        nextPublic: false,
        showUntranslatedNotice: true,
        prism: { light: 'github', dark: 'dracula' },
      },
      contentSpaceId: newId(),
      tokenHint: null,
      lastRevalidateTest: null,
      createdAt: t,
      updatedAt: t,
    };
    st.sites.push(site);
    for (const [name, status] of [
      ['next', 'next'],
      [body.initialVersion, 'current'],
    ] as const) {
      st.versions.push({
        id: newId(),
        siteId: site.id,
        name,
        label: name,
        status,
        showInPicker: status !== 'next',
        frozenAt: status === 'next' ? null : t,
        createdAt: t,
      });
    }
    st.homes.push({
      siteId: site.id,
      draft: { sections: [] },
      published: null,
      updatedAt: null,
      updatedById: null,
    });
    st.navigations.push({
      siteId: site.id,
      draft: defaultNavigation(body.name),
      published: null,
      updatedAt: t,
      updatedById: u.id,
    });
    return toSite(s, st, site, u);
  },

  getPortalSite: ({ s, params }) => {
    const u = need(s, 'read');
    const st = portalState(s);
    return toSite(s, st, siteById(st, params.siteId), u);
  },

  updatePortalSite: ({ s, params, body }) => {
    const u = need(s, 'manage');
    const st = portalState(s);
    const site = siteById(st, params.siteId);
    const locales = body.locales ?? site.locales;
    const def = body.defaultLocale ?? site.defaultLocale;
    if (!locales.includes(def)) throw new MockApiError('portal_locale_unsupported');
    if (body.name !== undefined) site.name = body.name;
    if (body.domain !== undefined) site.domain = body.domain;
    site.locales = locales;
    site.defaultLocale = def;
    if (body.settings) site.settings = { ...site.settings, ...body.settings };
    site.updatedAt = now();
    return toSite(s, st, site, u);
  },

  rotatePortalToken: ({ s, params }) => {
    need(s, 'manage');
    const site = siteById(portalState(s), params.siteId);
    const token = `phc_${randomToken(24)}`;
    site.tokenHint = token.slice(-4);
    return { token, tokenHint: site.tokenHint };
  },

  testPortalRevalidate: ({ s, params }) => {
    need(s, 'manage');
    const site = siteById(portalState(s), params.siteId);
    if (!site.settings.revalidateUrl) {
      return { ok: false, status: null, ms: 0, error: 'No revalidate URL' };
    }
    site.lastRevalidateTest = now();
    return { ok: true, status: 200, ms: 30 + Math.round(Math.random() * 30), error: null };
  },

  getPortalOverview: ({ s, params }) => {
    need(s, 'read');
    const st = portalState(s);
    const site = siteById(st, params.siteId);
    const changes = changesOf(s, st, site);
    const current = st.versions.find((v) => v.siteId === site.id && v.status === 'current');
    const siteDocs = st.docs.filter((d) => d.siteId === site.id && live(d));
    const sitePosts = st.posts.filter((p) => p.siteId === site.id && live(p));
    const curDocs = siteDocs.filter((d) => d.version === current?.name && !d.deletedAt);
    const sources = curDocs.filter((d) => d.locale === site.defaultLocale);
    const descendants = (groupId: string): MockPortalDoc[] => {
      const kids = sources.filter((d) => d.parentGroupId === groupId);
      return kids.flatMap((k) => [k, ...descendants(k.groupId)]);
    };
    const count = (docs: MockPortalDoc[], locale: string) => {
      const list = docs.filter((d) => d.kind === 'doc');
      let translated = 0;
      let outdated = 0;
      for (const d of list) {
        const tr = curDocs.find((x) => x.groupId === d.groupId && x.locale === locale);
        if (!tr) continue;
        translated++;
        if (translationState(st, site, tr) === 'outdated') outdated++;
      }
      return { translated, total: list.length, outdated };
    };
    const publishes = st.publishes
      .filter((p) => p.siteId === site.id)
      .sort((a, b) => b.number - a.number);
    const last = publishes[0];
    const drafts = [
      ...siteDocs
        .filter((d) => d.kind === 'doc' && (docStatus(d) === 'draft' || docStatus(d) === 'changed'))
        .map((d) => ({
          kind: 'doc' as const,
          id: d.id,
          title: d.title,
          version: d.version,
          locale: d.locale,
          updatedAt: d.updatedAt,
          updatedBy: userSummary(s, d.updatedById),
        })),
      ...sitePosts
        .filter((p) => postStatus(p) === 'draft' || postStatus(p) === 'changed')
        .map((p) => ({
          kind: 'post' as const,
          id: p.id,
          title: p.title,
          version: null,
          locale: p.locale,
          updatedAt: p.updatedAt,
          updatedBy: userSummary(s, p.updatedById),
        })),
    ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return {
      publishedUrlCount: publishedUrlCount(st, site),
      publishedDocCount: siteDocs.filter(
        (d) => d.kind === 'doc' && d.published && d.version === current?.name,
      ).length,
      publishedPostCount: sitePosts.filter((p) => p.published && p.locale === site.defaultLocale)
        .length,
      pending: {
        count: changes.length,
        people: new Set(changes.map((c) => c.changedBy?.id).filter(Boolean)).size,
        oldestAt: changes.length ? changes[changes.length - 1]!.changedAt : null,
      },
      drafts: {
        docs: siteDocs.filter((d) => d.kind === 'doc' && docStatus(d) === 'draft').length,
        posts: sitePosts.filter((p) => postStatus(p) === 'draft').length,
      },
      translations: site.locales
        .filter((l) => l !== site.defaultLocale)
        .map((locale) => ({
          locale,
          ...count(sources, locale),
          sections: sources
            .filter((d) => d.parentGroupId === null)
            .sort((a, b) => a.position - b.position)
            .map((root) => ({
              groupId: root.groupId,
              title: root.title,
              ...count([root, ...descendants(root.groupId)], locale),
            })),
        })),
      recentDrafts: drafts.slice(0, 5),
      lastPublish: last ? toPublishSummary(s, last) : null,
      lastJob: last?.jobs[last.jobs.length - 1] ?? null,
      recentPublishes: publishes.slice(0, 4).map((p) => toPublishSummary(s, p)),
    };
  },

  // ---- versions ----
  listPortalVersions: ({ s, params }) => {
    need(s, 'read');
    const st = portalState(s);
    siteById(st, params.siteId);
    const rank = { next: 0, current: 1, archived: 2 } as const;
    return {
      items: st.versions
        .filter((v) => v.siteId === params.siteId)
        .sort((a, b) => rank[a.status] - rank[b.status] || compareVersions(b.name, a.name))
        .map((v) => toVersion(st, v)),
    };
  },

  freezePortalVersion: ({ s, params, body }) => {
    const u = need(s, 'publish');
    const st = portalState(s);
    const site = siteById(st, params.siteId);
    const versions = st.versions.filter((v) => v.siteId === site.id);
    if (versions.some((v) => v.name === body.name)) throw new MockApiError('portal_version_exists');
    if (versions.some((v) => v.name !== 'next' && compareVersions(v.name, body.name) >= 0)) {
      throw new MockApiError('portal_version_invalid');
    }
    const t = now();
    const v: MockPortalVersion = {
      id: newId(),
      siteId: site.id,
      name: body.name,
      label: body.label || body.name,
      status: body.makeCurrent ? 'current' : 'archived',
      showInPicker: true,
      frozenAt: t,
      createdAt: t,
    };
    if (body.makeCurrent) {
      for (const old of versions) if (old.status === 'current') old.status = 'archived';
    }
    st.versions.push(v);
    const groups = new Map<string, string>();
    const gid = (g: string) => {
      let n = groups.get(g);
      if (!n) {
        n = newId();
        groups.set(g, n);
      }
      return n;
    };
    const source = st.docs.filter(
      (d) =>
        d.siteId === site.id &&
        d.version === 'next' &&
        !d.deletedAt &&
        (body.includeTranslations || d.locale === site.defaultLocale),
    );
    for (const d of source) {
      st.docs.push({
        ...structuredClone(d),
        id: newId(),
        nodeId: newId(),
        groupId: gid(d.groupId),
        parentGroupId: d.parentGroupId ? gid(d.parentGroupId) : null,
        version: v.name,
        rev: 1,
        published: null,
        createdAt: t,
        updatedAt: t,
        updatedById: u.id,
        sourceRevMarked: d.sourceRevMarked === null ? null : 1,
      });
    }
    return toVersion(st, v);
  },

  updatePortalVersion: ({ s, params, body }) => {
    need(s, 'publish');
    const st = portalState(s);
    const v = st.versions.find((x) => x.id === params.versionId);
    if (!v) throw new MockApiError('not_found');
    if (body.label !== undefined) v.label = body.label;
    if (body.showInPicker !== undefined) v.showInPicker = body.showInPicker;
    if (body.makeCurrent) {
      if (v.status === 'next') throw new MockApiError('portal_version_invalid');
      for (const o of st.versions) {
        if (o.siteId === v.siteId && o.status === 'current') o.status = 'archived';
      }
      v.status = 'current';
    }
    return toVersion(st, v);
  },

  diffPortalVersions: ({ s, params, query }) => {
    need(s, 'read');
    const st = portalState(s);
    const site = siteById(st, params.siteId);
    const locale = query.locale ?? site.defaultLocale;
    const docsOf = (version: string) =>
      new Map(
        st.docs
          .filter(
            (d) =>
              d.siteId === site.id &&
              d.version === version &&
              d.locale === locale &&
              !d.deletedAt &&
              d.kind === 'doc',
          )
          .map((d) => [d.slug, d]),
      );
    const from = docsOf(query.from);
    const to = docsOf(query.to);
    const ref = (d: MockPortalDoc) => ({ slug: d.slug, title: d.title });
    return {
      added: [...from.values()].filter((d) => !to.has(d.slug)).map(ref),
      changed: [...from.values()]
        .filter((d) => {
          const o = to.get(d.slug);
          return (
            o && (o.title !== d.title || JSON.stringify(o.content) !== JSON.stringify(d.content))
          );
        })
        .map(ref),
      removed: [...to.values()].filter((d) => !from.has(d.slug)).map(ref),
    };
  },

  // ---- docs ----
  getPortalDocTree: ({ s, params, query }) => {
    need(s, 'read');
    const st = portalState(s);
    const site = siteById(st, params.siteId);
    versionOf(st, site.id, query.version);
    const sources = st.docs.filter(
      (d) =>
        d.siteId === site.id &&
        d.version === query.version &&
        d.locale === site.defaultLocale &&
        live(d),
    );
    const items: PortalTreeItem[] = sources
      .sort((a, b) => a.position - b.position)
      .map((src) => {
        const local =
          query.locale === site.defaultLocale
            ? src
            : st.docs.find(
                (x) => x.groupId === src.groupId && x.locale === query.locale && live(x),
              );
        return {
          id: local?.id ?? null,
          groupId: src.groupId,
          sourceId: src.id,
          kind: src.kind,
          parentGroupId: src.parentGroupId,
          title: local?.title ?? src.title,
          sidebarLabel: local?.sidebarLabel ?? src.sidebarLabel,
          slug: src.slug,
          position: src.position,
          status: local ? docStatus(local) : null,
          translation: local ? translationState(st, site, local) : 'missing',
          unlisted: src.unlisted,
          updatedAt: local?.updatedAt ?? src.updatedAt,
        };
      });
    return { items };
  },

  createPortalDoc: ({ s, params, body }) => {
    const u = need(s, 'edit');
    const st = portalState(s);
    const site = siteById(st, params.siteId);
    versionOf(st, site.id, body.version);
    if (!site.locales.includes(body.locale)) throw new MockApiError('portal_locale_unsupported');
    const t = now();
    let doc: MockPortalDoc;
    if (body.translationOf) {
      const src = st.docs.find((x) => x.id === body.translationOf && !x.deletedAt);
      if (!src) throw new MockApiError('portal_translation_source_missing');
      if (st.docs.some((x) => x.groupId === src.groupId && x.locale === body.locale && live(x))) {
        throw new MockApiError('conflict');
      }
      doc = {
        ...structuredClone(src),
        id: newId(),
        nodeId: newId(),
        locale: body.locale,
        title: body.title,
        description: body.copySource ? src.description : null,
        sidebarLabel: null,
        content: body.copySource
          ? structuredClone(src.content)
          : body.markdown
            ? md(body.markdown)
            : emptyDoc(),
        seo: {},
        rev: 1,
        published: null,
        sourceRevMarked: src.rev,
        deletedAt: null,
        createdAt: t,
        updatedAt: t,
        updatedById: u.id,
      };
    } else {
      const parent = body.parentGroupId
        ? st.docs.find((x) => x.groupId === body.parentGroupId && x.locale === site.defaultLocale)
        : undefined;
      if (body.parentGroupId && !parent) throw new MockApiError('not_found');
      const slug =
        body.slug ?? (parent ? `${parent.slug}/${slugify(body.title)}` : slugify(body.title));
      if (
        st.docs.some(
          (x) => x.siteId === site.id && x.version === body.version && x.slug === slug && live(x),
        )
      ) {
        throw new MockApiError('portal_slug_taken');
      }
      const siblings = st.docs.filter(
        (x) =>
          x.siteId === site.id &&
          x.version === body.version &&
          x.parentGroupId === (body.parentGroupId ?? null),
      );
      const kind = body.kind;
      doc = {
        id: newId(),
        siteId: site.id,
        groupId: newId(),
        kind,
        version: body.version,
        locale: body.locale,
        nodeId: newId(),
        parentGroupId: body.parentGroupId ?? null,
        title: body.title,
        slug,
        description: null,
        sidebarLabel: null,
        position: body.position ?? Math.max(0, ...siblings.map((x) => x.position)) + 10,
        unlisted: false,
        categoryLink: kind === 'category' ? 'generated-index' : 'none',
        categorySlug: kind === 'category' ? `category/${slug.split('/').pop()}` : null,
        frontMatter: {},
        seo: {},
        content: body.markdown ? md(body.markdown) : emptyDoc(),
        rev: 1,
        published: null,
        sourceRevMarked: null,
        deletedAt: null,
        createdAt: t,
        updatedAt: t,
        updatedById: u.id,
      };
    }
    st.docs.push(doc);
    return toDoc(s, st, doc);
  },

  getPortalDoc: ({ s, params }) => {
    need(s, 'read');
    const st = portalState(s);
    return toDoc(s, st, docById(st, params.docId));
  },

  updatePortalDoc: ({ s, params, body }) => {
    const u = need(s, 'edit');
    const st = portalState(s);
    const d = docById(st, params.docId);
    const site = siteById(st, d.siteId);
    if (body.baseRev !== undefined && body.baseRev !== d.rev) {
      throw new MockApiError('portal_doc_conflict', 'Changed by someone else', { rev: d.rev });
    }
    const group = st.docs.filter(
      (x) => x.groupId === d.groupId && x.version === d.version && live(x),
    );
    const renameTree = (from: string, to: string) => {
      if (from === to) return;
      if (
        st.docs.some(
          (x) =>
            x.siteId === d.siteId &&
            x.version === d.version &&
            x.slug === to &&
            x.groupId !== d.groupId &&
            live(x),
        )
      ) {
        throw new MockApiError('portal_slug_taken');
      }
      for (const x of st.docs) {
        if (x.siteId !== d.siteId || x.version !== d.version) continue;
        if (x.slug === from || x.slug.startsWith(`${from}/`)) {
          const old = docPath(site, x);
          x.slug = to + x.slug.slice(from.length);
          if (x.published && x.kind === 'doc') {
            st.redirects.push({
              id: newId(),
              siteId: site.id,
              fromPath: old,
              toPath: docPath(site, x),
              code: 301,
              auto: true,
              createdAt: now(),
            });
          }
        }
      }
    };
    if (body.slug !== undefined) renameTree(d.slug, body.slug);
    if (body.parentGroupId !== undefined && body.parentGroupId !== d.parentGroupId) {
      const parent = body.parentGroupId
        ? st.docs.find((x) => x.groupId === body.parentGroupId && x.locale === site.defaultLocale)
        : undefined;
      if (body.parentGroupId && (!parent || parent.kind !== 'category')) {
        throw new MockApiError('not_found');
      }
      const last = d.slug.split('/').pop() ?? d.slug;
      renameTree(d.slug, parent ? `${parent.slug}/${last}` : last);
      for (const x of group) x.parentGroupId = body.parentGroupId;
    }
    // Structure is shared by every language of the group.
    for (const x of group) {
      if (body.position !== undefined) x.position = body.position;
      if (body.unlisted !== undefined) x.unlisted = body.unlisted;
      if (body.categoryLink !== undefined) x.categoryLink = body.categoryLink;
      if (body.position !== undefined || body.parentGroupId !== undefined) {
        if (x !== d) bump(x, u);
      }
    }
    if (body.title !== undefined) d.title = body.title;
    if (body.description !== undefined) d.description = body.description;
    if (body.sidebarLabel !== undefined) d.sidebarLabel = body.sidebarLabel;
    if (body.frontMatter !== undefined) d.frontMatter = body.frontMatter;
    if (body.seo !== undefined) d.seo = body.seo;
    if (body.content !== undefined) d.content = body.content;
    if (body.markdown !== undefined) d.content = md(body.markdown);
    bump(d, u);
    return toDoc(s, st, d);
  },

  createPortalDocFromPage: async (ctx) => {
    const { s, params, body } = ctx;
    need(s, 'edit');
    const st = portalState(s);
    const site = siteById(st, params.siteId);
    versionOf(st, site.id, body.version);
    if (!site.locales.includes(body.locale)) throw new MockApiError('portal_locale_unsupported');
    const page = mockPageSource(s, body.nodeId);
    const linked = st.docs.filter(
      (x) =>
        x.siteId === site.id &&
        x.version === body.version &&
        x.sourceNodeId === body.nodeId &&
        live(x),
    );
    const images = { copied: 0, skipped: 0 };
    const mine = linked.find((x) => x.locale === body.locale);
    if (mine) {
      const doc = await portalResolvers.updatePortalDoc({
        ...ctx,
        params: { docId: mine.id },
        body: { title: page.name, markdown: page.markdown },
        query: undefined,
      });
      return { doc, created: false, images };
    }
    const source =
      linked.find((x) => x.locale === site.defaultLocale) ??
      linked.find((x) => x.locale !== body.locale);
    const doc = await portalResolvers.createPortalDoc({
      ...ctx,
      body: {
        kind: 'doc',
        version: body.version,
        locale: body.locale,
        title: page.name,
        markdown: page.markdown,
        ...(source
          ? { translationOf: source.id }
          : { parentGroupId: body.parentGroupId ?? null, slug: body.slug }),
      },
      query: undefined,
    });
    const row = docById(st, doc.id);
    row.sourceNodeId = body.nodeId;
    return { doc: toDoc(s, st, row), created: true, images };
  },

  deletePortalDoc: ({ s, params }) => {
    const u = need(s, 'edit');
    const st = portalState(s);
    const d = docById(st, params.docId);
    const site = siteById(st, d.siteId);
    const isSource = d.locale === site.defaultLocale;
    if (
      d.kind === 'category' &&
      st.docs.some((x) => x.parentGroupId === d.groupId && x.version === d.version && !x.deletedAt)
    ) {
      throw new MockApiError('portal_category_not_empty');
    }
    const targets = isSource ? st.docs.filter((x) => x.groupId === d.groupId && live(x)) : [d];
    const t = now();
    for (const x of targets) {
      x.deletedAt = t;
      x.updatedAt = t;
      x.updatedById = u.id;
    }
    st.docs = st.docs.filter((x) => live(x));
    return {};
  },

  restorePortalDoc: ({ s, params }) => {
    const u = need(s, 'edit');
    const st = portalState(s);
    const d = docById(st, params.docId);
    const site = siteById(st, d.siteId);
    const targets =
      d.locale === site.defaultLocale ? st.docs.filter((x) => x.groupId === d.groupId) : [d];
    for (const x of targets) {
      x.deletedAt = null;
      x.updatedAt = now();
      x.updatedById = u.id;
    }
    return toDoc(s, st, d);
  },

  getPortalDocMarkdown: ({ s, params }) => {
    need(s, 'read');
    const d = docById(portalState(s), params.docId);
    return { markdown: docToMarkdown(d.content) };
  },

  markPortalTranslationCurrent: ({ s, params }) => {
    const u = need(s, 'edit');
    const st = portalState(s);
    const d = docById(st, params.docId);
    const src = sourceOf(st, siteById(st, d.siteId), d);
    if (!src || src.id === d.id) throw new MockApiError('portal_translation_source_missing');
    d.sourceRevMarked = src.rev;
    d.updatedById = u.id;
    return toDoc(s, st, d);
  },

  applyPortalDocToNext: ({ s, params }) => {
    const u = need(s, 'edit');
    const st = portalState(s);
    const d = docById(st, params.docId);
    if (d.version === 'next') throw new MockApiError('bad_request');
    const site = siteById(st, d.siteId);
    const inNext = (slug: string, locale: string) =>
      st.docs.find(
        (x) =>
          x.siteId === d.siteId &&
          x.version === 'next' &&
          x.slug === slug &&
          x.locale === locale &&
          !x.deletedAt,
      );
    let target = inNext(d.slug, d.locale);
    if (target) {
      target.title = d.title;
      target.description = d.description;
      target.content = structuredClone(d.content);
      bump(target, u);
    } else {
      const srcInNext = inNext(d.slug, site.defaultLocale);
      const parentSlug = d.slug.split('/').slice(0, -1).join('/');
      const parent = parentSlug ? inNext(parentSlug, site.defaultLocale) : undefined;
      target = {
        ...structuredClone(d),
        id: newId(),
        nodeId: newId(),
        version: 'next',
        groupId: srcInNext?.groupId ?? newId(),
        parentGroupId: parent?.groupId ?? null,
        rev: 1,
        published: null,
        deletedAt: null,
        updatedAt: now(),
        updatedById: u.id,
      };
      st.docs.push(target);
    }
    return toDoc(s, st, target);
  },

  // ---- blog ----
  listPortalPosts: ({ s, params, query }) => {
    need(s, 'read');
    const st = portalState(s);
    siteById(st, params.siteId);
    const when = (p: MockPortalPost) => p.date ?? p.scheduledAt ?? p.updatedAt;
    const items = st.posts
      .filter((p) => p.siteId === params.siteId && live(p))
      .filter((p) => !query.locale || p.locale === query.locale)
      .filter((p) => {
        const st2 = postStatus(p);
        if (query.status === 'all') return true;
        if (query.status === 'published') return st2 === 'published' || st2 === 'changed';
        return st2 === query.status;
      })
      .sort((a, b) => {
        const rank = (p: MockPortalPost) => (p.published ? 1 : 0);
        return rank(a) - rank(b) || when(b).localeCompare(when(a));
      })
      .map((p) => toPostSummary(s, st, p));
    return { items };
  },

  createPortalPost: ({ s, params, body }) => {
    const u = need(s, 'edit');
    const st = portalState(s);
    const site = siteById(st, params.siteId);
    if (!site.locales.includes(body.locale)) throw new MockApiError('portal_locale_unsupported');
    const src = body.translationOf ? postById(st, body.translationOf) : undefined;
    const slug = src?.slug ?? body.slug ?? slugify(body.title);
    if (
      st.posts.some(
        (p) => p.siteId === site.id && p.locale === body.locale && p.slug === slug && live(p),
      )
    ) {
      throw new MockApiError('portal_slug_taken');
    }
    const mine = st.authors.find((a) => a.siteId === site.id && a.userId === u.id);
    const t = now();
    const post: MockPortalPost = {
      id: newId(),
      siteId: site.id,
      groupId: src?.groupId ?? newId(),
      locale: body.locale,
      nodeId: newId(),
      slug,
      title: body.title,
      description: null,
      cover: src?.cover ?? null,
      authorIds: body.authorIds ?? src?.authorIds ?? (mine ? [mine.id] : []),
      tags: body.tags ?? src?.tags ?? [],
      date: null,
      scheduledAt: null,
      frontMatter: {},
      seo: {},
      content: body.markdown ? md(body.markdown) : src ? structuredClone(src.content) : emptyDoc(),
      rev: 1,
      published: null,
      deletedAt: null,
      createdAt: t,
      updatedAt: t,
      updatedById: u.id,
    };
    st.posts.push(post);
    return toPost(s, st, post);
  },

  getPortalPost: ({ s, params }) => {
    need(s, 'read');
    const st = portalState(s);
    return toPost(s, st, postById(st, params.postId));
  },

  updatePortalPost: ({ s, params, body }) => {
    const u = need(s, 'edit');
    const st = portalState(s);
    const p = postById(st, params.postId);
    if (body.baseRev !== undefined && body.baseRev !== p.rev) {
      throw new MockApiError('portal_doc_conflict', 'Changed by someone else', { rev: p.rev });
    }
    if (body.slug !== undefined && body.slug !== p.slug) {
      if (
        st.posts.some(
          (x) =>
            x.siteId === p.siteId &&
            x.locale === p.locale &&
            x.slug === body.slug &&
            x.id !== p.id &&
            live(x),
        )
      ) {
        throw new MockApiError('portal_slug_taken');
      }
      if (p.published) {
        st.redirects.push({
          id: newId(),
          siteId: p.siteId,
          fromPath: `/blog/${p.slug}`,
          toPath: `/blog/${body.slug}`,
          code: 301,
          auto: true,
          createdAt: now(),
        });
      }
      p.slug = body.slug;
    }
    if (body.title !== undefined) p.title = body.title;
    if (body.description !== undefined) p.description = body.description;
    if (body.authorIds !== undefined) p.authorIds = body.authorIds;
    if (body.tags !== undefined) p.tags = body.tags;
    if (body.date !== undefined) p.date = body.date;
    if (body.scheduledAt !== undefined) p.scheduledAt = body.scheduledAt;
    if (body.cover !== undefined) p.cover = body.cover;
    if (body.frontMatter !== undefined) p.frontMatter = body.frontMatter;
    if (body.seo !== undefined) p.seo = body.seo;
    if (body.content !== undefined) p.content = body.content;
    if (body.markdown !== undefined) p.content = md(body.markdown);
    bump(p, u);
    return toPost(s, st, p);
  },

  deletePortalPost: ({ s, params }) => {
    const u = need(s, 'edit');
    const st = portalState(s);
    const p = postById(st, params.postId);
    p.deletedAt = now();
    p.updatedAt = now();
    p.updatedById = u.id;
    st.posts = st.posts.filter((x) => live(x));
    return {};
  },

  listPortalAuthors: ({ s, params }) => {
    need(s, 'read');
    const st = portalState(s);
    return {
      items: st.authors.filter((a) => a.siteId === params.siteId).map((a) => toAuthor(s, a)),
    };
  },

  createPortalAuthor: ({ s, params, body }) => {
    need(s, 'edit');
    const st = portalState(s);
    const site = siteById(st, params.siteId);
    if (st.authors.some((a) => a.siteId === site.id && a.key === body.key)) {
      throw new MockApiError('conflict');
    }
    const a = {
      id: newId(),
      siteId: site.id,
      key: body.key,
      name: body.name,
      title: body.title ?? null,
      url: body.url ?? null,
      imageUrl: body.imageUrl ?? null,
      userId: body.userId ?? null,
    };
    st.authors.push(a);
    return toAuthor(s, a);
  },

  updatePortalAuthor: ({ s, params, body }) => {
    need(s, 'edit');
    const st = portalState(s);
    const a = st.authors.find((x) => x.id === params.authorId);
    if (!a) throw new MockApiError('not_found');
    Object.assign(a, Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)));
    return toAuthor(s, a);
  },

  // ---- home and navigation ----
  getPortalHome: ({ s, params }) => {
    need(s, 'read');
    const st = portalState(s);
    siteById(st, params.siteId);
    const h = st.homes.find((x) => x.siteId === params.siteId);
    if (!h) throw new MockApiError('not_found');
    return {
      draft: h.draft,
      published: h.published,
      changed: JSON.stringify(h.draft) !== JSON.stringify(h.published),
      updatedAt: h.updatedAt,
      updatedBy: userSummary(s, h.updatedById),
    };
  },

  updatePortalHome: ({ s, params, body }) => {
    const u = need(s, 'edit');
    const st = portalState(s);
    const h = st.homes.find((x) => x.siteId === params.siteId);
    if (!h) throw new MockApiError('not_found');
    h.draft = body;
    h.updatedAt = now();
    h.updatedById = u.id;
    return {
      draft: h.draft,
      published: h.published,
      changed: JSON.stringify(h.draft) !== JSON.stringify(h.published),
      updatedAt: h.updatedAt,
      updatedBy: userSummary(s, h.updatedById),
    };
  },

  getPortalNavigation: ({ s, params }) => {
    need(s, 'read');
    const st = portalState(s);
    siteById(st, params.siteId);
    const n = st.navigations.find((x) => x.siteId === params.siteId);
    if (!n) throw new MockApiError('not_found');
    return {
      draft: n.draft,
      published: n.published,
      changed: JSON.stringify(n.draft) !== JSON.stringify(n.published),
      updatedAt: n.updatedAt,
      updatedBy: userSummary(s, n.updatedById),
    };
  },

  updatePortalNavigation: ({ s, params, body }) => {
    const u = need(s, 'edit');
    const st = portalState(s);
    const n = st.navigations.find((x) => x.siteId === params.siteId);
    if (!n) throw new MockApiError('not_found');
    // System items (language and version pickers) can only be hidden.
    for (const kind of ['localeDropdown', 'versionDropdown'] as const) {
      if (
        n.draft.navbar.items.some((i) => i.kind === kind) &&
        !body.navbar.items.some((i) => i.kind === kind)
      ) {
        throw new MockApiError('bad_request', 'System items cannot be removed');
      }
    }
    n.draft = body;
    n.updatedAt = now();
    n.updatedById = u.id;
    return {
      draft: n.draft,
      published: n.published,
      changed: JSON.stringify(n.draft) !== JSON.stringify(n.published),
      updatedAt: n.updatedAt,
      updatedBy: userSummary(s, n.updatedById),
    };
  },

  // ---- media ----
  listPortalMedia: ({ s, params, query }) => {
    need(s, 'read');
    const st = portalState(s);
    siteById(st, params.siteId);
    const isImage = (m: { mime: string | null }) => Boolean(m.mime?.startsWith('image/'));
    return {
      items: st.media
        .filter((m) => m.siteId === params.siteId)
        .filter((m) =>
          query.filter === 'image'
            ? isImage(m)
            : query.filter === 'document'
              ? !isImage(m)
              : query.filter === 'unused'
                ? m.usage.length === 0
                : true,
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((m) => toMedia(s, m)),
    };
  },

  createPortalMedia: ({ s, params, body }) => {
    const u = need(s, 'edit');
    const st = portalState(s);
    const site = siteById(st, params.siteId);
    const folder = (body.folder ?? 'uploads').replace(/^\/+|\/+$/g, '');
    const dot = body.fileName.lastIndexOf('.');
    const stem = dot > 0 ? body.fileName.slice(0, dot) : body.fileName;
    const ext = dot > 0 ? body.fileName.slice(dot) : '';
    let fileName = body.fileName;
    for (
      let i = 2;
      st.media.some((m) => m.siteId === site.id && m.path === `/media/${folder}/${fileName}`);
      i++
    ) {
      fileName = `${stem}-${i}${ext}`;
    }
    const m = {
      id: newId(),
      siteId: site.id,
      path: `/media/${folder}/${fileName}`,
      fileName,
      mime: body.mime ?? null,
      size: body.size,
      width: null,
      height: null,
      alt: {},
      status: 'pending' as const,
      usage: [],
      createdAt: now(),
      createdById: u.id,
    };
    st.media.push(m);
    return { media: toMedia(s, m), uploadPath: `/api/v1/portal/media/${m.id}/content` };
  },

  updatePortalMedia: ({ s, params, body }) => {
    need(s, 'edit');
    const m = portalState(s).media.find((x) => x.id === params.mediaId);
    if (!m) throw new MockApiError('not_found');
    m.alt = body.alt;
    return toMedia(s, m);
  },

  deletePortalMedia: ({ s, params }) => {
    need(s, 'edit');
    const st = portalState(s);
    const m = st.media.find((x) => x.id === params.mediaId);
    if (!m) throw new MockApiError('not_found');
    if (m.usage.length) throw new MockApiError('portal_media_in_use');
    st.media = st.media.filter((x) => x !== m);
    BYTES.delete(m.id);
    return {};
  },

  // ---- redirects ----
  listPortalRedirects: ({ s, params }) => {
    need(s, 'read');
    const st = portalState(s);
    return {
      items: st.redirects
        .filter((r) => r.siteId === params.siteId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map(({ siteId: _s, ...r }) => r),
    };
  },

  createPortalRedirect: ({ s, params, body }) => {
    need(s, 'edit');
    const st = portalState(s);
    const site = siteById(st, params.siteId);
    if (body.fromPath === body.toPath) throw new MockApiError('portal_redirect_loop');
    if (st.redirects.some((r) => r.siteId === site.id && r.fromPath === body.fromPath)) {
      throw new MockApiError('conflict');
    }
    const r = {
      id: newId(),
      siteId: site.id,
      fromPath: body.fromPath,
      toPath: body.toPath,
      code: body.code,
      auto: false,
      createdAt: now(),
    };
    st.redirects.push(r);
    return {
      id: r.id,
      fromPath: r.fromPath,
      toPath: r.toPath,
      code: r.code,
      auto: r.auto,
      createdAt: r.createdAt,
    };
  },

  deletePortalRedirect: ({ s, params }) => {
    need(s, 'edit');
    const st = portalState(s);
    const before = st.redirects.length;
    st.redirects = st.redirects.filter((r) => r.id !== params.redirectId);
    if (st.redirects.length === before) throw new MockApiError('not_found');
    return {};
  },

  // ---- publishing ----
  listPortalChanges: ({ s, params }) => {
    need(s, 'read');
    const st = portalState(s);
    return { items: changesOf(s, st, siteById(st, params.siteId)) };
  },

  previewPortalPublish: ({ s, params, body }) => {
    need(s, 'read');
    const st = portalState(s);
    const site = siteById(st, params.siteId);
    const changes = selectChanges(s, st, site, body.keys);
    return { changes, ...pathsFor(st, site, changes) };
  },

  publishPortal: ({ s, params, body }) => {
    const u = need(s, 'publish');
    const st = portalState(s);
    const site = siteById(st, params.siteId);
    const changes = selectChanges(s, st, site, body.keys);
    if (!changes.length) throw new MockApiError('portal_nothing_to_publish');
    const { paths, scheduled } = pathsFor(st, site, changes);
    const t = now();
    const items: PortalPublish['items'] = [];
    for (const c of changes) {
      if (c.kind === 'doc') {
        const d = st.docs.find((x) => x.id === c.id)!;
        items.push({
          kind: 'doc',
          id: d.id,
          title: d.title,
          version: d.version,
          locale: d.locale,
          action: c.action,
          rev: d.rev,
          scheduledAt: null,
        });
        if (d.deletedAt) st.docs = st.docs.filter((x) => x !== d);
        else d.published = { rev: d.rev, slug: d.slug, at: t, byId: u.id };
      } else if (c.kind === 'post') {
        const p = st.posts.find((x) => x.id === c.id)!;
        items.push({
          kind: 'post',
          id: p.id,
          title: p.title,
          version: null,
          locale: p.locale,
          action: c.action,
          rev: p.rev,
          scheduledAt: c.scheduledAt,
        });
        if (p.deletedAt) st.posts = st.posts.filter((x) => x !== p);
        else {
          const at = isFuture(p.scheduledAt) ? (p.scheduledAt as string) : t;
          p.published = { rev: p.rev, slug: p.slug, at, byId: u.id };
          p.date ??= at;
        }
      } else {
        const holder = (c.kind === 'home' ? st.homes : st.navigations).find(
          (x) => x.siteId === site.id,
        )!;
        holder.published = structuredClone(holder.draft) as never;
        items.push({
          kind: c.kind,
          id: null,
          title: c.title,
          version: null,
          locale: null,
          action: c.action,
          rev: 1,
          scheduledAt: null,
        });
      }
    }
    const jobs = [
      ...(paths.length ? [job(paths, t, 'running')] : []),
      ...scheduled.map((x) => job(x.paths, x.at, 'queued')),
    ];
    const p: MockPortalPublish = {
      id: newId(),
      siteId: site.id,
      number: nextNumber(st, site.id),
      note: body.note ?? null,
      actorId: u.id,
      status: 'running',
      items,
      jobs,
      titles: items.map((i) => i.title),
      pathCount: jobs.reduce((a, j) => a + j.paths.length, 0),
      durationMs: null,
      revertOf: null,
      revertedBy: null,
      createdAt: t,
      reads: 0,
    };
    st.publishes.push(p);
    site.status = 'live';
    return toPublish(s, p);
  },

  listPortalPublishes: ({ s, params, query }) => {
    need(s, 'read');
    const st = portalState(s);
    const all = st.publishes
      .filter((p) => p.siteId === params.siteId)
      .sort((a, b) => b.number - a.number)
      .map((p) => toPublishSummary(s, p));
    return paginate(all, query.cursor, query.limit);
  },

  getPortalPublish: ({ s, params }) => {
    need(s, 'read');
    const p = portalState(s).publishes.find((x) => x.id === params.publishId);
    if (!p) throw new MockApiError('not_found');
    advance(p);
    return toPublish(s, p);
  },

  revertPortalPublish: ({ s, params, body }) => {
    const u = need(s, 'publish');
    const st = portalState(s);
    const p = st.publishes.find((x) => x.id === params.publishId);
    if (!p) throw new MockApiError('not_found');
    const keyOf = (i: PortalPublish['items'][number]) => `${i.kind}:${i.id ?? p.siteId}`;
    const items = body.keys?.length
      ? p.items.filter((i) => body.keys!.includes(keyOf(i)))
      : p.items;
    if (!items.length) throw new MockApiError('portal_nothing_to_publish');
    const t = now();
    const paths = [...new Set(p.jobs.flatMap((j) => j.paths))];
    const r: MockPortalPublish = {
      id: newId(),
      siteId: p.siteId,
      number: nextNumber(st, p.siteId),
      note: body.note ?? null,
      actorId: u.id,
      status: 'running',
      items: items.map((i) => ({ ...i, action: 'update' as const })),
      jobs: [job(paths, t, 'running')],
      titles: items.map((i) => i.title),
      pathCount: paths.length,
      durationMs: null,
      revertOf: p.number,
      revertedBy: null,
      createdAt: t,
      reads: 0,
    };
    if (items.length === p.items.length) p.revertedBy = r.number;
    st.publishes.push(r);
    return toPublish(s, r);
  },

  retryPortalPublishJob: ({ s, params }) => {
    need(s, 'publish');
    const st = portalState(s);
    for (const p of st.publishes) {
      const j = p.jobs.find((x) => x.id === params.jobId);
      if (!j) continue;
      Object.assign(j, {
        status: 'done',
        attempts: j.attempts + 1,
        httpStatus: 200,
        error: null,
        startedAt: now(),
        finishedAt: now(),
        durationMs: 1500,
      });
      if (!p.jobs.some((x) => x.status === 'failed')) p.status = 'done';
      return j;
    }
    throw new MockApiError('not_found');
  },

  createPortalPreview: ({ s, params, body }) => {
    need(s, 'read');
    const site = siteById(portalState(s), params.siteId);
    const base =
      site.settings.previewUrl ??
      site.settings.url ??
      `https://${site.domain ?? `${site.slug}.example.com`}`;
    const url = new URL(base);
    url.searchParams.set('path', body.path);
    url.searchParams.set('token', randomToken(16));
    return { url: url.toString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
  },

  listPortalImports: ({ s, params }) => {
    need(s, 'read');
    const st = portalState(s);
    return {
      items: st.imports
        .filter((i) => i.siteId === params.siteId)
        .map(({ siteId: _s, actorId, ...rest }) => ({ ...rest, actor: userSummary(s, actorId) })),
    };
  },

  // The public content API needs the site's service token; the web app never calls it.
  portalPublicSite: publicOnly,
  portalPublicSidebar: publicOnly,
  portalPublicPage: publicOnly,
  portalPublicPaths: publicOnly,
  portalPublicPosts: publicOnly,
  portalPublicPost: publicOnly,
  portalPublicTags: publicOnly,
  portalPublicAuthors: publicOnly,
  portalPublicRedirect: publicOnly,
  portalPublicSearch: publicOnly,
};
