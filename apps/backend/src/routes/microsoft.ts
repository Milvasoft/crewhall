import { can, IntegrationKey, MICROSOFT_RAW_PATHS, MountPath } from '@crewhall/shared';
import { AppError } from '../http/errors';
import { requestInfo, type Router } from '../http/route';
import type { OrgCtx } from '../http/types';
import { orgLimits } from '../services/drive/quota';
import { orgContext } from '../services/membership';
import {
  listImportJobs,
  startMountImport,
  startOneDriveMove,
} from '../services/microsoft/storage/import';
import {
  createMount,
  createMountFolder,
  deleteMount,
  listAllMounts,
  listMountItems,
  listSpaceMounts,
  readMountFile,
  testMount,
  updateMount,
  writeMountFile,
} from '../services/microsoft/storage/mounts';
import {
  integrationClient,
  overview,
  requireIntegration,
  setIntegration,
  testApp,
  updateApp,
} from '../services/microsoft/app';
import { shareAttachment, outlookManifest } from '../services/microsoft/outlook';
import { saveToCrewhall } from '../services/microsoft/save';
import { createScimToken, handleScim, revokeScimToken } from '../services/microsoft/scim';
import {
  createLinkCode,
  getDraft,
  handleTeamsActivity,
  teamsPackage,
} from '../services/microsoft/teams';
import {
  createUploadRequest,
  listUploadRequests,
  publicUploadRequest,
  revokeUploadRequest,
  uploadToRequest,
} from '../services/microsoft/upload-requests';

type Ctx = Pick<OrgCtx<never>, 'actor' | 'org'>;

const driveActor = (ctx: Pick<OrgCtx<never>, 'actor' | 'org' | 'user'>) => ({
  org: ctx.org,
  actor: ctx.actor,
  userId: ctx.user.id,
  userName: ctx.user.name,
});

function requireAdmin(ctx: Ctx) {
  if (!can(ctx.actor, 'org.update_settings', { type: 'org', org: orgContext(ctx.org) })) {
    throw new AppError('forbidden');
  }
}

/** Microsoft integrations (sonraki-isler.md): admin wizard, SCIM, add-in, Teams, storage. */
export function registerMicrosoft(r: Router) {
  // ---- Yönetim › Entegrasyonlar › Microsoft ----------------------------------------------
  r.org('getMicrosoftIntegrations', async (ctx) => {
    requireAdmin(ctx);
    return overview(ctx.deps, ctx.org);
  });
  r.org('updateMicrosoftApp', async (ctx) => {
    requireAdmin(ctx);
    return updateApp(ctx.deps, { orgId: ctx.org.id, userId: ctx.user.id }, ctx.body, ctx.req);
  });
  r.org('testMicrosoftApp', async (ctx) => {
    requireAdmin(ctx);
    return testApp(ctx.deps, ctx.org.id);
  });
  r.org('updateMicrosoftIntegration', async (ctx) => {
    requireAdmin(ctx);
    const key = IntegrationKey.safeParse(ctx.params.integration);
    if (!key.success) throw new AppError('not_found');
    await setIntegration(
      ctx.deps,
      { org: ctx.org, userId: ctx.user.id },
      key.data,
      ctx.body,
      ctx.req,
    );
    const settings = {
      ...ctx.org.settings,
      integrations: { ...ctx.org.settings.integrations, [key.data]: ctx.body.enabled },
    };
    return overview(ctx.deps, { ...ctx.org, settings });
  });
  r.org(
    'createScimToken',
    async (ctx) => {
      requireAdmin(ctx);
      return createScimToken(
        ctx.deps.db,
        { orgId: ctx.org.id, userId: ctx.user.id },
        ctx.body,
        ctx.req,
      );
    },
    { status: 201 },
  );
  r.org('revokeScimToken', async (ctx) => {
    requireAdmin(ctx);
    await revokeScimToken(
      ctx.deps.db,
      { orgId: ctx.org.id, userId: ctx.user.id },
      ctx.params.tokenId,
      ctx.req,
    );
    return {};
  });

  // ---- SCIM 2.0 (Entra provisioning) ---------------------------------------------------------
  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const) {
    for (const path of [MICROSOFT_RAW_PATHS.scimBase, `${MICROSOFT_RAW_PATHS.scimBase}/*`]) {
      r.rawPublic(method, path, ({ c, deps }) => handleScim(deps, c, requestInfo(c)));
    }
  }

  // ---- Outlook add-in and Teams app ------------------------------------------------------------
  r.org('saveToCrewhall', async (ctx) => saveToCrewhall(ctx.deps, driveActor(ctx), ctx.body), {
    status: 201,
  });
  r.org(
    'shareAttachment',
    async (ctx) => {
      requireIntegration(ctx.org, 'outlook');
      return shareAttachment(ctx.deps, driveActor(ctx), ctx.body, ctx.req);
    },
    { status: 201 },
  );
  r.org(
    'createUploadRequest',
    async (ctx) => createUploadRequest(ctx.deps, driveActor(ctx), ctx.body, ctx.req),
    {
      status: 201,
    },
  );
  r.org('listUploadRequests', async (ctx) => ({
    items: await listUploadRequests(ctx.deps, driveActor(ctx)),
  }));
  r.org('revokeUploadRequest', async (ctx) => {
    await revokeUploadRequest(ctx.deps, driveActor(ctx), ctx.params.requestId, ctx.req);
    return {};
  });
  r.public('getPublicUploadRequest', async (ctx) =>
    publicUploadRequest(ctx.deps, ctx.params.token),
  );
  r.public(
    'uploadToRequest',
    async (ctx) => uploadToRequest(ctx.deps, ctx.params.token, ctx.body, ctx.req),
    {
      status: 201,
    },
  );
  r.org(
    'createTeamsLinkCode',
    async (ctx) => {
      requireIntegration(ctx.org, 'teams');
      return createLinkCode(ctx.deps.db, ctx.org.id, ctx.user.id);
    },
    { status: 201 },
  );
  r.org('getTeamsDraft', async (ctx) => {
    requireIntegration(ctx.org, 'teams');
    return getDraft(ctx.deps.db, ctx.org.id, ctx.params.draftId);
  });

  r.rawOrg('GET', MICROSOFT_RAW_PATHS.outlookManifest, async ({ c, deps, org, actor }) => {
    requireAdmin({ actor, org });
    requireIntegration(org, 'outlook');
    const client = await integrationClient(deps.db, org.id, 'outlook');
    if (!client) throw new AppError('integration_disabled', { integration: 'outlook' });
    return c.body(outlookManifest(deps.env, org, client.clientId), 200, {
      'content-type': 'application/xml; charset=utf-8',
      'content-disposition': 'attachment; filename="crewhall-outlook-manifest.xml"',
    });
  });
  r.rawOrg('GET', MICROSOFT_RAW_PATHS.teamsPackage, async ({ c, deps, org, actor }) => {
    requireAdmin({ actor, org });
    requireIntegration(org, 'teams');
    const zip = await teamsPackage(deps, org);
    return c.body(zip, 200, {
      'content-type': 'application/zip',
      'content-disposition': 'attachment; filename="crewhall-teams.zip"',
    });
  });
  r.rawPublic('POST', MICROSOFT_RAW_PATHS.teamsMessages, ({ c, deps }) =>
    handleTeamsActivity(deps, c, requestInfo(c)),
  );

  // ---- external storage (SharePoint, OneDrive, SMB) --------------------------------------------
  const adminCtx = (ctx: Pick<OrgCtx<never>, 'org' | 'user'>) => ({
    orgId: ctx.org.id,
    userId: ctx.user.id,
  });
  r.org('listDriveMounts', async (ctx) => {
    requireAdmin(ctx);
    return { items: await listAllMounts(ctx.deps.db, ctx.org.id) };
  });
  r.org(
    'createDriveMount',
    async (ctx) => {
      requireAdmin(ctx);
      return createMount(ctx.deps, adminCtx(ctx), ctx.body, ctx.req);
    },
    { status: 201 },
  );
  r.org('updateDriveMount', async (ctx) => {
    requireAdmin(ctx);
    return updateMount(ctx.deps, adminCtx(ctx), ctx.params.mountId, ctx.body, ctx.req);
  });
  r.org('deleteDriveMount', async (ctx) => {
    requireAdmin(ctx);
    await deleteMount(ctx.deps, adminCtx(ctx), ctx.params.mountId, ctx.req);
    return {};
  });
  r.org('testDriveMount', async (ctx) => {
    requireAdmin(ctx);
    return testMount(ctx.deps, ctx.org.id, ctx.params.mountId);
  });
  r.org(
    'startOneDriveMove',
    async (ctx) => ({
      items: await startOneDriveMove(ctx.deps, driveActor(ctx), ctx.body, ctx.req),
    }),
    { status: 201 },
  );
  r.org('listSpaceMounts', async (ctx) => ({
    items: await listSpaceMounts(ctx.deps.db, driveActor(ctx), ctx.params.spaceId),
  }));
  r.org('listMountItems', async (ctx) =>
    listMountItems(ctx.deps, driveActor(ctx), ctx.params.mountId, ctx.query.path),
  );
  r.org(
    'createMountFolder',
    async (ctx) => createMountFolder(ctx.deps, driveActor(ctx), ctx.params.mountId, ctx.body),
    { status: 201 },
  );
  r.org(
    'startMountImport',
    async (ctx) => startMountImport(ctx.deps, driveActor(ctx), ctx.body, ctx.req),
    { status: 201 },
  );
  r.org('listImportJobs', async (ctx) => ({
    items: await listImportJobs(ctx.deps.db, driveActor(ctx)),
  }));

  r.rawOrg(
    'GET',
    MICROSOFT_RAW_PATHS.mountDownload(':mountId'),
    async ({ c, deps, org, actor, user }) => {
      const path = MountPath.safeParse(c.req.query('path') ?? '');
      if (!path.success) throw new AppError('mount_item_not_found');
      const file = await readMountFile(
        deps,
        { org, actor, userId: user.id },
        c.req.param('mountId') ?? '',
        path.data,
      );
      return c.body(new Uint8Array(file.body), 200, {
        'content-type': file.mime ?? 'application/octet-stream',
        'content-disposition': contentDisposition(file.name),
        'content-length': String(file.body.length),
        'x-content-type-options': 'nosniff',
        'cache-control': 'private, no-store',
      });
    },
  );
  r.rawOrg(
    'PUT',
    MICROSOFT_RAW_PATHS.mountUpload(':mountId'),
    async ({ c, deps, org, actor, user }) => {
      const folder = MountPath.safeParse(c.req.query('path') ?? '');
      const name = (c.req.query('name') ?? '').trim();
      if (!folder.success || !name || /[\\/]/.test(name) || name.length > 255) {
        throw new AppError('bad_request', { reason: 'name' });
      }
      const { maxFileBytes } = orgLimits(org);
      const declared = Number(c.req.header('content-length') ?? NaN);
      if (Number.isFinite(declared) && declared > maxFileBytes) {
        throw new AppError('file_too_large', { maxFileBytes });
      }
      const content = Buffer.from(await c.req.arrayBuffer());
      if (content.length > maxFileBytes) throw new AppError('file_too_large', { maxFileBytes });
      const item = await writeMountFile(
        deps,
        { org, actor, userId: user.id },
        c.req.param('mountId') ?? '',
        {
          folder: folder.data,
          name,
          content,
          mime: c.req.header('content-type') ?? null,
        },
      );
      return c.json(item, 201);
    },
  );
}

function contentDisposition(filename: string) {
  const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
