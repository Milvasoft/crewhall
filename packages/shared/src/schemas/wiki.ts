import { z } from 'zod';
import { Id, Timestamp } from './common';
import { Breadcrumb, NodeName, NodeType, VersionSource } from './drive';
import { UserSummary } from './org';
import { SpaceColor, SpaceRole } from './space';

/**
 * Wiki / Sayfalar (design 05, mobile 14.13-14.15; doc 17 §4 pages, comments, page_refs,
 * node_versions; §6 "Ortak düzenleme").
 *
 * A page is a node of type `page` (the Drive tree: move, trash, favorite and share use the
 * Drive endpoints). Its body is a Yjs document named `page:<nodeId>` edited over the collab
 * server (Hocuspocus); clients get a short-lived token from `createCollabToken`. The Yjs
 * document is the source of truth: markdown, search text and backlinks are derived from it
 * by the worker and are read-only for clients.
 *
 * Body format inside the Yjs doc: a Y.XmlFragment named `default` holding ProseMirror nodes
 * (Tiptap / y-prosemirror). Node names follow packages/editor (model.ts); the wiki adds
 * `toggle`, `embed`, `mention` and `pageLink`.
 */

/** Notifications of the pages module (Notification.type). */
export const PAGE_NOTIFICATION_TYPES = [
  'page.mention',
  'page.comment_mention',
  'page.comment_reply',
  /** Someone restored an older version over what these people wrote. */
  'page.restored',
  /** A page the person follows changed (`wiki.follow`). */
  'page.updated',
  /** A page export the person asked for is ready. */
  'page.export_ready',
] as const;
export type PageNotificationType = (typeof PAGE_NOTIFICATION_TYPES)[number];

/** Yjs document name of a page on the collab server. */
export const pageDocumentName = (nodeId: string) => `page:${nodeId}`;
/** Parses `page:<uuid>`; null for any other document. */
export function parsePageDocumentName(name: string): string | null {
  const m = /^page:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(name);
  return m ? m[1]!.toLowerCase() : null;
}
/** Y.XmlFragment field holding the ProseMirror document (Tiptap Collaboration default). */
export const PAGE_FRAGMENT = 'default';
/** Lifetime of a collab token; providers fetch a new one on every (re)connect. */
export const COLLAB_TOKEN_TTL_SECONDS = 600;
/** During active editing a version is kept at most every this many minutes (doc 17 §6). */
export const PAGE_VERSION_INTERVAL_MINUTES = 10;
/** Markdown size limit for import, templates and MCP writes (doc 17 §13). */
export const PAGE_MARKDOWN_MAX = 200_000;
/** Untitled pages left without content are removed after this long (design 5.14). */
export const EMPTY_PAGE_TTL_MINUTES = 10;

/**
 * Web path of a page: `/p/{slug}-{id}`. The slug follows the title; old slugs still resolve
 * because only the trailing id is read (design 05 "Kalıcı linkler").
 */
export function pageSlug(name: string): string {
  const map: Record<string, string> = { ç: 'c', ğ: 'g', ı: 'i', İ: 'i', ö: 'o', ş: 's', ü: 'u' };
  const s = name
    .replace(/[çğıİöşü]/gi, (ch) => map[ch] ?? map[ch.toLowerCase()] ?? ch)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return s || 'sayfa';
}
export const pagePath = (page: { id: string; name: string }) =>
  `/p/${pageSlug(page.name)}-${page.id}`;
/** Node id at the end of `/p/{slug}-{id}` (or a bare id); null when there is none. */
export function pageIdFromRef(ref: string): string | null {
  const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(ref);
  return m ? m[1]!.toLowerCase() : null;
}

/** Markers around the matched words in search snippets (private-use characters, never HTML). */
export const SNIPPET_MARK_START = '\uE000';
export const SNIPPET_MARK_END = '\uE001';

/** Emoji or short text shown before the title. */
export const PageIcon = z.string().trim().min(1).max(16);
/**
 * Cover: `preset:<name>` (a built-in gradient, design 5.14) or `node:<fileNodeId>` (an image
 * file of the same space, loaded through getPreview / getDownloadUrl).
 */
export const PageCover = z
  .string()
  .regex(/^(preset:[a-z0-9-]{1,32}|node:[0-9a-f-]{36})$/i, 'preset:<name> or node:<id>');

export const PageRefKind = z.enum(['link', 'mention', 'embed']);
export type PageRefKind = z.infer<typeof PageRefKind>;

/** One page in the sidebar tree (pages only; folders between pages are skipped). */
export const PageTreeItem = z.object({
  id: Id,
  /** Nearest page ancestor; null at the top of the tree. */
  parentId: Id.nullable(),
  name: z.string(),
  icon: z.string().nullable(),
  /** Fractional order among siblings (compare as strings). */
  position: z.string(),
  hasChildren: z.boolean(),
  myRole: SpaceRole,
  favorite: z.boolean(),
  updatedAt: Timestamp,
});
export type PageTreeItem = z.infer<typeof PageTreeItem>;

export const PageTree = z.object({
  items: z.array(PageTreeItem),
  /** The caller may add pages at the root of this space. */
  canCreate: z.boolean(),
});

export const Page = z.object({
  id: Id,
  spaceId: Id,
  /** Drive parent (a page or a folder). */
  parentId: Id.nullable(),
  name: z.string(),
  icon: z.string().nullable(),
  cover: z.string().nullable(),
  /** @deprecated Not read since API level 7: full width is the person's `UiPrefs.pagesFullWidth`. */
  fullWidth: z.boolean(),
  smallText: z.boolean(),
  /** "Sayfayı kilitle": nobody writes the body until unlocked (editors may unlock). */
  locked: z.boolean(),
  /** No content yet: the empty-page shortcuts show and the page may be auto-removed. */
  empty: z.boolean(),
  myRole: SpaceRole,
  /** Caller may type in the body (role ≥ editor and the page is not locked). */
  canEdit: z.boolean(),
  canComment: z.boolean(),
  favorite: z.boolean(),
  /** The caller is told when this page changes. Absent on older servers. */
  following: z.boolean().optional(),
  /**
   * With `following`: changes to its sub-pages are told as well (capability
   * `wiki.followDescendants`). Absent on older servers.
   */
  followingDescendants: z.boolean().optional(),
  shared: z.boolean(),
  wordCount: z.number().int(),
  readingMinutes: z.number().int(),
  openCommentCount: z.number().int(),
  /** Last body edit (from collab), else the node's own times. */
  editedAt: Timestamp,
  editedBy: UserSummary.nullable(),
  lastSource: VersionSource.nullable(),
  createdBy: UserSummary.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  deletedAt: Timestamp.nullable(),
  /** From the space root to the parent. */
  path: Breadcrumb,
  space: z.object({ id: Id, name: z.string(), slug: z.string(), color: SpaceColor }),
});
export type Page = z.infer<typeof Page>;

export const CreatePage = z.object({
  /** A page or folder of the space; null = space root. */
  parentId: Id.nullable().default(null),
  /** "Başlıksız" in the caller's language; a clash in the folder gets " (2)". */
  name: NodeName,
  icon: PageIcon.nullable().optional(),
  /** Template to copy (`listPageTemplates` id); placeholders «tarih», «yazar» are filled. */
  templateId: z.string().min(1).max(80).optional(),
  /** Initial body as markdown (import, MCP); ignored with templateId. */
  markdown: z.string().max(PAGE_MARKDOWN_MAX).optional(),
  /** Place after / before a sibling (manual order). */
  afterId: Id.nullable().optional(),
  beforeId: Id.nullable().optional(),
});

/** Markdown added at the end of a page (web clipper). */
export const AppendPage = z.object({
  markdown: z.string().trim().min(1).max(PAGE_MARKDOWN_MAX),
});
export type AppendPage = z.infer<typeof AppendPage>;

export const UpdatePage = z.object({
  name: NodeName.optional(),
  icon: PageIcon.nullable().optional(),
  cover: PageCover.nullable().optional(),
  /** @deprecated Ignored by clients since API level 7 (`UiPrefs.pagesFullWidth`). */
  fullWidth: z.boolean().optional(),
  smallText: z.boolean().optional(),
  locked: z.boolean().optional(),
});

/**
 * Sidebar drag and drop (design 5.1): a new place in the same space. With `afterId` /
 * `beforeId` the page goes next to that sibling (in the sibling's own folder or page);
 * otherwise it goes last under `parentId` (a page or folder; null = space root). A clashing
 * name gets " (2)" as on create.
 */
export const MovePage = z.object({
  parentId: Id.nullable().optional(),
  afterId: Id.nullable().optional(),
  beforeId: Id.nullable().optional(),
});

export const DuplicatePage = z.object({
  /** Defaults to "<name> (kopya)" chosen by the client. */
  name: NodeName,
});

export const PageContentQuery = z.object({
  format: z.enum(['markdown', 'json']).default('markdown'),
});
/** Current body, derived on read from the stored Yjs state (mobile preview, export). */
/**
 * Ticks a to-do of a page from outside the editor (a card on the home page). `index` is its place
 * among the page's to-dos in document order; `text` must still be its text, so a tick never lands
 * on another item after the page changed.
 */
export const SetPageTask = z.object({
  index: z.number().int().min(0),
  text: z.string().max(10_000),
  checked: z.boolean(),
});
export type SetPageTask = z.infer<typeof SetPageTask>;

/** "Takip et": the person's own choice, not a change to the page. */
export const SetPageFollow = z.object({
  following: z.boolean(),
  /**
   * Also hear about the page's sub-pages, at any depth. Omitted: unchanged while following
   * (older clients keep what was chosen elsewhere); stopping to follow clears it.
   */
  descendants: z.boolean().optional(),
});
export type SetPageFollow = z.infer<typeof SetPageFollow>;

export const PageContent = z.object({
  markdown: z.string(),
  /** ProseMirror JSON (format=json). */
  doc: z.unknown().optional(),
  updatedAt: Timestamp,
});

/** A node of a public link (the shared node itself when `nodeId` is omitted). */
export const PublicViewQuery = z.object({
  /** From unlockPublicShare, for password links. */
  grant: z.string().optional(),
  nodeId: Id.optional(),
});

/**
 * A page opened from a public link (H15): read-only, the body as stored. Drive files the body
 * shows as `node:<fileId>` (imported images, attachments) come with URLs valid for a few
 * minutes: images always, other files only when the link allows downloads.
 */
export const PublicPage = z.object({
  id: Id,
  name: z.string(),
  icon: z.string().nullable(),
  /** `preset:<name>`, or a URL when the cover is a Drive image; null = none. */
  cover: z.string().nullable(),
  fullWidth: z.boolean(),
  smallText: z.boolean(),
  /** ProseMirror JSON of the body. */
  doc: z.unknown(),
  /** `<fileId>` → URL for each `node:<fileId>` of the body that may be shown. */
  files: z.record(z.string(), z.string()),
  updatedAt: Timestamp,
});
export type PublicPage = z.infer<typeof PublicPage>;

export const PageCollabTokenRequest = z.object({
  /** Shown on the versions this connection produces. */
  source: z.enum(['web', 'mobile']).default('web'),
});
export const PageCollabToken = z.object({
  token: z.string(),
  /**
   * WebSocket URL of the collab server (Hocuspocus). For `source: 'web'` it may be a path
   * (`/collab`) on the hub's origin; resolve it with `resolveCollabUrl`.
   */
  url: z.string(),
  documentName: z.string(),
  expiresAt: Timestamp,
  /** Viewers and locked pages connect read-only; the server enforces it. */
  readOnly: z.boolean(),
});
export type PageCollabToken = z.infer<typeof PageCollabToken>;

/**
 * A collab token's `url` as a WebSocket URL (B12). A path resolves against `base`, the page's
 * address in a browser (or the server address of a native client): http → ws, https → wss.
 * Full URLs and an empty value (no collab server) come back unchanged.
 */
export function resolveCollabUrl(url: string, base: string): string {
  if (!url.startsWith('/')) return url;
  // String parsing: this package also runs where `URL` has no types (no DOM or Node lib).
  const m = /^(https?|wss?):\/\/([^/?#]+)/i.exec(base);
  if (!m) return url;
  const secure = /^(https|wss)$/i.test(m[1]!);
  return `${secure ? 'wss' : 'ws'}://${m[2]!}${url}`;
}

/* ---------------------------------- versions ---------------------------------- */

export const PageVersion = z.object({
  id: Id,
  version: z.number().int(),
  /** Named versions are never pruned (design 5.10). */
  label: z.string().nullable(),
  source: VersionSource,
  createdBy: UserSummary.nullable(),
  /** Everyone who edited since the previous version. */
  editors: z.array(UserSummary),
  /** Version number this one restored, when made by "Bu sürüme geri dön". */
  restoredFrom: z.number().int().nullable(),
  /** The newest version. */
  current: z.boolean(),
  createdAt: Timestamp,
});
export type PageVersion = z.infer<typeof PageVersion>;

export const PageVersionDetail = PageVersion.extend({
  markdown: z.string(),
  /** ProseMirror JSON of this version, for the read-only view. */
  doc: z.unknown(),
  /** The version before it (null for the first), for the diff. */
  previous: z
    .object({ id: Id, version: z.number().int(), markdown: z.string(), doc: z.unknown() })
    .nullable(),
});
export type PageVersionDetail = z.infer<typeof PageVersionDetail>;

export const SavePageVersion = z.object({
  label: z.string().trim().min(1).max(120).nullable().optional(),
});
export const UpdatePageVersion = z.object({
  label: z.string().trim().min(1).max(120).nullable(),
});

/* ---------------------------------- comments ---------------------------------- */

/** base64 of `Y.encodeRelativePosition` against the page fragment. */
const RelPos = z
  .string()
  .max(2048)
  .regex(/^[A-Za-z0-9+/=_-]+$/);

export const PageComment = z.object({
  id: Id,
  author: UserSummary.nullable(),
  body: z.string(),
  /** People mentioned with @ (they get a notification). */
  mentions: z.array(Id),
  createdAt: Timestamp,
  editedAt: Timestamp.nullable(),
});
export type PageComment = z.infer<typeof PageComment>;

/** A thread: the root comment's anchor plus every reply in order. */
export const CommentThread = z.object({
  id: Id,
  nodeId: Id,
  /** Yjs relative positions of the commented range; null = "Sayfa geneli". */
  anchorStart: z.string().nullable(),
  anchorEnd: z.string().nullable(),
  /** The commented text when the thread was opened (shown if the range is gone). */
  quote: z.string().nullable(),
  resolvedAt: Timestamp.nullable(),
  resolvedBy: UserSummary.nullable(),
  comments: z.array(PageComment),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type CommentThread = z.infer<typeof CommentThread>;

export const ListCommentsQuery = z.object({
  status: z.enum(['open', 'resolved', 'all']).default('all'),
});

export const CreateComment = z
  .object({
    body: z.string().trim().min(1).max(10_000),
    /** Reply to this thread; omit to open a new thread. */
    threadId: Id.optional(),
    anchorStart: RelPos.optional(),
    anchorEnd: RelPos.optional(),
    quote: z.string().max(500).optional(),
    mentions: z.array(Id).max(50).default([]),
  })
  .refine((v) => !v.threadId || (!v.anchorStart && !v.anchorEnd), {
    message: 'replies have no anchor',
  })
  .refine((v) => !v.anchorStart === !v.anchorEnd, {
    message: 'anchorStart and anchorEnd go together',
  });

export const UpdateComment = z.object({
  body: z.string().trim().min(1).max(10_000),
  mentions: z.array(Id).max(50).default([]),
});
export const ResolveThread = z.object({ resolved: z.boolean() });

/* ------------------------------ backlinks, export ------------------------------ */

export const Backlink = z.object({
  node: z.object({
    id: Id,
    name: z.string(),
    type: NodeType,
    icon: z.string().nullable(),
    spaceId: Id,
  }),
  kinds: z.array(PageRefKind),
  updatedAt: Timestamp,
});
export type Backlink = z.infer<typeof Backlink>;

export const ExportPageQuery = z.object({
  /** Child pages too, each as its own file under the page's folder. */
  children: z.stringbool().default(false),
});
export const PageExport = z.object({
  /** Relative paths: `Mimari.md`, `Mimari/Kilit stratejisi.md`… */
  files: z.array(z.object({ path: z.string(), markdown: z.string() })),
});

export const ImportPages = z.object({
  /** Page or folder to import under; null = space root. */
  parentId: Id.nullable().default(null),
  /**
   * Markdown files with their relative paths (`Ops/Yedekleme.md`). Folders become parent
   * pages; a file and a folder of the same name merge (`Ops.md` + `Ops/…`). A link from one
   * file to another (`Yedekleme.md`, `../Ops.md`, `/Ops/Yedekleme.md`) becomes a page link.
   */
  files: z
    .array(
      z.object({
        path: z.string().min(1).max(500),
        content: z.string().max(PAGE_MARKDOWN_MAX),
      }),
    )
    .min(1)
    .max(200),
});
/* ------------------------------- export (roadmap 6) ------------------------------- */

export const PageExportFormat = z.enum(['md', 'html', 'docx', 'pdf']);
export type PageExportFormat = z.infer<typeof PageExportFormat>;

export const CreatePageExport = z.object({
  format: PageExportFormat,
  /** The page's sub-pages too (only those the person can open): one ZIP with a folder tree. */
  children: z.boolean().default(false),
});

/**
 * One export, built by the worker. A single page without attachments is one file; sub-pages
 * or attached files make a ZIP (`ekler/` next to the pages, links between exported pages
 * point at each other's files). The file is kept for 7 days and only its creator downloads
 * it (PAGE_EXPORT_RAW_PATHS.download).
 */
export const PageExportJob = z.object({
  id: Id,
  nodeId: Id,
  format: PageExportFormat,
  children: z.boolean(),
  status: z.enum(['queued', 'running', 'ready', 'failed']),
  fileName: z.string().nullable(),
  sizeBytes: z.number().int().nullable(),
  pageCount: z.number().int().nullable(),
  /** Attached files left out (too large or unreadable), by name. */
  skipped: z.array(z.string()),
  /** Error code when failed. */
  error: z.string().nullable(),
  createdAt: Timestamp,
  finishedAt: Timestamp.nullable(),
  expiresAt: Timestamp.nullable(),
});
export type PageExportJob = z.infer<typeof PageExportJob>;

/** Outside the endpoint table: a 302 to the file (session cookie, creator only). */
export const PAGE_EXPORT_RAW_PATHS = {
  download: '/api/v1/page-exports/:exportId/download',
} as const;

export const ImportResult = z.object({
  pages: z.array(PageTreeItem),
  /** Files skipped or changed during import (design 5.15 report). */
  warnings: z.array(
    z.object({ path: z.string(), code: z.enum(['empty', 'too_large', 'duplicate']) }),
  ),
});

/* ----------------------------------- search ----------------------------------- */

export const SearchPagesQuery = z.object({
  q: z.string().trim().min(1).max(200),
  spaceId: Id.optional(),
  /** "Yorumlarda da ara" (design 5.18). */
  comments: z.stringbool().default(true),
  /** Only pages edited in the last N days. */
  days: z.coerce.number().int().min(1).max(3650).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export const PageSearchHit = z.object({
  node: z.object({ id: Id, name: z.string(), icon: z.string().nullable() }),
  space: z.object({ id: Id, name: z.string(), slug: z.string(), color: SpaceColor }),
  /** Ancestor names, "Milvaion / Mimari". */
  path: z.string(),
  matchedIn: z.enum(['title', 'body', 'comment']),
  /** Excerpt with matches between SNIPPET_MARK_START / SNIPPET_MARK_END. */
  snippet: z.string(),
  /** Comment hits: the comment author. */
  author: UserSummary.nullable(),
  updatedAt: Timestamp,
  updatedBy: UserSummary.nullable(),
});
export type PageSearchHit = z.infer<typeof PageSearchHit>;

/* ---------------------------------- templates --------------------------------- */

export const PageTemplateScope = z.enum(['builtin', 'space', 'personal']);
export const PageTemplate = z.object({
  /** `builtin:<key>` or the template's uuid. */
  id: z.string(),
  scope: PageTemplateScope,
  spaceId: Id.nullable(),
  name: z.string(),
  description: z.string(),
  /** Gallery filter (design 5.13): team, engineering, product… or free text. */
  category: z.string(),
  blockCount: z.number().int(),
  /** First blocks as markdown, for the preview. */
  preview: z.string(),
  createdBy: UserSummary.nullable(),
});
export type PageTemplate = z.infer<typeof PageTemplate>;

export const ListTemplatesQuery = z.object({ spaceId: Id.optional() });

export const CreatePageTemplate = z.object({
  /** Page whose current body becomes the template. */
  nodeId: Id,
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(300).default(''),
  category: z.string().trim().min(1).max(40).default('team'),
  /** Space templates need space admin or owner (design 5.13). */
  scope: z.enum(['space', 'personal']),
});
