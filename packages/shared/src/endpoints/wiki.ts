import { def, Empty, items, type EndpointDef } from '../endpoint-def';
import { page } from '../schemas/common';
import {
  Backlink,
  PageCollabToken,
  PageCollabTokenRequest,
  CommentThread,
  CreateComment,
  AppendPage,
  CreatePage,
  CreatePageTemplate,
  DuplicatePage,
  ExportPageQuery,
  ImportPages,
  ImportResult,
  ListCommentsQuery,
  ListTemplatesQuery,
  MovePage,
  CreatePageExport,
  PageExportJob,
  PublicPage,
  PublicViewQuery,
  Page,
  PageContent,
  PageContentQuery,
  PageExport,
  PageSearchHit,
  PageTemplate,
  PageTree,
  PageVersion,
  PageVersionDetail,
  ResolveThread,
  SavePageVersion,
  SearchPagesQuery,
  UpdateComment,
  UpdatePage,
  UpdatePageVersion,
  SetPageFollow,
  SetPageTask,
} from '../schemas/wiki';

/**
 * Wiki module contract (design 05, mobile 14.13-14.15; doc 17 §4, §6).
 * Only the wiki session edits this file; see docs/contracts/moduller.md.
 *
 * Pages are Drive nodes: move, trash, restore, favorite and share use the core node
 * endpoints. The body is edited over the collab server with `createCollabToken`; these
 * endpoints cover the page's metadata, versions, comments, backlinks, import / export,
 * full-text search and templates.
 */
export const wikiEndpoints = {
  /** Every page of a space the caller can see, for the sidebar tree (design 5.1). */
  listPageTree: def({
    method: 'GET',
    path: '/api/v1/spaces/:spaceId/pages',
    auth: 'session',
    response: PageTree,
  }),
  /** New page (design 5.14), optionally from a template or markdown. */
  createPage: def({
    method: 'POST',
    path: '/api/v1/spaces/:spaceId/pages',
    auth: 'session',
    body: CreatePage,
    response: Page,
  }),
  /** Markdown at the end of a page the caller may edit; open editors get it live. */
  appendPage: def({
    method: 'POST',
    path: '/api/v1/pages/:nodeId/append',
    auth: 'session',
    body: AppendPage,
    response: Empty,
  }),
  /** Markdown / folder import (design 5.15); runs inline, at most 200 files. */
  importPages: def({
    method: 'POST',
    path: '/api/v1/spaces/:spaceId/pages/import',
    auth: 'session',
    body: ImportPages,
    response: ImportResult,
  }),
  getPage: def({
    method: 'GET',
    path: '/api/v1/pages/:nodeId',
    auth: 'session',
    response: Page,
  }),
  /** Title, icon, cover, full width, small text, lock. Rename keeps the old URL working. */
  updatePage: def({
    method: 'PATCH',
    path: '/api/v1/pages/:nodeId',
    auth: 'session',
    body: UpdatePage,
    response: Page,
  }),
  /** Public link (H15): a shared page, or a page inside a shared folder, read-only. */
  getPublicPage: def({
    method: 'GET',
    path: '/api/v1/public/shares/:token/page',
    auth: 'public',
    query: PublicViewQuery,
    response: PublicPage,
  }),
  /** Drag and drop in the page tree: another parent and/or another place among siblings. */
  movePage: def({
    method: 'POST',
    path: '/api/v1/pages/:nodeId/move',
    auth: 'session',
    body: MovePage,
    response: Page,
  }),
  /** Copy next to the original with its body (child pages are not copied). */
  duplicatePage: def({
    method: 'POST',
    path: '/api/v1/pages/:nodeId/duplicate',
    auth: 'session',
    body: DuplicatePage,
    response: Page,
  }),
  getPageContent: def({
    method: 'GET',
    path: '/api/v1/pages/:nodeId/content',
    auth: 'session',
    query: PageContentQuery,
    response: PageContent,
  }),
  /** Ticks one to-do; open editors see it at once. Conflict: `page_task_changed`. */
  setPageTask: def({
    method: 'POST',
    path: '/api/v1/pages/:nodeId/tasks',
    auth: 'session',
    body: SetPageTask,
    response: Empty,
  }),
  /** Whether the caller is told when this page changes (`page.updated`). */
  setPageFollow: def({
    method: 'POST',
    path: '/api/v1/pages/:nodeId/follow',
    auth: 'session',
    body: SetPageFollow,
    response: Empty,
  }),
  /**
   * Short-lived token for `page:<nodeId>` on the collab server (doc 17 §3); call again on
   * every reconnect. Viewers get readOnly: true.
   */
  createCollabToken: def({
    method: 'POST',
    path: '/api/v1/pages/:nodeId/collab-token',
    auth: 'session',
    body: PageCollabTokenRequest,
    response: PageCollabToken,
  }),

  // Versions (design 5.10)
  listPageVersions: def({
    method: 'GET',
    path: '/api/v1/pages/:nodeId/versions',
    auth: 'session',
    response: items(PageVersion),
  }),
  /** "Sürüm kaydet" / "Şu anki sürümü adlandır": snapshot the current state now. */
  savePageVersion: def({
    method: 'POST',
    path: '/api/v1/pages/:nodeId/versions',
    auth: 'session',
    body: SavePageVersion,
    response: PageVersion,
  }),
  getPageVersion: def({
    method: 'GET',
    path: '/api/v1/pages/:nodeId/versions/:versionId',
    auth: 'session',
    response: PageVersionDetail,
  }),
  updatePageVersion: def({
    method: 'PATCH',
    path: '/api/v1/pages/:nodeId/versions/:versionId',
    auth: 'session',
    body: UpdatePageVersion,
    response: PageVersion,
  }),
  /**
   * "Bu sürüme geri dön": keeps the current state as a version, then applies the old
   * content as a new Yjs update so open editors stay in sync. Returns the new version.
   */
  restorePageVersion: def({
    method: 'POST',
    path: '/api/v1/pages/:nodeId/versions/:versionId/restore',
    auth: 'session',
    response: PageVersion,
  }),

  // Comments (design 5.9, mobile 14.15)
  listPageComments: def({
    method: 'GET',
    path: '/api/v1/pages/:nodeId/comments',
    auth: 'session',
    query: ListCommentsQuery,
    response: items(CommentThread),
  }),
  /** New thread (with an anchor or page-wide) or a reply (threadId). Viewers may comment. */
  createPageComment: def({
    method: 'POST',
    path: '/api/v1/pages/:nodeId/comments',
    auth: 'session',
    body: CreateComment,
    response: CommentThread,
  }),
  /** Own comments only. */
  updatePageComment: def({
    method: 'PATCH',
    path: '/api/v1/page-comments/:commentId',
    auth: 'session',
    body: UpdateComment,
    response: CommentThread,
  }),
  /** Own comment, or any comment for space admins; deleting a thread's root removes it. */
  deletePageComment: def({
    method: 'DELETE',
    path: '/api/v1/page-comments/:commentId',
    auth: 'session',
    response: Empty,
  }),
  /** "Çözüldü" / reopen; `threadId` is the root comment id. */
  resolvePageThread: def({
    method: 'POST',
    path: '/api/v1/page-comments/:threadId/resolve',
    auth: 'session',
    body: ResolveThread,
    response: CommentThread,
  }),

  /** "Bu sayfaya bağlananlar": pages that link, mention or embed this one. */
  listPageBacklinks: def({
    method: 'GET',
    path: '/api/v1/pages/:nodeId/backlinks',
    auth: 'session',
    response: items(Backlink),
  }),
  /**
   * "Dışa aktar" (roadmap 6): PDF, DOCX, HTML or Markdown, alone or with sub-pages, built by
   * the worker; poll getPageExport, then download (PAGE_EXPORT_RAW_PATHS.download). A long
   * export also notifies (`page.export_ready`).
   */
  createPageExport: def({
    method: 'POST',
    path: '/api/v1/pages/:nodeId/exports',
    auth: 'session',
    body: CreatePageExport,
    response: PageExportJob,
  }),
  /** Own exports only. */
  getPageExport: def({
    method: 'GET',
    path: '/api/v1/page-exports/:exportId',
    auth: 'session',
    response: PageExportJob,
  }),
  /** Markdown export (design 5.17); the client zips several files. */
  exportPage: def({
    method: 'GET',
    path: '/api/v1/pages/:nodeId/export',
    auth: 'session',
    query: ExportPageQuery,
    response: PageExport,
  }),

  /** Full text (turkish + english stemming) over titles, bodies and comments (design 5.18). */
  searchPages: def({
    method: 'GET',
    path: '/api/v1/search/pages',
    auth: 'session',
    query: SearchPagesQuery,
    response: page(PageSearchHit),
  }),

  // Templates (design 5.13)
  listPageTemplates: def({
    method: 'GET',
    path: '/api/v1/page-templates',
    auth: 'session',
    query: ListTemplatesQuery,
    response: items(PageTemplate),
  }),
  /** "Şablon olarak kaydet". */
  createPageTemplate: def({
    method: 'POST',
    path: '/api/v1/page-templates',
    auth: 'session',
    body: CreatePageTemplate,
    response: PageTemplate,
  }),
  deletePageTemplate: def({
    method: 'DELETE',
    path: '/api/v1/page-templates/:templateId',
    auth: 'session',
    response: Empty,
  }),
} as const satisfies Record<string, EndpointDef>;
