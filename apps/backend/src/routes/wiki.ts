import { PAGE_EXPORT_RAW_PATHS } from '@crewhall/shared';
import type { Router } from '../http/route';
import type { OrgCtx } from '../http/types';
import { publishNodeChanges } from '../realtime/events';
import { driveActor } from './drive';
import * as comments from '../services/wiki/comments';
import * as exportsSvc from '../services/wiki/export/jobs';
import * as pages from '../services/wiki/pages';
import { publicPage } from '../services/wiki/public';
import { searchPages } from '../services/wiki/search';
import * as templates from '../services/wiki/templates';
import * as versions from '../services/wiki/versions';

/** Where an edit came from, for node_versions.source (doc 17 §13). */
const sourceOf = (userAgent: string | null): 'web' | 'mobile' =>
  userAgent && /expo|okhttp|cfnetwork|crewhall-mobile/i.test(userAgent) ? 'mobile' : 'web';

const localeOf = (ctx: Pick<OrgCtx<never>, 'req' | 'user' | 'org'>) => {
  const userLocale = (ctx.user as { locale?: string | null }).locale;
  if (userLocale === 'tr' || userLocale === 'en') return userLocale;
  return templates.localeOf(ctx.req.locale, ctx.org.settings.defaultLocale === 'en' ? 'en' : 'tr');
};

/** Wiki module routes (design 05; doc 17 §4, §6). Endpoints: packages/shared/src/endpoints/wiki.ts. */
export function registerWiki(r: Router) {
  r.org('listPageTree', async (ctx) =>
    pages.pageTree(ctx.deps.db, driveActor(ctx), ctx.params.spaceId),
  );
  r.org(
    'createPage',
    async (ctx) =>
      pages.createPage(ctx.deps, driveActor(ctx), ctx.params.spaceId, ctx.body, {
        source: sourceOf(ctx.req.userAgent),
        locale: localeOf(ctx),
      }),
    { status: 201 },
  );
  r.org('appendPage', async (ctx) => {
    await pages.appendPage(ctx.deps, driveActor(ctx), ctx.params.nodeId, ctx.body.markdown);
    return {};
  });
  r.org('importPages', async (ctx) =>
    pages.importPages(ctx.deps, driveActor(ctx), ctx.params.spaceId, ctx.body, {
      source: sourceOf(ctx.req.userAgent),
      locale: localeOf(ctx),
    }),
  );
  r.org('getPage', async (ctx) => pages.getPage(ctx.deps.db, driveActor(ctx), ctx.params.nodeId));
  r.org('updatePage', async (ctx) =>
    pages.updatePage(ctx.deps, driveActor(ctx), ctx.params.nodeId, ctx.body),
  );
  // ---- export (roadmap 6) ----
  r.org(
    'createPageExport',
    async (ctx) =>
      exportsSvc.createPageExport(ctx.deps, driveActor(ctx), ctx.params.nodeId, ctx.body),
    { status: 201 },
  );
  r.org('getPageExport', async (ctx) =>
    exportsSvc.getPageExport(ctx.deps.db, driveActor(ctx), ctx.params.exportId),
  );
  r.rawOrg('GET', PAGE_EXPORT_RAW_PATHS.download, async (ctx) => {
    const url = await exportsSvc.pageExportUrl(
      ctx.deps,
      driveActor(ctx),
      ctx.c.req.param('exportId') ?? '',
    );
    return ctx.c.redirect(url, 302);
  });

  r.public('getPublicPage', async (ctx) => publicPage(ctx.deps, ctx.params.token, ctx.query));
  r.org('movePage', async (ctx) => {
    const page = await pages.movePage(ctx.deps.db, driveActor(ctx), ctx.params.nodeId, ctx.body);
    await publishNodeChanges(
      ctx.deps,
      [{ id: page.id, spaceId: page.spaceId, parentId: page.parentId }],
      'moved',
    );
    return page;
  });
  r.org(
    'duplicatePage',
    async (ctx) =>
      pages.duplicatePage(
        ctx.deps,
        driveActor(ctx),
        ctx.params.nodeId,
        ctx.body.name,
        sourceOf(ctx.req.userAgent),
      ),
    { status: 201 },
  );
  r.org('getPageContent', async (ctx) =>
    pages.pageContent(ctx.deps.db, driveActor(ctx), ctx.params.nodeId, ctx.query.format),
  );
  r.org('setPageTask', async (ctx) =>
    pages.setTask(
      ctx.deps,
      driveActor(ctx),
      ctx.params.nodeId,
      ctx.body,
      sourceOf(ctx.req.userAgent),
    ),
  );
  r.org('setPageFollow', async (ctx) =>
    pages.setFollow(ctx.deps.db, driveActor(ctx), ctx.params.nodeId, ctx.body),
  );
  r.org('createCollabToken', async (ctx) =>
    pages.collabToken(
      ctx.deps.db,
      ctx.deps.env,
      driveActor(ctx),
      ctx.params.nodeId,
      ctx.body.source,
    ),
  );

  // Versions
  r.org('listPageVersions', async (ctx) => ({
    items: await versions.listPageVersions(ctx.deps.db, driveActor(ctx), ctx.params.nodeId),
  }));
  r.org(
    'savePageVersion',
    async (ctx) =>
      versions.savePageVersion(
        ctx.deps,
        driveActor(ctx),
        ctx.params.nodeId,
        ctx.body.label ?? null,
        sourceOf(ctx.req.userAgent),
      ),
    { status: 201 },
  );
  r.org('getPageVersion', async (ctx) =>
    versions.getPageVersion(ctx.deps.db, driveActor(ctx), ctx.params.nodeId, ctx.params.versionId),
  );
  r.org('updatePageVersion', async (ctx) =>
    versions.updatePageVersion(
      ctx.deps.db,
      driveActor(ctx),
      ctx.params.nodeId,
      ctx.params.versionId,
      ctx.body.label,
    ),
  );
  r.org('restorePageVersion', async (ctx) =>
    versions.restorePageVersion(
      ctx.deps,
      driveActor(ctx),
      ctx.params.nodeId,
      ctx.params.versionId,
      sourceOf(ctx.req.userAgent),
    ),
  );

  // Comments
  r.org('listPageComments', async (ctx) => ({
    items: await comments.listComments(
      ctx.deps.db,
      driveActor(ctx),
      ctx.params.nodeId,
      ctx.query.status,
    ),
  }));
  r.org(
    'createPageComment',
    async (ctx) => comments.createComment(ctx.deps, driveActor(ctx), ctx.params.nodeId, ctx.body),
    { status: 201 },
  );
  r.org('updatePageComment', async (ctx) =>
    comments.updateComment(ctx.deps, driveActor(ctx), ctx.params.commentId, ctx.body),
  );
  r.org('deletePageComment', async (ctx) => {
    await comments.deleteComment(ctx.deps, driveActor(ctx), ctx.params.commentId);
    return {};
  });
  r.org('resolvePageThread', async (ctx) =>
    comments.resolveThread(ctx.deps, driveActor(ctx), ctx.params.threadId, ctx.body.resolved),
  );

  r.org('listPageBacklinks', async (ctx) => ({
    items: await pages.backlinks(ctx.deps.db, driveActor(ctx), ctx.params.nodeId),
  }));
  r.org('exportPage', async (ctx) =>
    pages.exportPage(ctx.deps.db, driveActor(ctx), ctx.params.nodeId, ctx.query.children),
  );
  r.org('searchPages', async (ctx) => searchPages(ctx.deps.db, driveActor(ctx), ctx.query));

  // Templates
  r.org('listPageTemplates', async (ctx) => ({
    items: await templates.listTemplates(
      ctx.deps.db,
      driveActor(ctx),
      localeOf(ctx),
      ctx.query.spaceId,
    ),
  }));
  r.org(
    'createPageTemplate',
    async (ctx) => templates.createTemplate(ctx.deps.db, driveActor(ctx), ctx.body),
    { status: 201 },
  );
  r.org('deletePageTemplate', async (ctx) => {
    await templates.deleteTemplate(ctx.deps.db, driveActor(ctx), ctx.params.templateId);
    return {};
  });
}
