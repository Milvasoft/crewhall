import { Empty, def, items, type EndpointDef } from '../endpoint-def';
import {
  CreateDriveMount,
  CreatedScimToken,
  CreateMountFolder,
  CreateScimToken,
  CreateUploadRequest,
  DriveMount,
  ImportJob,
  MicrosoftApp,
  MicrosoftAppTest,
  MicrosoftIntegrations,
  MountItem,
  MountItemsQuery,
  MountListing,
  MountTestResult,
  PublicUploadRequest,
  SavedToCrewhall,
  SaveToCrewhall,
  ShareAttachment,
  SharedAttachment,
  StartImport,
  StartOneDriveMove,
  TeamsDraft,
  TeamsLinkCode,
  UpdateDriveMount,
  UpdateMicrosoftApp,
  UpdateMicrosoftIntegration,
  UploadedToRequest,
  UploadRequest,
  UploadToRequest,
  type IntegrationKey,
} from '../schemas/microsoft';

/**
 * Microsoft integrations contract (sonraki-isler.md "Microsoft entegrasyonları"). The SCIM
 * server, the add-in manifest, the Teams package and bot, and mount downloads are raw paths
 * (MICROSOFT_RAW_PATHS). Integration switches are checked by the handlers
 * (INTEGRATION_OF_ENDPOINT), not by the module guard: they default to off.
 */
export const microsoftEndpoints = {
  /* ------------------------- Yönetim › Entegrasyonlar › Microsoft ------------------------- */

  /** Owner/admin: app registration, switches, SCIM tokens, Teams bot, mounts count. */
  getMicrosoftIntegrations: def({
    method: 'GET',
    path: '/api/v1/integrations/microsoft',
    auth: 'session',
    response: MicrosoftIntegrations,
  }),
  updateMicrosoftApp: def({
    method: 'PUT',
    path: '/api/v1/integrations/microsoft/app',
    auth: 'session',
    body: UpdateMicrosoftApp,
    response: MicrosoftApp,
  }),
  /** Gets an app-only Graph token with the stored registration and lists its roles. */
  testMicrosoftApp: def({
    method: 'POST',
    path: '/api/v1/integrations/microsoft/app/test',
    auth: 'session',
    response: MicrosoftAppTest,
  }),
  /** Switch one integration; Outlook and Teams get their OIDC client the first time. */
  updateMicrosoftIntegration: def({
    method: 'PUT',
    path: '/api/v1/integrations/microsoft/switches/:integration',
    auth: 'session',
    body: UpdateMicrosoftIntegration,
    response: MicrosoftIntegrations,
  }),
  createScimToken: def({
    method: 'POST',
    path: '/api/v1/integrations/microsoft/scim-tokens',
    auth: 'session',
    body: CreateScimToken,
    response: CreatedScimToken,
  }),
  revokeScimToken: def({
    method: 'DELETE',
    path: '/api/v1/integrations/microsoft/scim-tokens/:tokenId',
    auth: 'session',
    response: Empty,
  }),
  /** Every mount of the org (admin). */
  listDriveMounts: def({
    method: 'GET',
    path: '/api/v1/integrations/microsoft/mounts',
    auth: 'session',
    response: items(DriveMount),
  }),
  createDriveMount: def({
    method: 'POST',
    path: '/api/v1/integrations/microsoft/mounts',
    auth: 'session',
    body: CreateDriveMount,
    response: DriveMount,
  }),
  updateDriveMount: def({
    method: 'PATCH',
    path: '/api/v1/integrations/microsoft/mounts/:mountId',
    auth: 'session',
    body: UpdateDriveMount,
    response: DriveMount,
  }),
  deleteDriveMount: def({
    method: 'DELETE',
    path: '/api/v1/integrations/microsoft/mounts/:mountId',
    auth: 'session',
    response: Empty,
  }),
  testDriveMount: def({
    method: 'POST',
    path: '/api/v1/integrations/microsoft/mounts/:mountId/test',
    auth: 'session',
    response: MountTestResult,
  }),
  /** Move tool: each person's OneDrive into their personal space (one job per person). */
  startOneDriveMove: def({
    method: 'POST',
    path: '/api/v1/integrations/microsoft/onedrive-move',
    auth: 'session',
    body: StartOneDriveMove,
    response: items(ImportJob),
  }),

  /* ---------------------------------- external storage ---------------------------------- */

  /** Mounts of a space the caller can see; empty while external storage is off. */
  listSpaceMounts: def({
    method: 'GET',
    path: '/api/v1/spaces/:spaceId/mounts',
    auth: 'session',
    response: items(DriveMount),
  }),
  listMountItems: def({
    method: 'GET',
    path: '/api/v1/mounts/:mountId/items',
    auth: 'session',
    query: MountItemsQuery,
    response: MountListing,
  }),
  createMountFolder: def({
    method: 'POST',
    path: '/api/v1/mounts/:mountId/folders',
    auth: 'session',
    body: CreateMountFolder,
    response: MountItem,
  }),
  /** Copy a mount folder (or, admins, a OneDrive) into Drive in the background. */
  startMountImport: def({
    method: 'POST',
    path: '/api/v1/mounts/imports',
    auth: 'session',
    body: StartImport,
    response: ImportJob,
  }),
  /** The caller's copies; admins see every copy and move of the org. */
  listImportJobs: def({
    method: 'GET',
    path: '/api/v1/mounts/imports',
    auth: 'session',
    response: items(ImportJob),
  }),

  /* ----------------------------- Outlook add-in and Teams app ----------------------------- */

  /** A mail (Outlook) or a message (Teams) as a page, a card or a chat message. */
  saveToCrewhall: def({
    method: 'POST',
    path: '/api/v1/integrations/save',
    auth: 'session',
    body: SaveToCrewhall,
    response: SavedToCrewhall,
  }),
  /** Outlook compose: an attachment into Drive (personal space › "Outlook ekleri") as a link. */
  shareAttachment: def({
    method: 'POST',
    path: '/api/v1/integrations/outlook/attachments',
    auth: 'session',
    body: ShareAttachment,
    response: SharedAttachment,
  }),
  createUploadRequest: def({
    method: 'POST',
    path: '/api/v1/upload-requests',
    auth: 'session',
    body: CreateUploadRequest,
    response: UploadRequest,
  }),
  /** The caller's open and recent upload requests. */
  listUploadRequests: def({
    method: 'GET',
    path: '/api/v1/upload-requests',
    auth: 'session',
    response: items(UploadRequest),
  }),
  revokeUploadRequest: def({
    method: 'DELETE',
    path: '/api/v1/upload-requests/:requestId',
    auth: 'session',
    response: Empty,
  }),
  getPublicUploadRequest: def({
    method: 'GET',
    path: '/api/v1/public/upload-requests/:token',
    auth: 'public',
    response: PublicUploadRequest,
  }),
  uploadToRequest: def({
    method: 'POST',
    path: '/api/v1/public/upload-requests/:token/files',
    auth: 'public',
    body: UploadToRequest,
    response: UploadedToRequest,
  }),
  /** Teams sign-in popup: a code the message extension trades for the person's link. */
  createTeamsLinkCode: def({
    method: 'POST',
    path: '/api/v1/integrations/teams/link-code',
    auth: 'session',
    response: TeamsLinkCode,
  }),
  getTeamsDraft: def({
    method: 'GET',
    path: '/api/v1/integrations/teams/drafts/:draftId',
    auth: 'session',
    response: TeamsDraft,
  }),
} as const satisfies Record<string, EndpointDef>;

/** Endpoints that work only while an integration is on (checked in the handlers). */
export const INTEGRATION_OF_ENDPOINT: Readonly<
  Partial<Record<keyof typeof microsoftEndpoints, IntegrationKey>>
> = {
  listMountItems: 'externalStorage',
  createMountFolder: 'externalStorage',
  startMountImport: 'externalStorage',
  shareAttachment: 'outlook',
  createUploadRequest: 'outlook',
  getPublicUploadRequest: 'outlook',
  uploadToRequest: 'outlook',
  createTeamsLinkCode: 'teams',
  getTeamsDraft: 'teams',
};

/**
 * What the Outlook add-in and the Teams app may call with their OIDC access token (the
 * integration bearer); everything else answers 403 for that token.
 */
export const INTEGRATION_TOKEN_ENDPOINTS: Readonly<Record<'outlook' | 'teams', readonly string[]>> =
  {
    outlook: [
      'me',
      'listSpaces',
      'listNodes',
      'listBoards',
      'getBoard',
      'listConversations',
      'saveToCrewhall',
      'shareAttachment',
      'createUploadRequest',
      'listUploadRequests',
      'revokeUploadRequest',
    ],
    teams: [
      'me',
      'listSpaces',
      'listNodes',
      'searchNodes',
      'listBoards',
      'getBoard',
      'getPage',
      'exportPage',
      'listConversations',
      'saveToCrewhall',
      'getTeamsDraft',
    ],
  };
