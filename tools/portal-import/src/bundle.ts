import type {
  PortalHome,
  PortalImportEntry,
  PortalNavigation,
  PortalSiteSettings,
} from '@crewhall/shared';

/**
 * A Docusaurus site read into plain data (design 10.15 "Eşleme"). The parser produces it from
 * a checkout (no Hub access); the backend importer writes it into a portal site as drafts.
 * Paths in markdown are already rewritten: images point at `/media/...`, doc links at site
 * URLs (`/docs/<version>/<slug>`, `/blog/<slug>`).
 */
export interface ImportBundle {
  /** Where it came from, e.g. `../milva-portal @ 4f2c9e1`. */
  source: string;
  site: {
    name: string;
    locales: string[];
    defaultLocale: string;
    settings: Partial<PortalSiteSettings>;
  };
  /** Docusaurus `current` docs are this version (e.g. `1.0.1`). */
  currentVersion: string;
  versions: ImportVersion[];
  categories: ImportCategory[];
  docs: ImportDoc[];
  authors: ImportAuthor[];
  posts: ImportPost[];
  media: ImportMedia[];
  home: PortalHome | null;
  navigation: PortalNavigation | null;
  /** Report rows; `target` is the doc / post the row is about (resolved to ids on import). */
  entries: ImportEntry[];
  /** Markdown / MDX files read (docs + versioned docs + translations + posts). */
  fileCount: number;
  /** URLs the imported site will serve, site-relative (`/`, `/tr/docs/1.0.1/...`). */
  urls: string[];
}

export interface ImportVersion {
  name: string;
  label: string;
  status: 'current' | 'archived' | 'next';
  /** Shown in the version dropdown. */
  showInPicker: boolean;
}

export interface ImportCategory {
  version: string;
  locale: string;
  /** Directory below the docs root with number prefixes kept, e.g. `open-source-libs/milvaion`. */
  dir: string;
  /** Parent category `dir`; '' at the root. */
  parentDir: string;
  /** URL path of the folder (number prefixes stripped), e.g. `open-source-libs/milvaion`. */
  slug: string;
  label: string;
  position: number;
  description: string | null;
  /** `_category_.json` link: generated index page, a doc, or none. */
  link: 'generated-index' | 'doc' | 'none';
  /** generated-index: `category/milvaion-scheduler`; doc: the linked doc's slug. */
  linkSlug: string | null;
  collapsed: boolean | null;
  /**
   * `_`-prefixed folder (Docusaurus does not route it); its docs come in unlisted and its
   * generated index is not served. Optional addition of the parser; absent = false.
   */
  unlisted?: boolean;
}

export interface ImportDoc {
  version: string;
  locale: string;
  /** Repo-relative source file, e.g. `docs/open-source-libs/milvaion/02-quick-start.md`. */
  sourcePath: string;
  /** Category `dir` it sits in; '' at the root. */
  dir: string;
  /** Docusaurus doc id (front matter `id` or file name without number prefix). */
  id: string;
  /** URL path below /docs/<version>/, e.g. `open-source-libs/milvaion/quick-start`. */
  slug: string;
  title: string;
  sidebarLabel: string | null;
  position: number;
  description: string | null;
  /** Not routed or not in the sidebar (Docusaurus `_` prefix, `unlisted: true`, `draft: true`). */
  unlisted: boolean;
  /** Front matter without the fields above (keywords, tags, hide_table_of_contents, …). */
  frontMatter: Record<string, unknown>;
  /** Body markdown, front matter removed, references rewritten. */
  markdown: string;
  /** For translations: the doc of the default locale with the same `slug`, if any. */
  sameAsSource: boolean;
}

export interface ImportAuthor {
  key: string;
  name: string;
  title: string | null;
  url: string | null;
  imageUrl: string | null;
}

export interface ImportPost {
  locale: string;
  sourcePath: string;
  slug: string;
  title: string;
  description: string | null;
  /** ISO date (front matter `date` or the folder / file name date). */
  date: string;
  authorKeys: string[];
  tags: string[];
  /** Media path of the cover (`image` front matter), if any. */
  cover: string | null;
  frontMatter: Record<string, unknown>;
  markdown: string;
}

export interface ImportMedia {
  /** Public path, e.g. `/media/img/logo.svg`, `/media/docs/_img/sitemap.png`. */
  path: string;
  /** Absolute path of the file on disk. */
  file: string;
  mime: string;
  size: number;
}

export interface ImportEntry {
  type: PortalImportEntry['type'];
  /** Repo-relative path (or setting name). */
  source: string;
  action: string;
  target:
    | { kind: 'doc'; version: string; locale: string; slug: string }
    | { kind: 'post'; locale: string; slug: string }
    | null;
}
