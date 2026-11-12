import { sql } from 'drizzle-orm';
import {
  boolean,
  customType,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './auth';
import { blobs } from './drive';
import { organizations } from './org';
import { nodes, spaces } from './space';
import { id, timestamps, tz } from './types';

/**
 * Portal CMS (design 10, 11; doc 17 §4 portal tables, §9 publish flow).
 *
 * Drafts and published snapshots sit side by side in the same row: the draft columns are what
 * editors change (every doc / post also has a page node in the system "Portal" space, doc 17
 * §9 step 1), the `pub_*` / `content_md` columns are the frozen snapshot that the public site
 * reads. A row is "changed" when `rev > published_rev`. Snapshots of every publish are kept in
 * portal_revisions so a publish can be reverted by publishing the previous snapshot again.
 */

const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });

/** Text search configuration by locale (doc 17 §4 "Arama"). */
const searchConfig = (locale: string) =>
  `(case when ${locale} like 'tr%' then 'turkish'::regconfig when ${locale} like 'en%' then 'english'::regconfig else 'simple'::regconfig end)`;

export const portalVersionStatus = pgEnum('portal_version_status', ['next', 'current', 'archived']);
export const portalDocKind = pgEnum('portal_doc_kind', ['doc', 'category']);
export const portalCategoryLink = pgEnum('portal_category_link', [
  'none',
  'generated-index',
  'doc',
]);
export const portalJobStatus = pgEnum('portal_job_status', ['queued', 'running', 'done', 'failed']);
export const portalPublishStatus = pgEnum('portal_publish_status', [
  'queued',
  'running',
  'done',
  'failed',
  'partial',
]);

/** Same shape as PortalSiteSettings in @crewhall/shared (db stays contract-free). */
export interface PortalSiteSettingsData {
  title: string;
  tagline: string | null;
  url: string | null;
  revalidateUrl: string | null;
  previewUrl: string | null;
  timezone: string;
  titleTemplate: string;
  logo: { src: string | null; srcDark: string | null; alt: string };
  favicon: string | null;
  socialImage: string | null;
  nextPublic: boolean;
  showUntranslatedNotice: boolean;
  prism: { light: string; dark: string };
}

export const portalSites = pgTable(
  'portal_sites',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    domain: text('domain'),
    locales: text('locales').array().notNull(),
    defaultLocale: text('default_locale').notNull(),
    settings: jsonb('settings').$type<PortalSiteSettingsData>().notNull(),
    /** The system "Portal" space and this site's folder in it. */
    contentSpaceId: uuid('content_space_id')
      .notNull()
      .references(() => spaces.id, { onDelete: 'restrict' }),
    rootNodeId: uuid('root_node_id').references(() => nodes.id, { onDelete: 'set null' }),
    /** sha256 of the read-only content token (the Next.js site's service token). */
    tokenHash: text('token_hash'),
    tokenHint: text('token_hint'),
    /** Navbar + footer (PortalNavigation) and home page (PortalHome): draft and published. */
    navDraft: jsonb('nav_draft').notNull(),
    nav: jsonb('nav'),
    navRev: integer('nav_rev').notNull().default(1),
    navPublishedRev: integer('nav_published_rev').notNull().default(0),
    navUpdatedAt: tz('nav_updated_at'),
    navUpdatedBy: uuid('nav_updated_by').references(() => users.id, { onDelete: 'set null' }),
    homeDraft: jsonb('home_draft').notNull(),
    home: jsonb('home'),
    homeRev: integer('home_rev').notNull().default(1),
    homePublishedRev: integer('home_published_rev').notNull().default(0),
    homeUpdatedAt: tz('home_updated_at'),
    homeUpdatedBy: uuid('home_updated_by').references(() => users.id, { onDelete: 'set null' }),
    /** Last publish number (#129); publishes take the next one. */
    publishSeq: integer('publish_seq').notNull().default(0),
    lastPublishedAt: tz('last_published_at'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('portal_sites_org_slug_uq').on(t.orgId, t.slug),
    uniqueIndex('portal_sites_token_uq').on(t.tokenHash),
  ],
);

export const portalVersions = pgTable(
  'portal_versions',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    siteId: uuid('site_id')
      .notNull()
      .references(() => portalSites.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    label: text('label').notNull(),
    status: portalVersionStatus('status').notNull(),
    showInPicker: boolean('show_in_picker').notNull().default(true),
    /** Folder of this version in the Portal space. */
    nodeId: uuid('node_id').references(() => nodes.id, { onDelete: 'set null' }),
    frozenAt: tz('frozen_at'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('portal_versions_site_name_uq').on(t.siteId, t.name),
    uniqueIndex('portal_versions_one_current_uq')
      .on(t.siteId)
      .where(sql`${t.status} = 'current'`),
  ],
);

/**
 * One doc or category of one version and locale. `group_id` ties the translations of the same
 * doc together within a version; the tree (parent, position) comes from the default locale.
 */
export const portalDocs = pgTable(
  'portal_docs',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    siteId: uuid('site_id')
      .notNull()
      .references(() => portalSites.id, { onDelete: 'cascade' }),
    versionId: uuid('version_id')
      .notNull()
      .references(() => portalVersions.id, { onDelete: 'cascade' }),
    locale: text('locale').notNull(),
    groupId: uuid('group_id').notNull(),
    kind: portalDocKind('kind').notNull(),
    /** Page node (docs) or folder node (categories) in the Portal space. */
    nodeId: uuid('node_id').references(() => nodes.id, { onDelete: 'set null' }),
    /** Hub page the doc was sent from ("Portal'a gönder"); sending it again updates this doc. */
    sourceNodeId: uuid('source_node_id').references(() => nodes.id, { onDelete: 'set null' }),
    parentGroupId: uuid('parent_group_id'),

    // Draft
    title: text('title').notNull(),
    slug: text('slug').notNull(),
    description: text('description'),
    sidebarLabel: text('sidebar_label'),
    position: doublePrecision('position').notNull().default(0),
    unlisted: boolean('unlisted').notNull().default(false),
    categoryLink: portalCategoryLink('category_link').notNull().default('none'),
    categorySlug: text('category_slug'),
    frontMatter: jsonb('front_matter').$type<Record<string, unknown>>().notNull().default({}),
    seo: jsonb('seo').$type<Record<string, unknown>>().notNull().default({}),
    content: jsonb('content').notNull(),
    rev: integer('rev').notNull().default(1),
    wordCount: integer('word_count').notNull().default(0),
    /** Translations: the source doc's rev this translation was last brought up to date with. */
    sourceRev: integer('source_rev'),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    /** Deleted in the Hub; removed from the site by the next publish. */
    deletedAt: tz('deleted_at'),
    deletedBy: uuid('deleted_by').references(() => users.id, { onDelete: 'set null' }),

    // Published snapshot
    publishedRev: integer('published_rev').notNull().default(0),
    pubTitle: text('pub_title'),
    pubSlug: text('pub_slug'),
    pubDescription: text('pub_description'),
    pubSidebarLabel: text('pub_sidebar_label'),
    pubPosition: doublePrecision('pub_position'),
    pubParentGroupId: uuid('pub_parent_group_id'),
    pubUnlisted: boolean('pub_unlisted'),
    pubCategoryLink: portalCategoryLink('pub_category_link'),
    pubCategorySlug: text('pub_category_slug'),
    pubFrontMatter: jsonb('pub_front_matter').$type<Record<string, unknown>>(),
    pubSeo: jsonb('pub_seo').$type<Record<string, unknown>>(),
    /** Docusaurus-compatible markdown without front matter. */
    contentMd: text('content_md'),
    /** Translations: sourceRev at publish time (site shows "çeviri geride" when behind). */
    pubSourceRev: integer('pub_source_rev'),
    publishedAt: tz('published_at'),
    publishedBy: uuid('published_by').references(() => users.id, { onDelete: 'set null' }),
    search: tsvector('search').generatedAlwaysAs(
      sql.raw(
        `to_tsvector(${searchConfig('locale')}, coalesce(pub_title, '') || ' ' || coalesce(pub_description, '') || ' ' || coalesce(content_md, ''))`,
      ),
    ),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('portal_docs_draft_slug_uq')
      .on(t.versionId, t.locale, t.kind, t.slug)
      .where(sql`${t.deletedAt} is null`),
    uniqueIndex('portal_docs_group_locale_uq').on(t.versionId, t.groupId, t.locale),
    index('portal_docs_site_idx').on(t.siteId, t.versionId, t.locale),
    index('portal_docs_pub_slug_idx').on(t.versionId, t.locale, t.pubSlug),
    index('portal_docs_search_idx').using('gin', t.search),
    index('portal_docs_source_idx')
      .on(t.siteId, t.sourceNodeId)
      .where(sql`${t.sourceNodeId} is not null`),
  ],
);

export const portalAuthors = pgTable(
  'portal_authors',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    siteId: uuid('site_id')
      .notNull()
      .references(() => portalSites.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    name: text('name').notNull(),
    title: text('title'),
    url: text('url'),
    imageUrl: text('image_url'),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  (t) => [uniqueIndex('portal_authors_site_key_uq').on(t.siteId, t.key)],
);

export const portalPosts = pgTable(
  'portal_posts',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    siteId: uuid('site_id')
      .notNull()
      .references(() => portalSites.id, { onDelete: 'cascade' }),
    locale: text('locale').notNull(),
    groupId: uuid('group_id').notNull(),
    nodeId: uuid('node_id').references(() => nodes.id, { onDelete: 'set null' }),

    // Draft
    title: text('title').notNull(),
    slug: text('slug').notNull(),
    description: text('description'),
    authorIds: uuid('author_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    tags: text('tags')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    date: tz('date'),
    scheduledAt: tz('scheduled_at'),
    cover: text('cover'),
    frontMatter: jsonb('front_matter').$type<Record<string, unknown>>().notNull().default({}),
    seo: jsonb('seo').$type<Record<string, unknown>>().notNull().default({}),
    content: jsonb('content').notNull(),
    rev: integer('rev').notNull().default(1),
    wordCount: integer('word_count').notNull().default(0),
    codeBlocks: integer('code_blocks').notNull().default(0),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    deletedAt: tz('deleted_at'),
    deletedBy: uuid('deleted_by').references(() => users.id, { onDelete: 'set null' }),

    // Published snapshot
    publishedRev: integer('published_rev').notNull().default(0),
    pubTitle: text('pub_title'),
    pubSlug: text('pub_slug'),
    pubDescription: text('pub_description'),
    pubAuthorIds: uuid('pub_author_ids').array(),
    pubTags: text('pub_tags').array(),
    /** Date shown on the site. */
    pubDate: tz('pub_date'),
    pubCover: text('pub_cover'),
    pubFrontMatter: jsonb('pub_front_matter').$type<Record<string, unknown>>(),
    pubSeo: jsonb('pub_seo').$type<Record<string, unknown>>(),
    contentMd: text('content_md'),
    excerptMd: text('excerpt_md'),
    truncated: boolean('truncated'),
    readingMinutes: integer('reading_minutes'),
    /** Visible on the site from this time (scheduled posts: their time). */
    visibleAt: tz('visible_at'),
    publishedAt: tz('published_at'),
    publishedBy: uuid('published_by').references(() => users.id, { onDelete: 'set null' }),
    search: tsvector('search').generatedAlwaysAs(
      sql.raw(
        `to_tsvector(${searchConfig('locale')}, coalesce(pub_title, '') || ' ' || coalesce(pub_description, '') || ' ' || coalesce(content_md, ''))`,
      ),
    ),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('portal_posts_draft_slug_uq')
      .on(t.siteId, t.locale, t.slug)
      .where(sql`${t.deletedAt} is null`),
    uniqueIndex('portal_posts_group_locale_uq').on(t.siteId, t.groupId, t.locale),
    index('portal_posts_visible_idx').on(t.siteId, t.locale, t.visibleAt),
    index('portal_posts_search_idx').using('gin', t.search),
  ],
);

export const portalMedia = pgTable(
  'portal_media',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    siteId: uuid('site_id')
      .notNull()
      .references(() => portalSites.id, { onDelete: 'cascade' }),
    /** Permanent public path, e.g. /media/img/logo.svg. */
    path: text('path').notNull(),
    fileName: text('file_name').notNull(),
    blobId: uuid('blob_id').references(() => blobs.id, { onDelete: 'restrict' }),
    mime: text('mime'),
    size: integer('size').notNull().default(0),
    width: integer('width'),
    height: integer('height'),
    alt: jsonb('alt').$type<Record<string, string>>().notNull().default({}),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  (t) => [uniqueIndex('portal_media_site_path_uq').on(t.siteId, t.path)],
);

export const portalRedirects = pgTable(
  'portal_redirects',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    siteId: uuid('site_id')
      .notNull()
      .references(() => portalSites.id, { onDelete: 'cascade' }),
    fromPath: text('from_path').notNull(),
    toPath: text('to_path').notNull(),
    code: integer('code').notNull().default(301),
    /** Added by a slug change (or the import), not by hand. */
    auto: boolean('auto').notNull().default(false),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  (t) => [uniqueIndex('portal_redirects_site_from_uq').on(t.siteId, t.fromPath)],
);

/** Item of a publish: what was published at which rev (PortalPublishItem in the contract). */
export interface PortalPublishItemData {
  kind: 'doc' | 'post' | 'home' | 'navigation';
  id: string | null;
  title: string;
  version: string | null;
  locale: string | null;
  action: 'create' | 'update' | 'remove' | 'schedule';
  rev: number;
  scheduledAt: string | null;
}

/** Every publish is an immutable record (design 10.12). */
export const portalPublishes = pgTable(
  'portal_publishes',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    siteId: uuid('site_id')
      .notNull()
      .references(() => portalSites.id, { onDelete: 'cascade' }),
    number: integer('number').notNull(),
    note: text('note'),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    status: portalPublishStatus('status').notNull().default('queued'),
    items: jsonb('items').$type<PortalPublishItemData[]>().notNull(),
    pathCount: integer('path_count').notNull().default(0),
    revertOf: uuid('revert_of'),
    revertedBy: uuid('reverted_by'),
    durationMs: integer('duration_ms'),
    finishedAt: tz('finished_at'),
    ...timestamps(),
  },
  (t) => [uniqueIndex('portal_publishes_site_number_uq').on(t.siteId, t.number)],
);

/** Revalidation calls to the site (doc 17 §9 step 4: portal_publish_jobs). */
export const portalPublishJobs = pgTable(
  'portal_publish_jobs',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    siteId: uuid('site_id')
      .notNull()
      .references(() => portalSites.id, { onDelete: 'cascade' }),
    publishId: uuid('publish_id').references(() => portalPublishes.id, { onDelete: 'cascade' }),
    /** doc · post · nav · home · version (doc 17 §4 j.scope). */
    scope: text('scope').notNull(),
    tags: text('tags').array().notNull(),
    paths: text('paths').array().notNull(),
    status: portalJobStatus('status').notNull().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    runAt: tz('run_at').notNull().defaultNow(),
    startedAt: tz('started_at'),
    finishedAt: tz('finished_at'),
    durationMs: integer('duration_ms'),
    httpStatus: integer('http_status'),
    error: text('error'),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  (t) => [
    index('portal_publish_jobs_publish_idx').on(t.publishId),
    index('portal_publish_jobs_site_idx').on(t.siteId, t.createdAt),
  ],
);

/** Published snapshot of an item per publish, for revert (design 10.12 "Geri al"). */
export const portalRevisions = pgTable(
  'portal_revisions',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    siteId: uuid('site_id')
      .notNull()
      .references(() => portalSites.id, { onDelete: 'cascade' }),
    publishId: uuid('publish_id')
      .notNull()
      .references(() => portalPublishes.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    /** Doc / post id; null for home and navigation. */
    entityId: uuid('entity_id'),
    /** The published columns after this publish; null = removed from the site. */
    snapshot: jsonb('snapshot').$type<Record<string, unknown> | null>(),
    ...timestamps(),
  },
  (t) => [index('portal_revisions_entity_idx').on(t.siteId, t.kind, t.entityId, t.createdAt)],
);

/** Import reports (design 10.16); the CLI writes them. */
export const portalImports = pgTable('portal_imports', {
  id: id(),
  orgId: uuid('org_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  siteId: uuid('site_id')
    .notNull()
    .references(() => portalSites.id, { onDelete: 'cascade' }),
  actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
  report: jsonb('report').$type<Record<string, unknown>>().notNull(),
  ...timestamps(),
});
