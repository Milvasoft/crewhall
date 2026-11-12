import { Readable } from 'node:stream';
import type { Context } from 'hono';
import { AppError } from '../http/errors';
import type { Router } from '../http/route';
import type { AppEnv, OrgCtx } from '../http/types';
import type { Deps } from '../deps';
import type { PortalActor } from '../services/portal/access';
import * as docs from '../services/portal/docs';
import * as media from '../services/portal/media';
import * as posts from '../services/portal/posts';
import { createPreview } from '../services/portal/preview';
import * as pub from '../services/portal/public';
import * as publishing from '../services/portal/publish';
import * as redirects from '../services/portal/redirects';
import * as content from '../services/portal/site-content';
import { docFromPage } from '../services/portal/from-page';
import * as sites from '../services/portal/sites';
import * as versions from '../services/portal/versions';
import { listImports } from '../services/portal/imports';

const actor = (ctx: Pick<OrgCtx<never>, 'org' | 'actor' | 'user'>): PortalActor => ({
  org: ctx.org,
  actor: ctx.actor,
  userId: ctx.user.id,
});

/** `/media/<rest>` from a wildcard route (path segments decoded). */
function restAfter(c: Context<AppEnv>, marker: string) {
  const path = new URL(c.req.url).pathname;
  const at = path.indexOf(marker);
  if (at < 0) throw new AppError('not_found');
  const rest = path
    .slice(at + marker.length)
    .split('/')
    .map((s) => decodeURIComponent(s))
    .join('/');
  if (!rest || rest.split('/').some((s) => s === '..' || s === '')) throw new AppError('not_found');
  return rest;
}

async function sendMedia(
  deps: Deps,
  c: Context<AppEnv>,
  siteId: string,
  rest: string,
  cache: string,
) {
  const file = await media.mediaFile(deps, siteId, rest);
  if (c.req.header('if-none-match') === file.etag) return c.body(null, 304);
  return new Response(Readable.toWeb(file.stream) as ReadableStream, {
    headers: {
      'Content-Type': file.mime,
      'Content-Length': String(file.size),
      'Cache-Control': cache,
      ETag: file.etag,
      'X-Content-Type-Options': 'nosniff',
      // SVGs are served as images, never as documents with scripts.
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    },
  });
}

/** Portal module routes; endpoints come from packages/shared/src/endpoints/portal.ts. */
export function registerPortal(r: Router): void {
  // Sites and settings
  r.org('listPortalSites', async (ctx) => sites.listSites(ctx.deps.db, actor(ctx)));
  r.org(
    'createPortalSite',
    async (ctx) =>
      ctx.deps.db.transaction((tx) => sites.createSite(tx, actor(ctx), ctx.body, ctx.req)),
    { status: 201 },
  );
  r.org('getPortalSite', async (ctx) => sites.getSite(ctx.deps.db, actor(ctx), ctx.params.siteId));
  r.org('updatePortalSite', async (ctx) =>
    sites.updateSite(ctx.deps.db, actor(ctx), ctx.params.siteId, ctx.body, ctx.req),
  );
  r.org('rotatePortalToken', async (ctx) =>
    sites.rotateToken(ctx.deps.db, actor(ctx), ctx.params.siteId, ctx.req),
  );
  r.org('testPortalRevalidate', async (ctx) =>
    sites.testRevalidate(ctx.deps, actor(ctx), ctx.params.siteId),
  );
  r.org('getPortalOverview', async (ctx) =>
    sites.overview(ctx.deps.db, actor(ctx), ctx.params.siteId),
  );

  // Versions
  r.org('listPortalVersions', async (ctx) =>
    versions.listVersions(ctx.deps.db, actor(ctx), ctx.params.siteId),
  );
  r.org(
    'freezePortalVersion',
    async (ctx) =>
      versions.freezeVersion(ctx.deps, actor(ctx), ctx.params.siteId, ctx.body, ctx.req),
    { status: 201 },
  );
  r.org('updatePortalVersion', async (ctx) =>
    versions.updateVersion(ctx.deps, actor(ctx), ctx.params.versionId, ctx.body),
  );
  r.org('diffPortalVersions', async (ctx) =>
    versions.diffVersions(ctx.deps.db, actor(ctx), ctx.params.siteId, ctx.query),
  );

  // Docs
  r.org('getPortalDocTree', async (ctx) =>
    docs.docTree(ctx.deps.db, actor(ctx), ctx.params.siteId, ctx.query),
  );
  r.org(
    'createPortalDoc',
    async (ctx) =>
      ctx.deps.db.transaction((tx) => docs.createDoc(tx, actor(ctx), ctx.params.siteId, ctx.body)),
    { status: 201 },
  );
  r.org('createPortalDocFromPage', async (ctx) =>
    docFromPage(ctx.deps, actor(ctx), ctx.params.siteId, ctx.body),
  );
  r.org('getPortalDoc', async (ctx) => docs.getDoc(ctx.deps.db, actor(ctx), ctx.params.docId));
  r.org('updatePortalDoc', async (ctx) =>
    ctx.deps.db.transaction((tx) => docs.updateDoc(tx, actor(ctx), ctx.params.docId, ctx.body)),
  );
  r.org('deletePortalDoc', async (ctx) =>
    ctx.deps.db.transaction((tx) => docs.deleteDoc(tx, actor(ctx), ctx.params.docId, ctx.req)),
  );
  r.org('restorePortalDoc', async (ctx) =>
    ctx.deps.db.transaction((tx) => docs.restoreDoc(tx, actor(ctx), ctx.params.docId)),
  );
  r.org('getPortalDocMarkdown', async (ctx) =>
    docs.docMarkdown(ctx.deps.db, actor(ctx), ctx.params.docId),
  );
  r.org('markPortalTranslationCurrent', async (ctx) =>
    docs.markTranslationCurrent(ctx.deps.db, actor(ctx), ctx.params.docId),
  );
  r.org('applyPortalDocToNext', async (ctx) =>
    ctx.deps.db.transaction((tx) => docs.applyToNext(tx, actor(ctx), ctx.params.docId)),
  );

  // Blog
  r.org('listPortalPosts', async (ctx) =>
    posts.listPosts(ctx.deps.db, actor(ctx), ctx.params.siteId, ctx.query),
  );
  r.org(
    'createPortalPost',
    async (ctx) =>
      ctx.deps.db.transaction((tx) =>
        posts.createPost(tx, actor(ctx), ctx.params.siteId, ctx.body),
      ),
    { status: 201 },
  );
  r.org('getPortalPost', async (ctx) => posts.getPost(ctx.deps.db, actor(ctx), ctx.params.postId));
  r.org('updatePortalPost', async (ctx) =>
    ctx.deps.db.transaction((tx) => posts.updatePost(tx, actor(ctx), ctx.params.postId, ctx.body)),
  );
  r.org('deletePortalPost', async (ctx) =>
    ctx.deps.db.transaction((tx) => posts.deletePost(tx, actor(ctx), ctx.params.postId, ctx.req)),
  );
  r.org('listPortalAuthors', async (ctx) =>
    posts.listAuthors(ctx.deps.db, actor(ctx), ctx.params.siteId),
  );
  r.org(
    'createPortalAuthor',
    async (ctx) => posts.createAuthor(ctx.deps.db, actor(ctx), ctx.params.siteId, ctx.body),
    { status: 201 },
  );
  r.org('updatePortalAuthor', async (ctx) =>
    posts.updateAuthor(ctx.deps.db, actor(ctx), ctx.params.authorId, ctx.body),
  );

  // Home page, navbar and footer
  r.org('getPortalHome', async (ctx) =>
    content.getHome(ctx.deps.db, actor(ctx), ctx.params.siteId),
  );
  r.org('updatePortalHome', async (ctx) =>
    content.updateHome(ctx.deps.db, actor(ctx), ctx.params.siteId, ctx.body),
  );
  r.org('getPortalNavigation', async (ctx) =>
    content.getNavigation(ctx.deps.db, actor(ctx), ctx.params.siteId),
  );
  r.org('updatePortalNavigation', async (ctx) =>
    content.updateNavigation(ctx.deps.db, actor(ctx), ctx.params.siteId, ctx.body),
  );

  // Media
  r.org('listPortalMedia', async (ctx) =>
    media.listMedia(ctx.deps.db, actor(ctx), ctx.params.siteId, ctx.query.filter),
  );
  r.org(
    'createPortalMedia',
    async (ctx) => media.createMedia(ctx.deps.db, actor(ctx), ctx.params.siteId, ctx.body),
    { status: 201 },
  );
  r.org('updatePortalMedia', async (ctx) =>
    media.updateMedia(ctx.deps.db, actor(ctx), ctx.params.mediaId, ctx.body.alt),
  );
  r.org('deletePortalMedia', async (ctx) =>
    media.deleteMedia(ctx.deps.db, actor(ctx), ctx.params.mediaId, ctx.req),
  );
  r.rawOrg('PUT', '/api/v1/portal/media/:mediaId/content', async (ctx) => {
    const declared = Number(ctx.c.req.header('content-length') ?? '0');
    if (declared > media.MAX_MEDIA_BYTES) throw new AppError('file_too_large');
    const data = Buffer.from(await ctx.c.req.arrayBuffer());
    const item = await media.uploadMediaContent(
      ctx.deps,
      actor(ctx),
      ctx.c.req.param('mediaId') ?? '',
      data,
      ctx.c.req.header('content-type') ?? null,
    );
    return ctx.c.json(item);
  });
  r.rawOrg('GET', '/api/v1/portal/sites/:siteId/files/*', async (ctx) => {
    const siteId = ctx.c.req.param('siteId') ?? '';
    await media.viewerCanSeeSite(ctx.deps.db, actor(ctx), siteId);
    return sendMedia(ctx.deps, ctx.c, siteId, restAfter(ctx.c, '/files/'), 'private, max-age=300');
  });

  // Redirects
  r.org('listPortalRedirects', async (ctx) =>
    redirects.listRedirects(ctx.deps.db, actor(ctx), ctx.params.siteId),
  );
  r.org(
    'createPortalRedirect',
    async (ctx) =>
      redirects.createRedirect(ctx.deps.db, actor(ctx), ctx.params.siteId, ctx.body, ctx.req),
    { status: 201 },
  );
  r.org('deletePortalRedirect', async (ctx) =>
    redirects.deleteRedirect(ctx.deps.db, actor(ctx), ctx.params.redirectId),
  );

  // Publishing
  r.org('listPortalChanges', async (ctx) =>
    publishing.listChanges(ctx.deps.db, actor(ctx), ctx.params.siteId),
  );
  r.org('previewPortalPublish', async (ctx) =>
    publishing.previewPublish(ctx.deps, actor(ctx), ctx.params.siteId, ctx.body),
  );
  r.org(
    'publishPortal',
    async (ctx) => publishing.publish(ctx.deps, actor(ctx), ctx.params.siteId, ctx.body, ctx.req),
    { status: 201 },
  );
  r.org('listPortalPublishes', async (ctx) =>
    publishing.listPublishes(ctx.deps.db, actor(ctx), ctx.params.siteId, ctx.query),
  );
  r.org('getPortalPublish', async (ctx) =>
    publishing.getPublish(ctx.deps.db, actor(ctx), ctx.params.publishId),
  );
  r.org(
    'revertPortalPublish',
    async (ctx) =>
      publishing.revertPublish(ctx.deps, actor(ctx), ctx.params.publishId, ctx.body, ctx.req),
    { status: 201 },
  );
  r.org('retryPortalPublishJob', async (ctx) =>
    publishing.retryJob(ctx.deps, actor(ctx), ctx.params.jobId),
  );
  r.org('createPortalPreview', async (ctx) =>
    createPreview(ctx.deps.db, ctx.deps.env, actor(ctx), ctx.params.siteId, ctx.body.path),
  );
  r.org('listPortalImports', async (ctx) =>
    listImports(ctx.deps.db, actor(ctx), ctx.params.siteId),
  );

  // Public content API (service token)
  r.public('portalPublicSite', async (ctx) =>
    pub.publicSite(await pub.publicContext(ctx.deps, ctx.c)),
  );
  r.public('portalPublicSidebar', async (ctx) =>
    pub.publicSidebar(await pub.publicContext(ctx.deps, ctx.c), ctx.query),
  );
  r.public('portalPublicPage', async (ctx) =>
    pub.publicPage(await pub.publicContext(ctx.deps, ctx.c), ctx.query),
  );
  r.public('portalPublicPaths', async (ctx) => ({
    items: await pub.publicPaths(await pub.publicContext(ctx.deps, ctx.c)),
  }));
  r.public('portalPublicPosts', async (ctx) =>
    pub.publicPosts(await pub.publicContext(ctx.deps, ctx.c), ctx.query),
  );
  r.public('portalPublicPost', async (ctx) =>
    pub.publicPost(await pub.publicContext(ctx.deps, ctx.c), ctx.query),
  );
  r.public('portalPublicTags', async (ctx) =>
    pub.publicTags(await pub.publicContext(ctx.deps, ctx.c), ctx.query.locale),
  );
  r.public('portalPublicAuthors', async (ctx) =>
    pub.publicAuthors(await pub.publicContext(ctx.deps, ctx.c)),
  );
  r.public('portalPublicRedirect', async (ctx) =>
    pub.publicRedirect(await pub.publicContext(ctx.deps, ctx.c), ctx.query.path),
  );
  r.public('portalPublicSearch', async (ctx) => ({
    items: await pub.publicSearch(await pub.publicContext(ctx.deps, ctx.c), ctx.query),
  }));
  r.rawPublic('GET', '/api/v1/public/portal/media/*', async ({ c, deps }) => {
    const pctx = await pub.publicContext(deps, c);
    return sendMedia(
      deps,
      c,
      pctx.site.id,
      restAfter(c, '/public/portal/media/'),
      'public, max-age=3600',
    );
  });
}
