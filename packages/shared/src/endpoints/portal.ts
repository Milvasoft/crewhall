import { z } from 'zod';
import { Empty, def, items, type EndpointDef } from '../endpoint-def';
import { PageQuery, page } from '../schemas/common';
import {
  CreatePortalDoc,
  CreatePortalMedia,
  CreatePortalPost,
  CreatePortalRedirect,
  CreatePortalSite,
  FreezePortalVersion,
  PortalAuthor,
  PortalCapabilities,
  PortalChange,
  PortalDoc,
  PortalDocFromPage,
  PortalDocFromPageResult,
  PortalHome,
  PortalHomeState,
  PortalImportReport,
  PortalMarkdown,
  PortalMedia,
  PortalMediaQuery,
  PortalMediaUpload,
  PortalNavigation,
  PortalNavigationState,
  PortalOverview,
  PortalPost,
  PortalPostListQuery,
  PortalPostSummary,
  PortalPreviewLink,
  PortalPreviewRequest,
  PortalPublicDocsQuery,
  PortalPublicPage,
  PortalPublicPageQuery,
  PortalPublicPath,
  PortalPublicAuthor,
  PortalPublicPost,
  PortalPublicPostQuery,
  PortalPublicPosts,
  PortalPublicPostsQuery,
  PortalPublicRedirectQuery,
  PortalPublicRedirectTarget,
  PortalPublicSidebar,
  PortalPublicSite,
  PortalPublicTags,
  PortalPublish,
  PortalPublishJob,
  PortalPublishPreview,
  PortalPublishRequest,
  PortalPublishSummary,
  PortalRedirect,
  PortalRevalidateTest,
  PortalRevertRequest,
  PortalSearchHit,
  PortalSearchQuery,
  PortalSite,
  PortalSiteSummary,
  PortalToken,
  PortalTreeItem,
  PortalTreeQuery,
  PortalVersion,
  PortalVersionDiff,
  PortalVersionDiffQuery,
  UpdatePortalDoc,
  UpdatePortalMedia,
  UpdatePortalPost,
  UpdatePortalSite,
  UpdatePortalVersion,
  UpsertPortalAuthor,
} from '../schemas/portal';

/**
 * Portal module contract (design 10, 11; doc 17 §4, §9). Only the portal session edits this
 * file; see docs/contracts/moduller.md.
 *
 * - `/api/v1/portal/...` is the Hub's editing API (session; `can` portal.edit / portal.publish,
 *   site settings for org admins).
 * - `/api/v1/public/portal/...` is the read-only content API of the Next.js site. These need
 *   `Authorization: Bearer <site content token>` (not a user session) and return published
 *   snapshots only; with a valid `X-Portal-Preview` token they include drafts and `next`.
 * Raw routes outside this table: `PUT /api/v1/portal/media/:mediaId/content` (upload bytes),
 * `GET /api/v1/portal/sites/:siteId/files/*` (media for editors) and
 * `GET /api/v1/public/portal/media/*` (media for the site).
 */
export const portalEndpoints = {
  // Sites and settings (10.1, 10.17)
  listPortalSites: def({
    method: 'GET',
    path: '/api/v1/portal/sites',
    auth: 'session',
    response: items(PortalSiteSummary).extend({ capabilities: PortalCapabilities }),
  }),
  createPortalSite: def({
    method: 'POST',
    path: '/api/v1/portal/sites',
    auth: 'session',
    body: CreatePortalSite,
    response: PortalSite,
  }),
  getPortalSite: def({
    method: 'GET',
    path: '/api/v1/portal/sites/:siteId',
    auth: 'session',
    response: PortalSite,
  }),
  updatePortalSite: def({
    method: 'PATCH',
    path: '/api/v1/portal/sites/:siteId',
    auth: 'session',
    body: UpdatePortalSite,
    response: PortalSite,
  }),
  rotatePortalToken: def({
    method: 'POST',
    path: '/api/v1/portal/sites/:siteId/token',
    auth: 'session',
    response: PortalToken,
  }),
  testPortalRevalidate: def({
    method: 'POST',
    path: '/api/v1/portal/sites/:siteId/revalidate-test',
    auth: 'session',
    response: PortalRevalidateTest,
  }),
  getPortalOverview: def({
    method: 'GET',
    path: '/api/v1/portal/sites/:siteId/overview',
    auth: 'session',
    response: PortalOverview,
  }),

  // Versions (10.4, 10.5)
  listPortalVersions: def({
    method: 'GET',
    path: '/api/v1/portal/sites/:siteId/versions',
    auth: 'session',
    response: items(PortalVersion),
  }),
  freezePortalVersion: def({
    method: 'POST',
    path: '/api/v1/portal/sites/:siteId/versions',
    auth: 'session',
    body: FreezePortalVersion,
    response: PortalVersion,
  }),
  updatePortalVersion: def({
    method: 'PATCH',
    path: '/api/v1/portal/versions/:versionId',
    auth: 'session',
    body: UpdatePortalVersion,
    response: PortalVersion,
  }),
  diffPortalVersions: def({
    method: 'GET',
    path: '/api/v1/portal/sites/:siteId/versions/diff',
    auth: 'session',
    query: PortalVersionDiffQuery,
    response: PortalVersionDiff,
  }),

  // Docs (10.2, 10.3)
  getPortalDocTree: def({
    method: 'GET',
    path: '/api/v1/portal/sites/:siteId/docs',
    auth: 'session',
    query: PortalTreeQuery,
    response: items(PortalTreeItem),
  }),
  createPortalDoc: def({
    method: 'POST',
    path: '/api/v1/portal/sites/:siteId/docs',
    auth: 'session',
    body: CreatePortalDoc,
    response: PortalDoc,
  }),
  /**
   * "Portal'a gönder" from a Hub page: creates the draft doc, or updates the one this page was
   * sent to before (same version and language). Needs portal.edit and read access to the page.
   */
  createPortalDocFromPage: def({
    method: 'POST',
    path: '/api/v1/portal/sites/:siteId/docs/from-page',
    auth: 'session',
    body: PortalDocFromPage,
    response: PortalDocFromPageResult,
  }),
  getPortalDoc: def({
    method: 'GET',
    path: '/api/v1/portal/docs/:docId',
    auth: 'session',
    response: PortalDoc,
  }),
  updatePortalDoc: def({
    method: 'PATCH',
    path: '/api/v1/portal/docs/:docId',
    auth: 'session',
    body: UpdatePortalDoc,
    response: PortalDoc,
  }),
  deletePortalDoc: def({
    method: 'DELETE',
    path: '/api/v1/portal/docs/:docId',
    auth: 'session',
    response: Empty,
  }),
  restorePortalDoc: def({
    method: 'POST',
    path: '/api/v1/portal/docs/:docId/restore',
    auth: 'session',
    response: PortalDoc,
  }),
  getPortalDocMarkdown: def({
    method: 'GET',
    path: '/api/v1/portal/docs/:docId/markdown',
    auth: 'session',
    response: PortalMarkdown,
  }),
  markPortalTranslationCurrent: def({
    method: 'POST',
    path: '/api/v1/portal/docs/:docId/translation-current',
    auth: 'session',
    response: PortalDoc,
  }),
  /** "next'e de uygula": copy this doc's draft over its counterpart in `next`. */
  applyPortalDocToNext: def({
    method: 'POST',
    path: '/api/v1/portal/docs/:docId/apply-to-next',
    auth: 'session',
    response: PortalDoc,
  }),

  // Blog (10.6, 10.7)
  listPortalPosts: def({
    method: 'GET',
    path: '/api/v1/portal/sites/:siteId/posts',
    auth: 'session',
    query: PortalPostListQuery,
    response: items(PortalPostSummary),
  }),
  createPortalPost: def({
    method: 'POST',
    path: '/api/v1/portal/sites/:siteId/posts',
    auth: 'session',
    body: CreatePortalPost,
    response: PortalPost,
  }),
  getPortalPost: def({
    method: 'GET',
    path: '/api/v1/portal/posts/:postId',
    auth: 'session',
    response: PortalPost,
  }),
  updatePortalPost: def({
    method: 'PATCH',
    path: '/api/v1/portal/posts/:postId',
    auth: 'session',
    body: UpdatePortalPost,
    response: PortalPost,
  }),
  deletePortalPost: def({
    method: 'DELETE',
    path: '/api/v1/portal/posts/:postId',
    auth: 'session',
    response: Empty,
  }),
  listPortalAuthors: def({
    method: 'GET',
    path: '/api/v1/portal/sites/:siteId/authors',
    auth: 'session',
    response: items(PortalAuthor),
  }),
  createPortalAuthor: def({
    method: 'POST',
    path: '/api/v1/portal/sites/:siteId/authors',
    auth: 'session',
    body: UpsertPortalAuthor,
    response: PortalAuthor,
  }),
  updatePortalAuthor: def({
    method: 'PATCH',
    path: '/api/v1/portal/authors/:authorId',
    auth: 'session',
    body: UpsertPortalAuthor.partial(),
    response: PortalAuthor,
  }),

  // Home page, navbar and footer (10.8, 10.9)
  getPortalHome: def({
    method: 'GET',
    path: '/api/v1/portal/sites/:siteId/home',
    auth: 'session',
    response: PortalHomeState,
  }),
  updatePortalHome: def({
    method: 'PUT',
    path: '/api/v1/portal/sites/:siteId/home',
    auth: 'session',
    body: PortalHome,
    response: PortalHomeState,
  }),
  getPortalNavigation: def({
    method: 'GET',
    path: '/api/v1/portal/sites/:siteId/navigation',
    auth: 'session',
    response: PortalNavigationState,
  }),
  updatePortalNavigation: def({
    method: 'PUT',
    path: '/api/v1/portal/sites/:siteId/navigation',
    auth: 'session',
    body: PortalNavigation,
    response: PortalNavigationState,
  }),

  // Media (10.14)
  listPortalMedia: def({
    method: 'GET',
    path: '/api/v1/portal/sites/:siteId/media',
    auth: 'session',
    query: PortalMediaQuery,
    response: items(PortalMedia),
  }),
  createPortalMedia: def({
    method: 'POST',
    path: '/api/v1/portal/sites/:siteId/media',
    auth: 'session',
    body: CreatePortalMedia,
    response: PortalMediaUpload,
  }),
  updatePortalMedia: def({
    method: 'PATCH',
    path: '/api/v1/portal/media/:mediaId',
    auth: 'session',
    body: UpdatePortalMedia,
    response: PortalMedia,
  }),
  deletePortalMedia: def({
    method: 'DELETE',
    path: '/api/v1/portal/media/:mediaId',
    auth: 'session',
    response: Empty,
  }),

  // SEO redirects (10.10)
  listPortalRedirects: def({
    method: 'GET',
    path: '/api/v1/portal/sites/:siteId/redirects',
    auth: 'session',
    response: items(PortalRedirect),
  }),
  createPortalRedirect: def({
    method: 'POST',
    path: '/api/v1/portal/sites/:siteId/redirects',
    auth: 'session',
    body: CreatePortalRedirect,
    response: PortalRedirect,
  }),
  deletePortalRedirect: def({
    method: 'DELETE',
    path: '/api/v1/portal/redirects/:redirectId',
    auth: 'session',
    response: Empty,
  }),

  // Publishing (10.11, 10.12)
  listPortalChanges: def({
    method: 'GET',
    path: '/api/v1/portal/sites/:siteId/changes',
    auth: 'session',
    response: items(PortalChange),
  }),
  previewPortalPublish: def({
    method: 'POST',
    path: '/api/v1/portal/sites/:siteId/publish/preview',
    auth: 'session',
    body: PortalPublishRequest,
    response: PortalPublishPreview,
  }),
  publishPortal: def({
    method: 'POST',
    path: '/api/v1/portal/sites/:siteId/publish',
    auth: 'session',
    body: PortalPublishRequest,
    response: PortalPublish,
  }),
  listPortalPublishes: def({
    method: 'GET',
    path: '/api/v1/portal/sites/:siteId/publishes',
    auth: 'session',
    query: PageQuery,
    response: page(PortalPublishSummary),
  }),
  getPortalPublish: def({
    method: 'GET',
    path: '/api/v1/portal/publishes/:publishId',
    auth: 'session',
    response: PortalPublish,
  }),
  revertPortalPublish: def({
    method: 'POST',
    path: '/api/v1/portal/publishes/:publishId/revert',
    auth: 'session',
    body: PortalRevertRequest,
    response: PortalPublish,
  }),
  retryPortalPublishJob: def({
    method: 'POST',
    path: '/api/v1/portal/publish-jobs/:jobId/retry',
    auth: 'session',
    response: PortalPublishJob,
  }),
  createPortalPreview: def({
    method: 'POST',
    path: '/api/v1/portal/sites/:siteId/preview',
    auth: 'session',
    body: PortalPreviewRequest,
    response: PortalPreviewLink,
  }),
  listPortalImports: def({
    method: 'GET',
    path: '/api/v1/portal/sites/:siteId/imports',
    auth: 'session',
    response: items(PortalImportReport),
  }),

  // Public content API for the Next.js site (11): service token, published snapshots only
  portalPublicSite: def({
    method: 'GET',
    path: '/api/v1/public/portal/site',
    auth: 'public',
    response: PortalPublicSite,
  }),
  portalPublicSidebar: def({
    method: 'GET',
    path: '/api/v1/public/portal/sidebar',
    auth: 'public',
    query: PortalPublicDocsQuery,
    response: PortalPublicSidebar,
  }),
  portalPublicPage: def({
    method: 'GET',
    path: '/api/v1/public/portal/page',
    auth: 'public',
    query: PortalPublicPageQuery,
    response: PortalPublicPage,
  }),
  portalPublicPaths: def({
    method: 'GET',
    path: '/api/v1/public/portal/paths',
    auth: 'public',
    response: items(PortalPublicPath),
  }),
  portalPublicPosts: def({
    method: 'GET',
    path: '/api/v1/public/portal/posts',
    auth: 'public',
    query: PortalPublicPostsQuery,
    response: PortalPublicPosts,
  }),
  portalPublicPost: def({
    method: 'GET',
    path: '/api/v1/public/portal/post',
    auth: 'public',
    query: PortalPublicPostQuery,
    response: PortalPublicPost,
  }),
  portalPublicTags: def({
    method: 'GET',
    path: '/api/v1/public/portal/tags',
    auth: 'public',
    query: z.object({ locale: z.string() }),
    response: PortalPublicTags,
  }),
  portalPublicAuthors: def({
    method: 'GET',
    path: '/api/v1/public/portal/authors',
    auth: 'public',
    response: items(PortalPublicAuthor),
  }),
  portalPublicRedirect: def({
    method: 'GET',
    path: '/api/v1/public/portal/redirect',
    auth: 'public',
    query: PortalPublicRedirectQuery,
    response: PortalPublicRedirectTarget,
  }),
  portalPublicSearch: def({
    method: 'GET',
    path: '/api/v1/public/portal/search',
    auth: 'public',
    query: PortalSearchQuery,
    response: items(PortalSearchHit),
  }),
} as const satisfies Record<string, EndpointDef>;
