import {
  INTEGRATION_KEYS,
  type DriveMount,
  type IntegrationKey,
  type MicrosoftIntegrations,
  type MountItem,
  type ScimToken,
} from '@crewhall/shared';
import { memberOf, MockApiError, randomToken, requireUser, type Resolvers } from './core';
import { newId } from './db';
import { identityMockState } from './identity';
import type { MockState } from './seed';

/**
 * Microsoft integrations in mock mode: settings in memory, a made-up SharePoint library with a
 * few items, and one open upload request (`/u/demo`). Nothing talks to Microsoft.
 */
interface MicrosoftMock {
  overview: MicrosoftIntegrations;
  mounts: DriveMount[];
  items: MountItem[];
}

function state(s: MockState): MicrosoftMock {
  const holder = s as MockState & { microsoft?: MicrosoftMock };
  holder.microsoft ??= {
    overview: {
      switches: Object.fromEntries(INTEGRATION_KEYS.map((k) => [k, false])) as Record<
        IntegrationKey,
        boolean
      >,
      app: {
        tenantId: null,
        clientId: null,
        secretSet: false,
        secretHint: null,
        lastTestAt: null,
        lastTestOk: null,
        lastError: null,
      },
      entra: {
        providers: [],
        scimUrl: `${window.location.origin}/api/scim/v2`,
        tokens: [],
        provisioned: 0,
        deactivated: 0,
      },
      outlook: { clientId: null },
      teams: {
        clientId: null,
        botAppId: null,
        messagingEndpoint: `${window.location.origin}/api/integrations/teams/messages`,
        linkedPeople: 0,
      },
      storage: { mounts: 0 },
    },
    mounts: [],
    items: [
      {
        name: '2026',
        path: '2026',
        type: 'folder',
        sizeBytes: null,
        mime: null,
        modifiedAt: '2026-10-20T10:00:00.000Z',
      },
      {
        name: 'ozet.pdf',
        path: 'ozet.pdf',
        type: 'file',
        sizeBytes: 182_000,
        mime: 'application/pdf',
        modifiedAt: '2026-10-21T09:00:00.000Z',
      },
    ],
  };
  return holder.microsoft;
}

function requireAdmin(s: MockState) {
  const u = requireUser(s);
  const role = memberOf(s, u.id)?.role;
  if (role !== 'owner' && role !== 'admin') throw new MockApiError('forbidden');
  return u;
}

function mountOrThrow(s: MockState, id: string | undefined) {
  const m = state(s).mounts.find((x) => x.id === id);
  if (!m) throw new MockApiError('not_found');
  return m;
}

export const microsoftResolvers: Resolvers<
  | 'getMicrosoftIntegrations'
  | 'updateMicrosoftApp'
  | 'testMicrosoftApp'
  | 'updateMicrosoftIntegration'
  | 'createScimToken'
  | 'revokeScimToken'
  | 'listDriveMounts'
  | 'createDriveMount'
  | 'deleteDriveMount'
  | 'testDriveMount'
  | 'listImportJobs'
  | 'startOneDriveMove'
  | 'listSpaceMounts'
  | 'listMountItems'
  | 'getPublicUploadRequest'
  | 'uploadToRequest'
> = {
  getMicrosoftIntegrations: ({ s }) => {
    requireAdmin(s);
    const m = state(s);
    m.overview.entra.providers = identityMockState(s)
      .providers.filter((p) => p.kind !== 'ldap')
      .map((p) => ({ id: p.id, name: p.name, preset: p.preset, enabled: p.enabled }));
    return m.overview;
  },
  updateMicrosoftApp: ({ s, body }) => {
    requireAdmin(s);
    const app = state(s).overview.app;
    Object.assign(app, {
      tenantId: body.tenantId,
      clientId: body.clientId,
      ...(body.clientSecret ? { secretSet: true, secretHint: body.clientSecret.slice(-4) } : {}),
    });
    return app;
  },
  testMicrosoftApp: ({ s }) => {
    requireAdmin(s);
    const app = state(s).overview.app;
    if (!app.secretSet) throw new MockApiError('microsoft_app_missing');
    return { ok: true, roles: ['Sites.ReadWrite.All', 'Files.ReadWrite.All'], error: null };
  },
  updateMicrosoftIntegration: ({ s, params, body }) => {
    requireAdmin(s);
    const o = state(s).overview;
    const key = params.integration as IntegrationKey;
    if (!INTEGRATION_KEYS.includes(key)) throw new MockApiError('not_found');
    if (key === 'teams' && body.botAppId) o.teams.botAppId = body.botAppId;
    if (key === 'teams' && body.enabled && !o.teams.botAppId) {
      throw new MockApiError('validation_failed');
    }
    o.switches[key] = body.enabled;
    if (key === 'outlook' && body.enabled) o.outlook.clientId ??= 'crewhall-outlook-mock';
    if (key === 'teams' && body.enabled) o.teams.clientId ??= 'crewhall-teams-mock';
    return o;
  },
  createScimToken: ({ s, body }) => {
    requireAdmin(s);
    const o = state(s).overview;
    const provider = o.entra.providers.find((p) => p.id === body.providerId);
    if (!provider) throw new MockApiError('not_found');
    const secret = `mhscim_${randomToken(30)}`;
    const token: ScimToken = {
      id: newId(),
      name: body.name,
      providerId: provider.id,
      providerName: provider.name,
      hint: secret.slice(-4),
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    };
    o.entra.tokens.push(token);
    return { token, secret };
  },
  revokeScimToken: ({ s, params }) => {
    requireAdmin(s);
    const o = state(s).overview;
    o.entra.tokens = o.entra.tokens.filter((t) => t.id !== params.tokenId);
    return {};
  },
  listDriveMounts: ({ s }) => {
    requireAdmin(s);
    return { items: state(s).mounts };
  },
  createDriveMount: ({ s, body }) => {
    requireAdmin(s);
    const space = s.spaces.find((x) => x.id === body.spaceId);
    if (!space) throw new MockApiError('validation_failed');
    const location =
      body.kind === 'sharepoint'
        ? body.config.siteUrl
        : body.kind === 'onedrive'
          ? `OneDrive › ${body.config.user}`
          : body.config.share;
    const mount: DriveMount = {
      id: newId(),
      spaceId: space.id,
      spaceName: space.name,
      name: body.name,
      kind: body.kind,
      location,
      readOnly: body.readOnly,
      lastCheckAt: new Date().toISOString(),
      lastOk: true,
      lastError: null,
      createdAt: new Date().toISOString(),
    };
    state(s).mounts.push(mount);
    state(s).overview.storage.mounts = state(s).mounts.length;
    return mount;
  },
  deleteDriveMount: ({ s, params }) => {
    requireAdmin(s);
    const m = state(s);
    m.mounts = m.mounts.filter((x) => x.id !== params.mountId);
    m.overview.storage.mounts = m.mounts.length;
    return {};
  },
  testDriveMount: ({ s, params }) => {
    requireAdmin(s);
    mountOrThrow(s, params.mountId);
    return { ok: true, error: null };
  },
  listImportJobs: ({ s }) => {
    requireUser(s);
    return { items: [] };
  },
  startOneDriveMove: ({ s }) => {
    requireAdmin(s);
    return { items: [] };
  },
  listSpaceMounts: ({ s, params }) => {
    requireUser(s);
    const m = state(s);
    if (!m.overview.switches.externalStorage) return { items: [] };
    return { items: m.mounts.filter((x) => x.spaceId === params.spaceId) };
  },
  listMountItems: ({ s, params, query }) => {
    requireUser(s);
    const mount = mountOrThrow(s, params.mountId);
    const path = query.path;
    return {
      mount,
      path,
      items: path ? [] : state(s).items,
      canWrite: !mount.readOnly,
    };
  },
  getPublicUploadRequest: ({ params }) => {
    if (params.token !== 'demo') throw new MockApiError('upload_request_closed');
    return {
      requestedBy: 'Ahmet Buğra Kösen',
      orgName: 'Milvasoft',
      folderName: 'Teklif dosyaları',
      expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      passwordRequired: false,
      maxFileBytes: 100 * 1024 * 1024,
    };
  },
  uploadToRequest: ({ params, body }) => {
    if (params.token !== 'demo') throw new MockApiError('upload_request_closed');
    return { name: body.name, sizeBytes: Math.floor((body.contentBase64.length * 3) / 4) };
  },
};
