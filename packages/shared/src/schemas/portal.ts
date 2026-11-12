import { z } from 'zod';
import { Id, Timestamp } from './common';
import { UserSummary } from './org';

/**
 * Portal CMS (design 10 and 11; doc 17 §4 portal tables, §9 publish flow).
 *
 * Drafts live in the Hub (one page node per document in the system "Portal" space) and are
 * edited as Tiptap JSON (`PortalRichDoc`, the @crewhall/editor model). Publishing converts a
 * draft to Docusaurus-compatible markdown and freezes it as the published snapshot; the
 * Next.js site reads only snapshots through the public endpoints with a read-only service
 * token. URLs follow Docusaurus: /docs/<version>/<slug>, /<locale>/docs/..., /blog/<slug>.
 */

// ---------------------------------------------------------------------------
// Primitives

/** Site language code. Sites are tenant data, so not limited to the Hub's tr/en. */
export const PortalLocale = z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/);
export type PortalLocale = z.infer<typeof PortalLocale>;

/** Text per site language, e.g. `{ en: 'Docs', tr: 'Dokümanlar' }`; missing → default locale. */
export const LocalizedText = z.record(z.string(), z.string());
export type LocalizedText = z.infer<typeof LocalizedText>;

/** `next` (working copy) or a release number such as 1.0.1. */
export const PortalVersionName = z
  .string()
  .regex(/^(next|\d+(\.\d+){0,3}([-.][0-9A-Za-z.]+)?)$/, 'Use "next" or a number like 1.2.0');

/**
 * One URL segment of a doc or post slug. Commas are allowed because imported Docusaurus URLs
 * contain them and URLs must not change (design 10: "URL'ler kutsal").
 */
const SLUG_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._,~-]*$/;

/** Doc path below /docs/<version>/, e.g. `open-source-libs/milvaion/quick-start`. */
export const PortalDocSlug = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .refine((s) => s.split('/').every((p) => SLUG_SEGMENT.test(p)), 'Invalid slug');

/** Blog post slug; Docusaurus default slugs have segments (`2024/06/01/name`). */
export const PortalPostSlug = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((s) => s.split('/').every((p) => SLUG_SEGMENT.test(p)), 'Invalid slug');

/** Site-relative public path such as `/docs/1.0.1/welcome` or `/blog`. */
export const PortalPath = z
  .string()
  .max(500)
  .regex(/^\/[^\s]*$/, 'Must start with /');

/**
 * Tiptap / ProseMirror JSON document from @crewhall/editor. The editor package owns the node
 * schema; the contract only checks the outer shape so the editor can grow node types.
 */
export interface PortalRichNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PortalRichNode[];
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  text?: string;
}
export const PortalRichNode: z.ZodType<PortalRichNode> = z.lazy(() =>
  z.object({
    type: z.string().min(1),
    attrs: z.record(z.string(), z.unknown()).optional(),
    content: z.array(PortalRichNode).optional(),
    marks: z
      .array(z.object({ type: z.string(), attrs: z.record(z.string(), z.unknown()).optional() }))
      .optional(),
    text: z.string().optional(),
  }),
);
export const PortalRichDoc = z.object({
  type: z.literal('doc'),
  content: z.array(PortalRichNode).optional(),
});
export type PortalRichDoc = z.infer<typeof PortalRichDoc>;

/** Draft state of an item against its published snapshot. */
export const PortalItemStatus = z.enum([
  /** Never published. */
  'draft',
  /** Published and the draft is the same. */
  'published',
  /** Published, with unpublished draft changes. */
  'changed',
  /** Deleted in the Hub; disappears from the site on the next publish. */
  'removed',
]);
export type PortalItemStatus = z.infer<typeof PortalItemStatus>;

/** A translation against its source-language document (design 10.3). */
export const PortalTranslationState = z.enum([
  /** This is the source language. */
  'source',
  'missing',
  'current',
  /** The source changed after the translation was last marked current. */
  'outdated',
]);
export type PortalTranslationState = z.infer<typeof PortalTranslationState>;

export const PortalSeo = z.object({
  /** Overrides the title template result. */
  title: z.string().max(120).nullable().optional(),
  /** Overrides the document description as meta description. */
  description: z.string().max(320).nullable().optional(),
  noindex: z.boolean().optional(),
  /** Leave out of sitemap.xml. */
  excludeFromSitemap: z.boolean().optional(),
  /** Media path for og:image; empty = generated / site default. */
  image: z.string().nullable().optional(),
  canonical: z.url().nullable().optional(),
});
export type PortalSeo = z.infer<typeof PortalSeo>;

// ---------------------------------------------------------------------------
// Site

export const PortalLogo = z.object({
  src: z.string().nullable(),
  srcDark: z.string().nullable(),
  alt: z.string(),
});

export const PortalSiteSettings = z.object({
  /** Navbar and <title> site name, e.g. "Milva Portal". */
  title: z.string().min(1).max(80),
  tagline: z.string().max(200).nullable(),
  /** Public base URL, e.g. https://portal.example.com (canonical, sitemap). */
  url: z.url().nullable(),
  /** Next.js revalidate endpoint the worker calls on publish. */
  revalidateUrl: z.url().nullable(),
  /** Next.js preview endpoint for "Önizle" (signed 1 h token). */
  previewUrl: z.url().nullable(),
  /** Zone for scheduled posts, e.g. Europe/Istanbul. */
  timezone: z.string().min(1).max(64),
  /** `{page} | {site}` */
  titleTemplate: z.string().max(80),
  logo: PortalLogo,
  favicon: z.string().nullable(),
  /** Default og:image (media path). */
  socialImage: z.string().nullable(),
  /** Show /docs/next publicly with the "unreleased" banner. */
  nextPublic: z.boolean(),
  /** Count a translation identical to its source as "missing" (import option). */
  showUntranslatedNotice: z.boolean(),
  /** Prism themes, by Docusaurus name. */
  prism: z.object({ light: z.string(), dark: z.string() }),
});
export type PortalSiteSettings = z.infer<typeof PortalSiteSettings>;

export const PortalSiteStatus = z.enum(['live', 'setup']);

export const PortalSiteSummary = z.object({
  id: Id,
  slug: z.string(),
  name: z.string(),
  domain: z.string().nullable(),
  status: PortalSiteStatus,
  locales: z.array(PortalLocale),
  currentVersion: z.string().nullable(),
  /** Published, indexable URLs (sitemap size). */
  publishedUrlCount: z.number().int(),
  pendingCount: z.number().int(),
});
export type PortalSiteSummary = z.infer<typeof PortalSiteSummary>;

/** What the caller may do on portal sites (`can` portal.edit / portal.publish, org roles). */
export const PortalCapabilities = z.object({
  edit: z.boolean(),
  publish: z.boolean(),
  /** Settings, tokens, import: org admins and owners. */
  manage: z.boolean(),
});
export type PortalCapabilities = z.infer<typeof PortalCapabilities>;

export const PortalSite = PortalSiteSummary.extend({
  defaultLocale: PortalLocale,
  settings: PortalSiteSettings,
  /** The system "Portal" space holding the draft page nodes. */
  contentSpaceId: Id,
  /** Last 4 characters of the content read token; null = no token yet. */
  tokenHint: z.string().nullable(),
  lastPublishedAt: Timestamp.nullable(),
  capabilities: PortalCapabilities,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type PortalSite = z.infer<typeof PortalSite>;

export const CreatePortalSite = z.object({
  name: z.string().trim().min(1).max(80),
  slug: z
    .string()
    .trim()
    .min(2)
    .max(60)
    .regex(/^[a-z0-9][a-z0-9-]*$/),
  domain: z.string().trim().max(200).nullable().optional(),
  locales: z.array(PortalLocale).min(1).max(12),
  defaultLocale: PortalLocale,
  /** First release number; `next` is always created next to it. */
  initialVersion: PortalVersionName.default('1.0.0'),
});
export type CreatePortalSite = z.infer<typeof CreatePortalSite>;

export const UpdatePortalSite = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  domain: z.string().trim().max(200).nullable().optional(),
  locales: z.array(PortalLocale).min(1).max(12).optional(),
  defaultLocale: PortalLocale.optional(),
  settings: PortalSiteSettings.partial().optional(),
});
export type UpdatePortalSite = z.infer<typeof UpdatePortalSite>;

/** Returned once on rotation; only its hash is stored. */
export const PortalToken = z.object({ token: z.string(), tokenHint: z.string() });

export const PortalRevalidateTest = z.object({
  ok: z.boolean(),
  status: z.number().int().nullable(),
  ms: z.number().int(),
  error: z.string().nullable(),
});

// ---------------------------------------------------------------------------
// Versions

export const PortalVersionStatus = z.enum([
  /** `next`: the working copy of the coming release; public only when nextPublic. */
  'next',
  /** The default version (/docs redirects here). Freely editable. */
  'current',
  /** Older release: frozen, edits are patches published one page at a time. */
  'archived',
]);
export type PortalVersionStatus = z.infer<typeof PortalVersionStatus>;

export const PortalVersion = z.object({
  id: Id,
  name: z.string(),
  label: z.string(),
  status: PortalVersionStatus,
  showInPicker: z.boolean(),
  /** Document count per locale. */
  docCounts: z.record(z.string(), z.number().int()),
  /** Draft changes not yet published in this version. */
  pendingCount: z.number().int(),
  frozenAt: Timestamp.nullable(),
  createdAt: Timestamp,
});
export type PortalVersion = z.infer<typeof PortalVersion>;

export const FreezePortalVersion = z.object({
  name: PortalVersionName.refine((v) => v !== 'next', 'Choose a release number'),
  label: z.string().trim().max(40).nullable().optional(),
  /** Make it the default (/docs) and archive the old current version. */
  makeCurrent: z.boolean().default(true),
  /** Copy the non-source languages too. */
  includeTranslations: z.boolean().default(true),
});
export type FreezePortalVersion = z.infer<typeof FreezePortalVersion>;

export const UpdatePortalVersion = z.object({
  label: z.string().trim().min(1).max(40).optional(),
  showInPicker: z.boolean().optional(),
  /** Only `true`: makes this release the current one. */
  makeCurrent: z.literal(true).optional(),
});

export const PortalVersionDiffQuery = z.object({
  from: z.string().default('next'),
  to: z.string(),
  locale: PortalLocale.optional(),
});
export const PortalVersionDiff = z.object({
  added: z.array(z.object({ slug: z.string(), title: z.string() })),
  changed: z.array(z.object({ slug: z.string(), title: z.string() })),
  removed: z.array(z.object({ slug: z.string(), title: z.string() })),
});
export type PortalVersionDiff = z.infer<typeof PortalVersionDiff>;

// ---------------------------------------------------------------------------
// Docs and categories

export const PortalDocKind = z.enum(['doc', 'category']);
export type PortalDocKind = z.infer<typeof PortalDocKind>;

export const PortalTranslationRef = z.object({
  locale: PortalLocale,
  docId: Id.nullable(),
  state: PortalTranslationState,
  status: PortalItemStatus.nullable(),
});
export type PortalTranslationRef = z.infer<typeof PortalTranslationRef>;

/** One row of the doc tree (design 10.2): categories and docs of one version and locale. */
export const PortalTreeItem = z.object({
  /** Doc id in the requested locale; null when it has no translation yet. */
  id: Id.nullable(),
  /** Translation group: the same doc across languages of a version. */
  groupId: Id,
  /** Source-language doc id (same as `id` in the source locale). */
  sourceId: Id,
  kind: PortalDocKind,
  /** Parent category's groupId; null at the root. */
  parentGroupId: Id.nullable(),
  title: z.string(),
  sidebarLabel: z.string().nullable(),
  slug: z.string(),
  position: z.number(),
  status: PortalItemStatus.nullable(),
  translation: PortalTranslationState,
  /** Hidden from the sidebar (Docusaurus `_` prefix, `unlisted`). */
  unlisted: z.boolean(),
  updatedAt: Timestamp,
});
export type PortalTreeItem = z.infer<typeof PortalTreeItem>;

export const PortalTreeQuery = z.object({ version: z.string(), locale: PortalLocale });

export const PortalCategoryLink = z.enum(['none', 'generated-index', 'doc']);

export const PortalDoc = z.object({
  id: Id,
  siteId: Id,
  groupId: Id,
  kind: PortalDocKind,
  version: z.string(),
  versionStatus: PortalVersionStatus,
  locale: PortalLocale,
  /** Page node in the Portal space (doc 17 §9 step 1). */
  nodeId: Id,
  parentGroupId: Id.nullable(),
  title: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  sidebarLabel: z.string().nullable(),
  position: z.number(),
  unlisted: z.boolean(),
  /** Categories: how the category itself links (Docusaurus `_category_.json` link). */
  categoryLink: PortalCategoryLink,
  /** Categories with a generated index: its slug, e.g. `category/milvaion-scheduler`. */
  categorySlug: z.string().nullable(),
  /** Remaining Docusaurus front matter, kept for round trips (keywords, tags, …). */
  frontMatter: z.record(z.string(), z.unknown()),
  seo: PortalSeo,
  content: PortalRichDoc,
  /** Draft revision; increases on every save (autosave conflict check). */
  rev: z.number().int(),
  status: PortalItemStatus,
  published: z
    .object({
      rev: z.number().int(),
      slug: z.string(),
      at: Timestamp,
      by: UserSummary.nullable(),
    })
    .nullable(),
  translation: PortalTranslationState,
  /** Source-language doc for translations (design 10.3). */
  source: z.object({ id: Id, rev: z.number().int(), updatedAt: Timestamp }).nullable(),
  translations: z.array(PortalTranslationRef),
  /** Category titles from the root down, for the breadcrumb. */
  path: z.array(z.object({ groupId: Id, title: z.string() })),
  wordCount: z.number().int(),
  updatedAt: Timestamp,
  updatedBy: UserSummary.nullable(),
  /** Hub page the doc was sent from ("Portal'a gönder"). Absent on older servers. */
  sourceNodeId: Id.nullable().optional(),
});
export type PortalDoc = z.infer<typeof PortalDoc>;

/**
 * "Portal'a gönder": a Hub page becomes a draft doc of the site. The same page sent again to the
 * same version and language updates that draft; another language of it becomes its translation.
 * Publishing stays a separate step.
 */
export const PortalDocFromPage = z.object({
  nodeId: Id,
  version: z.string().min(1).max(60),
  locale: PortalLocale,
  /** Category groupId for a new doc; null = root. Ignored when the doc already exists. */
  parentGroupId: Id.nullable().optional(),
  /** For a new doc; derived from the title when omitted. */
  slug: PortalDocSlug.optional(),
});
export type PortalDocFromPage = z.infer<typeof PortalDocFromPage>;

export const PortalDocFromPageResult = z.object({
  doc: PortalDoc,
  /** False when an earlier draft of the same page was updated. */
  created: z.boolean(),
  /** Page images copied to the site's media; those that could not be read are left out. */
  images: z.object({ copied: z.number().int(), skipped: z.number().int() }),
});
export type PortalDocFromPageResult = z.infer<typeof PortalDocFromPageResult>;

export const CreatePortalDoc = z.object({
  kind: PortalDocKind.default('doc'),
  version: z.string(),
  locale: PortalLocale,
  /** Source-language category groupId; null = root. Ignored for translations. */
  parentGroupId: Id.nullable().optional(),
  /** Create the translation of this source doc (same group, other locale). */
  translationOf: Id.optional(),
  title: z.string().trim().min(1).max(200),
  /** Derived from the parent path and title when omitted. */
  slug: PortalDocSlug.optional(),
  position: z.number().optional(),
  /** Start from markdown instead of an empty page (MCP, "Hub sayfasından doküman"). */
  markdown: z.string().max(2_000_000).optional(),
  /** Copy the source doc's content as the translation's starting point. */
  copySource: z.boolean().optional(),
});
export type CreatePortalDoc = z.infer<typeof CreatePortalDoc>;

export const UpdatePortalDoc = z.object({
  /** Draft revision the change is based on; a newer server rev answers 409. */
  baseRev: z.number().int().optional(),
  title: z.string().trim().min(1).max(200).optional(),
  slug: PortalDocSlug.optional(),
  description: z.string().max(500).nullable().optional(),
  sidebarLabel: z.string().max(120).nullable().optional(),
  position: z.number().optional(),
  parentGroupId: Id.nullable().optional(),
  unlisted: z.boolean().optional(),
  categoryLink: PortalCategoryLink.optional(),
  frontMatter: z.record(z.string(), z.unknown()).optional(),
  seo: PortalSeo.optional(),
  content: PortalRichDoc.optional(),
  /** Replace the content from markdown (MCP upsert, paste). */
  markdown: z.string().max(2_000_000).optional(),
});
export type UpdatePortalDoc = z.infer<typeof UpdatePortalDoc>;

export const PortalMarkdown = z.object({ markdown: z.string() });

// ---------------------------------------------------------------------------
// Blog

export const PortalAuthor = z.object({
  id: Id,
  /** Docusaurus authors.yml key, e.g. `jane-doe`. */
  key: z.string(),
  name: z.string(),
  title: z.string().nullable(),
  url: z.string().nullable(),
  imageUrl: z.string().nullable(),
  /** Linked Hub user; null for external authors. */
  user: UserSummary.nullable(),
});
export type PortalAuthor = z.infer<typeof PortalAuthor>;

export const UpsertPortalAuthor = z.object({
  key: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .regex(/^[A-Za-z0-9_-]+$/),
  name: z.string().trim().min(1).max(120),
  title: z.string().trim().max(120).nullable().optional(),
  url: z.string().trim().max(500).nullable().optional(),
  imageUrl: z.string().trim().max(500).nullable().optional(),
  userId: Id.nullable().optional(),
});
export type UpsertPortalAuthor = z.infer<typeof UpsertPortalAuthor>;

export const PortalPostStatus = z.enum(['draft', 'scheduled', 'published', 'changed', 'removed']);
export type PortalPostStatus = z.infer<typeof PortalPostStatus>;

export const PortalPostSummary = z.object({
  id: Id,
  groupId: Id,
  locale: PortalLocale,
  slug: z.string(),
  title: z.string(),
  status: PortalPostStatus,
  authors: z.array(PortalAuthor),
  tags: z.array(z.string()),
  /** Post date shown on the site (Docusaurus `date`). */
  date: Timestamp.nullable(),
  /** Future publish time when scheduled. */
  scheduledAt: Timestamp.nullable(),
  readingMinutes: z.number().int(),
  translations: z.array(
    z.object({ locale: PortalLocale, postId: Id.nullable(), status: PortalPostStatus.nullable() }),
  ),
  updatedAt: Timestamp,
});
export type PortalPostSummary = z.infer<typeof PortalPostSummary>;

export const PortalPostListQuery = z.object({
  status: z.enum(['all', 'published', 'scheduled', 'draft']).default('all'),
  locale: PortalLocale.optional(),
});

export const PortalPost = PortalPostSummary.extend({
  siteId: Id,
  nodeId: Id,
  description: z.string().nullable(),
  /** Media path of the cover image. */
  cover: z.string().nullable(),
  frontMatter: z.record(z.string(), z.unknown()),
  seo: PortalSeo,
  content: PortalRichDoc,
  rev: z.number().int(),
  wordCount: z.number().int(),
  codeBlockCount: z.number().int(),
  published: z
    .object({ rev: z.number().int(), slug: z.string(), at: Timestamp, by: UserSummary.nullable() })
    .nullable(),
  updatedBy: UserSummary.nullable(),
});
export type PortalPost = z.infer<typeof PortalPost>;

export const CreatePortalPost = z.object({
  locale: PortalLocale,
  title: z.string().trim().min(1).max(200),
  slug: PortalPostSlug.optional(),
  translationOf: Id.optional(),
  markdown: z.string().max(2_000_000).optional(),
  authorIds: z.array(Id).optional(),
  tags: z.array(z.string().trim().min(1).max(60)).max(30).optional(),
});
export type CreatePortalPost = z.infer<typeof CreatePortalPost>;

export const UpdatePortalPost = z.object({
  baseRev: z.number().int().optional(),
  title: z.string().trim().min(1).max(200).optional(),
  slug: PortalPostSlug.optional(),
  description: z.string().max(500).nullable().optional(),
  authorIds: z.array(Id).optional(),
  tags: z.array(z.string().trim().min(1).max(60)).max(30).optional(),
  date: Timestamp.nullable().optional(),
  /** Future time = scheduled; null = publish right away when "Yayınla" runs. */
  scheduledAt: Timestamp.nullable().optional(),
  cover: z.string().nullable().optional(),
  frontMatter: z.record(z.string(), z.unknown()).optional(),
  seo: PortalSeo.optional(),
  content: PortalRichDoc.optional(),
  markdown: z.string().max(2_000_000).optional(),
});
export type UpdatePortalPost = z.infer<typeof UpdatePortalPost>;

// ---------------------------------------------------------------------------
// Home page, navbar and footer (design 10.8, 10.9)

export const PortalHomeSectionType = z.enum([
  'hero',
  'about',
  'video',
  'features',
  'technologies',
  'community',
  'projects',
  'markdown',
]);

export const PortalProject = z.object({
  name: z.string(),
  image: z.string().nullable(),
  url: z.string().nullable(),
  description: LocalizedText,
  badges: z.array(z.object({ url: z.string(), image: z.string(), alt: z.string() })),
});

/**
 * One section of the home page. Layout and animation stay in the site's code; the Hub edits
 * text, images and lists. `{version}` in texts becomes the current release on the site.
 */
export const PortalHomeSection = z.object({
  id: z.string().min(1).max(40),
  type: PortalHomeSectionType,
  hidden: z.boolean(),
  title: LocalizedText,
  description: LocalizedText.optional(),
  badge: LocalizedText.optional(),
  /** Per-locale bullet list (features). */
  items: z.record(z.string(), z.array(z.string())).optional(),
  image: z.string().nullable().optional(),
  imageDark: z.string().nullable().optional(),
  images: z.array(z.string()).optional(),
  videoId: z.string().nullable().optional(),
  projects: z.array(PortalProject).optional(),
});
export type PortalHomeSection = z.infer<typeof PortalHomeSection>;

export const PortalHome = z.object({ sections: z.array(PortalHomeSection).max(30) });
export type PortalHome = z.infer<typeof PortalHome>;

export const PortalNavItemKind = z.enum([
  'docs',
  'blog',
  'link',
  'doc',
  'localeDropdown',
  'versionDropdown',
]);

export const PortalNavItem = z.object({
  id: z.string().min(1).max(40),
  kind: PortalNavItemKind,
  position: z.enum(['left', 'right']),
  label: LocalizedText,
  /** External or site-relative link (kind link). */
  href: z.string().max(500).nullable().optional(),
  /** Internal doc link by translation group, kept valid across slug changes (kind doc). */
  docGroupId: Id.nullable().optional(),
  hidden: z.boolean(),
});
export type PortalNavItem = z.infer<typeof PortalNavItem>;

export const PortalFooterLink = z.object({
  id: z.string().min(1).max(40),
  label: LocalizedText,
  href: z.string().max(500).nullable().optional(),
  docGroupId: Id.nullable().optional(),
});

export const PortalNavigation = z.object({
  navbar: z.object({
    title: LocalizedText,
    logo: PortalLogo,
    items: z.array(PortalNavItem).max(20),
  }),
  footer: z.object({
    style: z.enum(['dark', 'light']),
    columns: z
      .array(
        z.object({
          id: z.string().min(1).max(40),
          title: LocalizedText,
          items: z.array(PortalFooterLink).max(20),
        }),
      )
      .max(8),
    /** `{year}` becomes the current year on the server. */
    copyright: LocalizedText,
  }),
});
export type PortalNavigation = z.infer<typeof PortalNavigation>;

export const PortalHomeState = z.object({
  draft: PortalHome,
  published: PortalHome.nullable(),
  changed: z.boolean(),
  updatedAt: Timestamp.nullable(),
  updatedBy: UserSummary.nullable(),
});
export const PortalNavigationState = z.object({
  draft: PortalNavigation,
  published: PortalNavigation.nullable(),
  changed: z.boolean(),
  updatedAt: Timestamp.nullable(),
  updatedBy: UserSummary.nullable(),
});

// ---------------------------------------------------------------------------
// Media (design 10.14)

export const PortalMediaUsage = z.object({
  kind: z.enum(['doc', 'post', 'home', 'navigation', 'settings']),
  id: Id.nullable(),
  title: z.string(),
  locale: PortalLocale.nullable(),
});

export const PortalMedia = z.object({
  id: Id,
  /** Permanent site path, e.g. /media/img/logo.svg ("Değiştir" keeps it). */
  path: z.string(),
  fileName: z.string(),
  mime: z.string().nullable(),
  size: z.number().int(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  alt: LocalizedText,
  /** Hub URL that serves the bytes to signed-in editors. */
  url: z.string(),
  status: z.enum(['pending', 'ready']),
  usage: z.array(PortalMediaUsage),
  createdAt: Timestamp,
  createdBy: UserSummary.nullable(),
});
export type PortalMedia = z.infer<typeof PortalMedia>;

export const PortalMediaQuery = z.object({
  filter: z.enum(['all', 'image', 'document', 'unused']).default('all'),
});

export const CreatePortalMedia = z.object({
  fileName: z.string().trim().min(1).max(200),
  mime: z.string().max(120).nullable().optional(),
  size: z
    .number()
    .int()
    .min(0)
    .max(50 * 1024 * 1024),
  /** Folder below /media, e.g. `img` or `docs/milvaion`; default `uploads`. */
  folder: z.string().max(200).optional(),
});

/** Bytes go to `PUT uploadPath` (raw body) on the api; the media is ready after it. */
export const PortalMediaUpload = z.object({ media: PortalMedia, uploadPath: z.string() });

export const UpdatePortalMedia = z.object({ alt: LocalizedText });

// ---------------------------------------------------------------------------
// Redirects (design 10.10 "Yönlendirmeler"; doc 17 §4 redirects)

export const PortalRedirect = z.object({
  id: Id,
  fromPath: z.string(),
  toPath: z.string(),
  code: z.union([z.literal(301), z.literal(308)]),
  /** Added by a slug change rather than by hand. */
  auto: z.boolean(),
  createdAt: Timestamp,
});
export type PortalRedirect = z.infer<typeof PortalRedirect>;

export const CreatePortalRedirect = z.object({
  fromPath: PortalPath,
  toPath: PortalPath.or(z.url()),
  code: z.union([z.literal(301), z.literal(308)]).default(301),
});

// ---------------------------------------------------------------------------
// Publishing (design 10.11, 10.12; doc 17 §9)

export const PortalChangeKind = z.enum(['doc', 'post', 'home', 'navigation']);
export type PortalChangeKind = z.infer<typeof PortalChangeKind>;

/** An unpublished change in the site's single queue. `key` is `<kind>:<id>`. */
export const PortalChange = z.object({
  key: z.string(),
  kind: PortalChangeKind,
  id: Id.nullable(),
  title: z.string(),
  /** "Doküman · Milvaion Scheduler · 1.0.1", built by the client from these fields. */
  version: z.string().nullable(),
  locale: PortalLocale.nullable(),
  action: z.enum(['create', 'update', 'remove', 'schedule']),
  scheduledAt: Timestamp.nullable(),
  changedAt: Timestamp,
  changedBy: UserSummary.nullable(),
});
export type PortalChange = z.infer<typeof PortalChange>;

export const PortalPublishRequest = z.object({
  /** Change keys to publish; empty or omitted = the whole queue. */
  keys: z.array(z.string()).max(1000).optional(),
  note: z.string().trim().max(500).nullable().optional(),
});
export type PortalPublishRequest = z.infer<typeof PortalPublishRequest>;

export const PortalPublishPreview = z.object({
  changes: z.array(PortalChange),
  /** Paths revalidated right away. */
  paths: z.array(z.string()),
  /** Paths revalidated later, for scheduled posts. */
  scheduled: z.array(z.object({ at: Timestamp, paths: z.array(z.string()) })),
});
export type PortalPublishPreview = z.infer<typeof PortalPublishPreview>;

export const PortalJobStatus = z.enum(['queued', 'running', 'done', 'failed']);
export type PortalJobStatus = z.infer<typeof PortalJobStatus>;

export const PortalPublishJob = z.object({
  id: Id,
  status: PortalJobStatus,
  /** When the revalidation runs (scheduled posts: their publish time). */
  runAt: Timestamp,
  attempts: z.number().int(),
  paths: z.array(z.string()),
  tags: z.array(z.string()),
  /** HTTP status of the last revalidate call. */
  httpStatus: z.number().int().nullable(),
  error: z.string().nullable(),
  startedAt: Timestamp.nullable(),
  finishedAt: Timestamp.nullable(),
  durationMs: z.number().int().nullable(),
});
export type PortalPublishJob = z.infer<typeof PortalPublishJob>;

export const PortalPublishItem = z.object({
  kind: PortalChangeKind,
  id: Id.nullable(),
  title: z.string(),
  version: z.string().nullable(),
  locale: PortalLocale.nullable(),
  action: z.enum(['create', 'update', 'remove', 'schedule']),
  rev: z.number().int(),
  scheduledAt: Timestamp.nullable(),
});

export const PortalPublishStatus = z.enum(['queued', 'running', 'done', 'failed', 'partial']);

export const PortalPublishSummary = z.object({
  id: Id,
  /** Site-wide sequence number (#129). */
  number: z.number().int(),
  note: z.string().nullable(),
  actor: UserSummary.nullable(),
  status: PortalPublishStatus,
  itemCount: z.number().int(),
  titles: z.array(z.string()),
  pathCount: z.number().int(),
  durationMs: z.number().int().nullable(),
  /** Number of the publish this one reverted. */
  revertOf: z.number().int().nullable(),
  /** Set when a later publish reverted this one. */
  revertedBy: z.number().int().nullable(),
  createdAt: Timestamp,
});
export type PortalPublishSummary = z.infer<typeof PortalPublishSummary>;

export const PortalPublish = PortalPublishSummary.extend({
  items: z.array(PortalPublishItem),
  jobs: z.array(PortalPublishJob),
});
export type PortalPublish = z.infer<typeof PortalPublish>;

export const PortalRevertRequest = z.object({
  /** Item keys (`<kind>:<id>`) to revert; omitted = the whole publish. */
  keys: z.array(z.string()).optional(),
  note: z.string().trim().max(500).nullable().optional(),
});

export const PortalPreviewRequest = z.object({ path: PortalPath });
export const PortalPreviewLink = z.object({ url: z.url(), expiresAt: Timestamp });

// ---------------------------------------------------------------------------
// Overview (design 10.1) and import report (10.16)

export const PortalOverview = z.object({
  publishedUrlCount: z.number().int(),
  publishedDocCount: z.number().int(),
  publishedPostCount: z.number().int(),
  pending: z.object({
    count: z.number().int(),
    people: z.number().int(),
    oldestAt: Timestamp.nullable(),
  }),
  drafts: z.object({ docs: z.number().int(), posts: z.number().int() }),
  /** Per non-source locale: translated / total source docs of the current version. */
  translations: z.array(
    z.object({
      locale: PortalLocale,
      translated: z.number().int(),
      total: z.number().int(),
      outdated: z.number().int(),
      /** The same per top-level category. */
      sections: z.array(
        z.object({
          groupId: Id,
          title: z.string(),
          translated: z.number().int(),
          total: z.number().int(),
          outdated: z.number().int(),
        }),
      ),
    }),
  ),
  recentDrafts: z.array(
    z.object({
      kind: z.enum(['doc', 'post']),
      id: Id,
      title: z.string(),
      version: z.string().nullable(),
      locale: PortalLocale,
      updatedAt: Timestamp,
      updatedBy: UserSummary.nullable(),
    }),
  ),
  lastPublish: PortalPublishSummary.nullable(),
  lastJob: PortalPublishJob.nullable(),
  recentPublishes: z.array(PortalPublishSummary),
});
export type PortalOverview = z.infer<typeof PortalOverview>;

export const PortalImportEntry = z.object({
  type: z.enum([
    'translation',
    'mdx',
    'link',
    'image',
    'setting',
    'home',
    'skipped',
    'unsupported',
  ]),
  source: z.string(),
  action: z.string(),
  /** Doc or post id to open ("Göster"). */
  targetKind: z.enum(['doc', 'post']).nullable(),
  targetId: Id.nullable(),
});
export type PortalImportEntry = z.infer<typeof PortalImportEntry>;

export const PortalImportReport = z.object({
  id: Id,
  source: z.string(),
  startedAt: Timestamp,
  finishedAt: Timestamp,
  durationMs: z.number().int(),
  actor: UserSummary.nullable(),
  counts: z.object({
    files: z.number().int(),
    docs: z.number().int(),
    categories: z.number().int(),
    translations: z.number().int(),
    posts: z.number().int(),
    authors: z.number().int(),
    media: z.number().int(),
    mediaBytes: z.number().int(),
    warnings: z.number().int(),
    skipped: z.number().int(),
  }),
  /** Generated vs. old site URLs (design 10.16 first line). */
  urls: z.object({
    expected: z.number().int(),
    matched: z.number().int(),
    missing: z.array(z.string()),
  }),
  entries: z.array(PortalImportEntry),
});
export type PortalImportReport = z.infer<typeof PortalImportReport>;

// ---------------------------------------------------------------------------
// Public content API for the Next.js site (service token; published snapshots only)

export const PortalPublicVersion = z.object({
  name: z.string(),
  label: z.string(),
  status: PortalVersionStatus,
  showInPicker: z.boolean(),
});
export type PortalPublicVersion = z.infer<typeof PortalPublicVersion>;

export const PortalPublicSite = z.object({
  name: z.string(),
  url: z.string().nullable(),
  locales: z.array(PortalLocale),
  defaultLocale: PortalLocale,
  settings: PortalSiteSettings.omit({ revalidateUrl: true, previewUrl: true }),
  versions: z.array(PortalPublicVersion),
  navigation: PortalNavigation,
  home: PortalHome,
  /** Latest publish time; part of the cache key on the site. */
  publishedAt: Timestamp.nullable(),
  /** True when the request carried a valid preview token (drafts included). */
  preview: z.boolean(),
});
export type PortalPublicSite = z.infer<typeof PortalPublicSite>;

export interface PortalSidebarItem {
  kind: 'doc' | 'category';
  label: string;
  /** Doc slug, or the category's generated-index slug / linked doc slug. */
  slug: string | null;
  /** Doc slug used for "same page in another version". */
  docSlug?: string | null;
  collapsed?: boolean;
  items?: PortalSidebarItem[];
}
export const PortalSidebarItem: z.ZodType<PortalSidebarItem> = z.lazy(() =>
  z.object({
    kind: z.enum(['doc', 'category']),
    label: z.string(),
    slug: z.string().nullable(),
    docSlug: z.string().nullable().optional(),
    collapsed: z.boolean().optional(),
    items: z.array(PortalSidebarItem).optional(),
  }),
);

export const PortalPublicDocsQuery = z.object({ version: z.string(), locale: PortalLocale });
export const PortalPublicSidebar = z.object({ items: z.array(PortalSidebarItem) });

export const PortalPublicPageQuery = PortalPublicDocsQuery.extend({
  /** Doc slug or `category/<slug>`. */
  slug: z.string().min(1).max(500),
});

export const PortalHeading = z.object({
  id: z.string(),
  text: z.string(),
  level: z.number().int(),
});
export type PortalHeading = z.infer<typeof PortalHeading>;

const PageLink = z.object({ title: z.string(), slug: z.string() }).nullable();

export const PortalPublicDocPage = z.object({
  kind: z.literal('doc'),
  title: z.string(),
  description: z.string().nullable(),
  slug: z.string(),
  version: z.string(),
  /** Locale of the content; differs from the requested one when untranslated. */
  contentLocale: PortalLocale,
  translation: PortalTranslationState,
  /** Published Docusaurus-compatible markdown, without front matter. */
  markdown: z.string(),
  headings: z.array(PortalHeading),
  breadcrumbs: z.array(z.object({ label: z.string(), slug: z.string().nullable() })),
  previous: PageLink,
  next: PageLink,
  /** Locales with their own published translation. */
  alternates: z.array(z.object({ locale: PortalLocale, slug: z.string() })),
  /** The same slug in other public versions. */
  versions: z.array(z.object({ version: z.string(), slug: z.string() })),
  seo: PortalSeo,
  frontMatter: z.record(z.string(), z.unknown()),
  publishedAt: Timestamp.nullable(),
  updatedAt: Timestamp,
});
export type PortalPublicDocPage = z.infer<typeof PortalPublicDocPage>;

export const PortalPublicCategoryPage = z.object({
  kind: z.literal('category'),
  title: z.string(),
  description: z.string().nullable(),
  slug: z.string(),
  version: z.string(),
  contentLocale: PortalLocale,
  items: z.array(
    z.object({
      kind: PortalDocKind,
      title: z.string(),
      description: z.string().nullable(),
      slug: z.string().nullable(),
    }),
  ),
  breadcrumbs: z.array(z.object({ label: z.string(), slug: z.string().nullable() })),
  previous: PageLink,
  next: PageLink,
  versions: z.array(z.object({ version: z.string(), slug: z.string() })),
});
export type PortalPublicCategoryPage = z.infer<typeof PortalPublicCategoryPage>;

export const PortalPublicPage = z.discriminatedUnion('kind', [
  PortalPublicDocPage,
  PortalPublicCategoryPage,
]);
export type PortalPublicPage = z.infer<typeof PortalPublicPage>;

/** Every public page, for sitemap.xml, hreflang and the URL comparison. */
export const PortalPublicPath = z.object({
  path: z.string(),
  locale: PortalLocale,
  kind: z.enum(['home', 'doc', 'category', 'post', 'blog', 'tag', 'page']),
  updatedAt: Timestamp.nullable(),
  /** Same page in other locales, by locale. */
  alternates: z.record(z.string(), z.string()),
  /** Not indexable (next version, noindex); left out of sitemap.xml. */
  noindex: z.boolean(),
});
export type PortalPublicPath = z.infer<typeof PortalPublicPath>;

export const PortalPublicAuthor = z.object({
  key: z.string(),
  name: z.string(),
  title: z.string().nullable(),
  url: z.string().nullable(),
  imageUrl: z.string().nullable(),
});
export type PortalPublicAuthor = z.infer<typeof PortalPublicAuthor>;

export const PortalPublicPostSummary = z.object({
  slug: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  date: Timestamp,
  /** Locale of the content; differs from the requested one when untranslated. */
  contentLocale: PortalLocale,
  authors: z.array(PortalPublicAuthor),
  tags: z.array(z.string()),
  readingMinutes: z.number().int(),
  cover: z.string().nullable(),
  /** Markdown up to the truncate marker (list pages, RSS). */
  excerpt: z.string(),
  /** Whether there is more after the excerpt ("Read more"). */
  truncated: z.boolean(),
});
export type PortalPublicPostSummary = z.infer<typeof PortalPublicPostSummary>;

export const PortalPublicPostsQuery = z.object({
  locale: PortalLocale,
  tag: z.string().optional(),
  author: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  /** 0 = all (sidebar, feeds). */
  pageSize: z.coerce.number().int().min(0).max(100).default(10),
});
export const PortalPublicPosts = z.object({
  items: z.array(PortalPublicPostSummary),
  total: z.number().int(),
  pages: z.number().int(),
});

export const PortalPublicPostQuery = z.object({ locale: PortalLocale, slug: z.string() });
export const PortalPublicPost = PortalPublicPostSummary.extend({
  markdown: z.string(),
  headings: z.array(PortalHeading),
  newer: PageLink,
  older: PageLink,
  seo: PortalSeo,
  alternates: z.array(z.object({ locale: PortalLocale, slug: z.string() })),
  updatedAt: Timestamp,
});
export type PortalPublicPost = z.infer<typeof PortalPublicPost>;

export const PortalPublicTags = z.object({
  items: z.array(z.object({ tag: z.string(), count: z.number().int() })),
});

export const PortalPublicRedirectQuery = z.object({ path: z.string().min(1).max(500) });
export const PortalPublicRedirectTarget = z.object({
  to: z.string(),
  code: z.union([z.literal(301), z.literal(308)]),
});

export const PortalSearchQuery = z.object({
  q: z.string().trim().min(1).max(200),
  locale: PortalLocale.optional(),
  version: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(8),
});
export const PortalSearchHit = z.object({
  kind: z.enum(['doc', 'post']),
  title: z.string(),
  /** Site path, e.g. /tr/docs/1.0.1/... */
  path: z.string(),
  /** Category or "Blog". */
  section: z.string().nullable(),
  /** Text around the match; matches wrapped in <mark>…</mark> (only tag in it). */
  snippet: z.string(),
  locale: PortalLocale,
  version: z.string().nullable(),
});
export type PortalSearchHit = z.infer<typeof PortalSearchHit>;

/** Body the worker POSTs to the site's /api/revalidate (HMAC-SHA256 in X-Portal-Signature). */
export const PortalRevalidatePayload = z.object({
  site: z.string(),
  publish: z.number().int().nullable(),
  paths: z.array(z.string()),
  tags: z.array(z.string()),
  /** Unix ms; the site rejects stale or replayed calls (± 5 min). */
  ts: z.number().int(),
});
export type PortalRevalidatePayload = z.infer<typeof PortalRevalidatePayload>;

// Inferred types of the remaining schemas.
export type PortalVersionName = z.infer<typeof PortalVersionName>;
export type PortalDocSlug = z.infer<typeof PortalDocSlug>;
export type PortalPostSlug = z.infer<typeof PortalPostSlug>;
export type PortalPath = z.infer<typeof PortalPath>;
export type PortalLogo = z.infer<typeof PortalLogo>;
export type PortalSiteStatus = z.infer<typeof PortalSiteStatus>;
export type PortalToken = z.infer<typeof PortalToken>;
export type PortalRevalidateTest = z.infer<typeof PortalRevalidateTest>;
export type UpdatePortalVersion = z.infer<typeof UpdatePortalVersion>;
export type PortalVersionDiffQuery = z.infer<typeof PortalVersionDiffQuery>;
export type PortalTreeQuery = z.infer<typeof PortalTreeQuery>;
export type PortalCategoryLink = z.infer<typeof PortalCategoryLink>;
export type PortalMarkdown = z.infer<typeof PortalMarkdown>;
export type PortalPostListQuery = z.infer<typeof PortalPostListQuery>;
export type PortalHomeSectionType = z.infer<typeof PortalHomeSectionType>;
export type PortalProject = z.infer<typeof PortalProject>;
export type PortalNavItemKind = z.infer<typeof PortalNavItemKind>;
export type PortalFooterLink = z.infer<typeof PortalFooterLink>;
export type PortalHomeState = z.infer<typeof PortalHomeState>;
export type PortalNavigationState = z.infer<typeof PortalNavigationState>;
export type PortalMediaUsage = z.infer<typeof PortalMediaUsage>;
export type PortalMediaQuery = z.infer<typeof PortalMediaQuery>;
export type CreatePortalMedia = z.infer<typeof CreatePortalMedia>;
export type PortalMediaUpload = z.infer<typeof PortalMediaUpload>;
export type UpdatePortalMedia = z.infer<typeof UpdatePortalMedia>;
export type CreatePortalRedirect = z.infer<typeof CreatePortalRedirect>;
export type PortalPublishItem = z.infer<typeof PortalPublishItem>;
export type PortalPublishStatus = z.infer<typeof PortalPublishStatus>;
export type PortalRevertRequest = z.infer<typeof PortalRevertRequest>;
export type PortalPreviewRequest = z.infer<typeof PortalPreviewRequest>;
export type PortalPreviewLink = z.infer<typeof PortalPreviewLink>;
export type PortalPublicDocsQuery = z.infer<typeof PortalPublicDocsQuery>;
export type PortalPublicSidebar = z.infer<typeof PortalPublicSidebar>;
export type PortalPublicPageQuery = z.infer<typeof PortalPublicPageQuery>;
export type PortalPublicPostsQuery = z.infer<typeof PortalPublicPostsQuery>;
export type PortalPublicPosts = z.infer<typeof PortalPublicPosts>;
export type PortalPublicPostQuery = z.infer<typeof PortalPublicPostQuery>;
export type PortalPublicTags = z.infer<typeof PortalPublicTags>;
export type PortalPublicRedirectQuery = z.infer<typeof PortalPublicRedirectQuery>;
export type PortalPublicRedirectTarget = z.infer<typeof PortalPublicRedirectTarget>;
export type PortalSearchQuery = z.infer<typeof PortalSearchQuery>;
