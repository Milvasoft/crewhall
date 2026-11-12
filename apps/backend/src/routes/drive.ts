import { RAW_PATHS } from '@crewhall/shared';
import type { Router } from '../http/route';
import { publishNodeChanges, type NodeChange } from '../realtime/events';
import type { OrgCtx } from '../http/types';
import { searchChunksFor } from '../services/ai/search/query';
import type { DriveActor } from '../services/drive/access';
import { listDriveChanges } from '../services/drive/changes';
import * as files from '../services/drive/files';
import * as tree from '../services/drive/nodes';
import * as personal from '../services/drive/personal';
import { getQuota } from '../services/drive/quota';
import { nodesByIds } from '../services/drive/tree';
import * as shares from '../services/drive/shares';
import { fileUploaded } from '../services/automations/sources';
import { emitPluginEvent } from '../services/plugins/events';

/** The Drive context of an org-scoped request. */
export const driveActor = (ctx: Pick<OrgCtx<never>, 'org' | 'actor' | 'user'>): DriveActor => ({
  org: ctx.org,
  actor: ctx.actor,
  userId: ctx.user.id,
});

/** Where an upload or edit came from, for node_versions.source (doc 17 §13). */
const sourceOf = (userAgent: string | null): 'web' | 'mobile' =>
  userAgent && /expo|okhttp|cfnetwork|crewhall-mobile/i.test(userAgent) ? 'mobile' : 'web';

/** Tell open clients (WS node.updated); never fails the request. */
type NodeRef = { id: string; spaceId: string; parentId: string | null };
async function emit<R extends NodeRef | NodeRef[]>(
  ctx: Pick<OrgCtx<never>, 'deps' | 'org'>,
  result: R,
  change: NodeChange,
): Promise<R> {
  const list: NodeRef[] = Array.isArray(result) ? result : [result as NodeRef];
  await publishNodeChanges(ctx.deps, list, change);
  // Plugins (event subscriptions): created and updated nodes, ids only.
  if (change === 'created' || change === 'updated') {
    for (const n of list.slice(0, 50)) {
      await emitPluginEvent(
        ctx.deps,
        ctx.org.id,
        change === 'created' ? 'node.created' : 'node.updated',
        {
          nodeId: n.id,
          spaceId: n.spaceId,
          parentId: n.parentId,
        },
      );
    }
  }
  return result;
}

export function registerDrive(r: Router) {
  // ---- tree ----
  r.org('listNodes', async (ctx) =>
    tree.listNodes(ctx.deps.db, driveActor(ctx), ctx.params.spaceId, ctx.query),
  );
  r.org('getNode', async (ctx) => tree.nodeDetail(ctx.deps.db, driveActor(ctx), ctx.params.nodeId));
  r.org(
    'createFolder',
    async (ctx) =>
      emit(
        ctx,
        await tree.createFolder(ctx.deps.db, driveActor(ctx), ctx.params.spaceId, ctx.body),
        'created',
      ),
    { status: 201 },
  );
  r.org('updateNode', async (ctx) => {
    const a = driveActor(ctx);
    if (ctx.body.name === undefined) return tree.nodeDetail(ctx.deps.db, a, ctx.params.nodeId);
    return emit(
      ctx,
      await tree.renameNode(ctx.deps.db, a, ctx.params.nodeId, ctx.body.name),
      'updated',
    );
  });
  r.org('moveNodes', async (ctx) => ({
    items: await emit(
      ctx,
      await ctx.deps.db.transaction((tx) =>
        tree.moveNodes(tx, driveActor(ctx), ctx.body.nodeIds, ctx.body.target, ctx.req),
      ),
      'moved',
    ),
  }));
  r.org('copyNodes', async (ctx) => ({
    items: await emit(
      ctx,
      await ctx.deps.db.transaction((tx) =>
        tree.copyNodes(tx, driveActor(ctx), ctx.body.nodeIds, ctx.body.target),
      ),
      'created',
    ),
  }));
  r.org('trashNodes', async (ctx) => ({
    items: await emit(
      ctx,
      await ctx.deps.db.transaction((tx) => tree.trashNodes(tx, driveActor(ctx), ctx.body.nodeIds)),
      'trashed',
    ),
  }));
  r.org('restoreNodes', async (ctx) => ({
    items: await emit(
      ctx,
      await ctx.deps.db.transaction((tx) =>
        tree.restoreNodes(tx, driveActor(ctx), ctx.body.nodeIds),
      ),
      'restored',
    ),
  }));
  r.org('purgeNodes', async (ctx) => {
    await ctx.deps.db.transaction((tx) =>
      tree.purgeNodes(tx, driveActor(ctx), ctx.body.nodeIds, ctx.req),
    );
    return {};
  });
  r.org('listTrash', async (ctx) =>
    tree.listTrash(ctx.deps.db, driveActor(ctx), ctx.params.spaceId, ctx.query),
  );
  r.org('emptyTrash', async (ctx) => {
    await ctx.deps.db.transaction((tx) =>
      tree.emptyTrash(tx, driveActor(ctx), ctx.params.spaceId, ctx.req),
    );
    return {};
  });

  // ---- uploads ----
  r.org(
    'createUpload',
    async (ctx) =>
      files.createUpload(ctx.deps, driveActor(ctx), ctx.body, sourceOf(ctx.req.userAgent)),
    { status: 201 },
  );
  r.org('getUpload', async (ctx) =>
    files.getUpload(ctx.deps, driveActor(ctx), ctx.params.uploadId),
  );
  r.org('getUploadPartUrls', async (ctx) =>
    files.partUrls(ctx.deps, driveActor(ctx), ctx.params.uploadId, ctx.body.partNumbers),
  );
  r.org('completeUpload', async (ctx) => {
    const done = await files.completeUpload(
      ctx.deps,
      driveActor(ctx),
      ctx.params.uploadId,
      ctx.body.parts,
    );
    await emit(ctx, done.node, done.version.version > 1 ? 'updated' : 'created');
    // Automations (roadmap 17): "dosya yüklendi".
    await fileUploaded(ctx.deps, driveActor(ctx), done.node, done.version.version);
    return done;
  });
  r.org('abortUpload', async (ctx) => {
    await files.abortUpload(ctx.deps, driveActor(ctx), ctx.params.uploadId);
    return {};
  });

  // ---- download, preview, versions ----
  r.org('getDownloadUrl', async (ctx) =>
    files.downloadUrl(
      ctx.deps,
      driveActor(ctx),
      ctx.params.nodeId,
      ctx.query.versionId,
      ctx.query.disposition,
    ),
  );
  r.org('getPreview', async (ctx) =>
    files.previewUrl(ctx.deps, driveActor(ctx), ctx.params.nodeId, ctx.query.kind),
  );
  r.org('listVersions', async (ctx) => ({
    items: await files.listVersions(ctx.deps.db, driveActor(ctx), ctx.params.nodeId),
  }));
  r.org('restoreVersion', async (ctx) => {
    const done = await files.restoreVersion(
      ctx.deps,
      driveActor(ctx),
      ctx.params.nodeId,
      ctx.params.versionId,
    );
    const [node] = await nodesByIds(ctx.deps.db, ctx.org.id, [ctx.params.nodeId]);
    if (node) await emit(ctx, node, 'updated');
    return done;
  });

  // ---- shares ----
  r.org('listShares', async (ctx) =>
    shares.listShares(ctx.deps, driveActor(ctx), ctx.params.nodeId),
  );
  r.org(
    'createShare',
    async (ctx) =>
      shares.createShare(ctx.deps, driveActor(ctx), ctx.params.nodeId, ctx.body, ctx.req),
    { status: 201 },
  );
  r.org('updateShare', async (ctx) =>
    shares.updateShare(ctx.deps.db, driveActor(ctx), ctx.params.shareId, ctx.body, ctx.req),
  );
  r.org('deleteShare', async (ctx) => {
    await shares.deleteShare(ctx.deps.db, driveActor(ctx), ctx.params.shareId, ctx.req);
    return {};
  });
  r.org('regenerateShareLink', async (ctx) =>
    shares.regenerateLink(ctx.deps, driveActor(ctx), ctx.params.shareId, ctx.req),
  );

  // ---- public links ----
  r.public('getPublicShare', async (ctx) =>
    shares.publicShare(ctx.deps, ctx.params.token, ctx.query.grant, ctx.req),
  );
  r.public('unlockPublicShare', async (ctx) =>
    shares.unlockPublicShare(ctx.deps, ctx.params.token, ctx.body.password, ctx.req),
  );
  r.public('listPublicShareNodes', async (ctx) =>
    shares.publicChildren(ctx.deps, ctx.params.token, ctx.query),
  );
  r.public('getPublicDownloadUrl', async (ctx) =>
    shares.publicDownload(ctx.deps, ctx.params.token, ctx.query),
  );
  r.public('getPublicPreview', async (ctx) =>
    shares.publicPreview(ctx.deps, ctx.params.token, ctx.query),
  );

  // ---- favorites, recent, search, quota ----
  r.org('listFavorites', async (ctx) => ({
    items: await personal.listFavorites(ctx.deps.db, driveActor(ctx)),
  }));
  r.org('setFavorite', async (ctx) =>
    personal.setFavorite(ctx.deps.db, driveActor(ctx), ctx.params.nodeId, ctx.body),
  );
  r.org('listRecent', async (ctx) => ({
    items: await personal.listRecent(ctx.deps.db, driveActor(ctx), ctx.query.limit),
  }));
  r.org('markNodeOpened', async (ctx) => {
    await files.markOpened(ctx.deps.db, driveActor(ctx), ctx.params.nodeId);
    return {};
  });
  r.org('listDriveChanges', async (ctx) =>
    listDriveChanges(ctx.deps.db, driveActor(ctx), ctx.query),
  );
  r.org('searchNodes', async (ctx) =>
    personal.searchNodes(ctx.deps.db, driveActor(ctx), ctx.query),
  );
  // No embedding model here: with the ai module off, the query must not reach a provider.
  r.org('searchContent', async (ctx) => {
    const found = await searchChunksFor(ctx.deps, driveActor(ctx), {
      ...ctx.query,
      embedCfg: null,
    });
    return { items: found.map((f) => f.hit) };
  });
  r.org('getQuota', async (ctx) => getQuota(ctx.deps.db, ctx.org));

  // ---- browser redirects (RAW_PATHS) ----
  r.rawOrg('GET', RAW_PATHS.download, async (ctx) => {
    const url = await files.downloadUrl(
      ctx.deps,
      driveActor(ctx),
      ctx.c.req.param('nodeId') ?? '',
      ctx.c.req.query('versionId') || undefined,
      ctx.c.req.query('disposition') === 'inline' ? 'inline' : 'attachment',
    );
    return ctx.c.redirect(url.url, 302);
  });
  r.rawOrg('GET', RAW_PATHS.preview, async (ctx) => {
    const kind = ctx.c.req.query('kind');
    const url = await files.previewUrl(
      ctx.deps,
      driveActor(ctx),
      ctx.c.req.param('nodeId') ?? '',
      kind === 'thumb_1024' || kind === 'pdf_p1' || kind === 'poster' ? kind : 'thumb_256',
    );
    return ctx.c.redirect(url.url, 302);
  });
  r.rawPublic('GET', RAW_PATHS.publicDownload, async ({ c, deps }) => {
    const url = await shares.publicDownload(deps, c.req.param('token') ?? '', {
      grant: c.req.query('grant') || undefined,
      nodeId: c.req.query('nodeId') || undefined,
      disposition: c.req.query('disposition') === 'inline' ? 'inline' : 'attachment',
    });
    return c.redirect(url.url, 302);
  });
}
