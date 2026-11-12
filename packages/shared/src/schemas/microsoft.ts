import { z } from 'zod';
import { Id, Timestamp } from './common';

/*
 * Microsoft integrations (sonraki-isler.md "Microsoft entegrasyonları"): Entra ID connector with
 * a SCIM 2.0 server, the Outlook add-in, the Teams app and SharePoint / OneDrive / SMB external
 * storage. Each one is switched on in Yönetim › Entegrasyonlar; all are off until then.
 */

/** Integration switches (`OrgSettings.integrations`); unlike modules, a missing key means off. */
export const INTEGRATION_KEYS = ['entra', 'outlook', 'teams', 'externalStorage'] as const;
export const IntegrationKey = z.enum(INTEGRATION_KEYS);
export type IntegrationKey = z.infer<typeof IntegrationKey>;

// ---------------------------------------------------------------------------------------
// Paths outside the contract table
// ---------------------------------------------------------------------------------------

export const MICROSOFT_RAW_PATHS = {
  /** SCIM 2.0 base URL (RFC 7643/7644) for Entra provisioning; bearer = SCIM token. */
  scimBase: '/api/scim/v2',
  /** GET, admin session: the org's Outlook add-in manifest (XML, add-in only manifest). */
  outlookManifest: '/api/integrations/outlook/manifest.xml',
  /** GET, admin session: the org's Teams app package (zip: manifest.json and two icons). */
  teamsPackage: '/api/integrations/teams/app.zip',
  /** POST from the Bot Framework: message extension invokes (search, "Crewhall'a kaydet"). */
  teamsMessages: '/api/integrations/teams/messages',
  /** GET, session: a file of an external storage mount (`?path=`), streamed. */
  mountDownload: (mountId: string) => `/api/v1/mounts/${mountId}/download`,
  /** PUT, session: raw body uploaded into a mount folder (`?path=<folder>&name=<file>`). */
  mountUpload: (mountId: string) => `/api/v1/mounts/${mountId}/upload`,
} as const;

/** Web routes the Office add-in and the Teams app open (task pane, dialogs, tab). */
export const MICROSOFT_WEB_PATHS = {
  outlookPane: '/office/outlook',
  /** OIDC sign-in dialog of the add-in and the Teams app; `?client=` = their OIDC client id. */
  officeSignIn: '/office/signin',
  officeCallback: '/office/callback',
  teamsLink: '/teams/link',
  teamsSave: '/teams/save',
  teamsTabConfig: '/teams/tab/config',
  teamsTab: '/teams/tab',
  uploadRequest: (token: string) => `/u/${token}`,
} as const;

// ---------------------------------------------------------------------------------------
// Administration: app registration, switches, SCIM tokens
// ---------------------------------------------------------------------------------------

/** Tenant: directory (tenant) id or a verified domain. */
const Tenant = z
  .string()
  .trim()
  .min(3)
  .max(200)
  .regex(/^[A-Za-z0-9.-]+$/);

/** The org's Entra app registration, used for Graph (storage, OneDrive move, group overage). */
export const MicrosoftApp = z.object({
  tenantId: z.string().nullable(),
  clientId: z.string().nullable(),
  secretSet: z.boolean(),
  /** Last four characters of the stored secret. */
  secretHint: z.string().nullable(),
  lastTestAt: Timestamp.nullable(),
  lastTestOk: z.boolean().nullable(),
  lastError: z.string().nullable(),
});
export type MicrosoftApp = z.infer<typeof MicrosoftApp>;

export const UpdateMicrosoftApp = z.object({
  tenantId: Tenant,
  clientId: z.uuid(),
  /** Omit to keep the stored secret. */
  clientSecret: z.string().trim().min(8).max(500).optional(),
});
export type UpdateMicrosoftApp = z.infer<typeof UpdateMicrosoftApp>;

export const MicrosoftAppTest = z.object({
  ok: z.boolean(),
  /** Graph application permissions (roles) granted to the app, from the app token. */
  roles: z.array(z.string()),
  error: z.string().nullable(),
});
export type MicrosoftAppTest = z.infer<typeof MicrosoftAppTest>;

export const ScimToken = z.object({
  id: Id,
  name: z.string(),
  providerId: Id,
  providerName: z.string(),
  hint: z.string(),
  createdAt: Timestamp,
  lastUsedAt: Timestamp.nullable(),
});
export type ScimToken = z.infer<typeof ScimToken>;

export const CreateScimToken = z.object({
  name: z.string().trim().min(1).max(80),
  /** OIDC or SAML provider (usually the Entra preset) whose mappings SCIM groups use. */
  providerId: Id,
});
export type CreateScimToken = z.infer<typeof CreateScimToken>;

/** Shown once; only its hash is stored. */
export const CreatedScimToken = z.object({ token: ScimToken, secret: z.string() });

export const MicrosoftIntegrations = z.object({
  switches: z.record(IntegrationKey, z.boolean()),
  app: MicrosoftApp,
  entra: z.object({
    /** OIDC / SAML providers that can back SCIM (Entra preset first). */
    providers: z.array(
      z.object({ id: Id, name: z.string(), preset: z.string(), enabled: z.boolean() }),
    ),
    scimUrl: z.url(),
    tokens: z.array(ScimToken),
    /** People SCIM created or linked, and how many of them it deactivated. */
    provisioned: z.number().int(),
    deactivated: z.number().int(),
  }),
  outlook: z.object({
    /** OIDC client the add-in signs in with; created when the add-in is switched on. */
    clientId: z.string().nullable(),
  }),
  teams: z.object({
    clientId: z.string().nullable(),
    /** Microsoft App ID of the Azure Bot that carries the message extension. */
    botAppId: z.string().nullable(),
    messagingEndpoint: z.url(),
    linkedPeople: z.number().int(),
  }),
  storage: z.object({ mounts: z.number().int() }),
});
export type MicrosoftIntegrations = z.infer<typeof MicrosoftIntegrations>;

export const UpdateMicrosoftIntegration = z.object({
  enabled: z.boolean(),
  /** Teams only: the bot's Microsoft App ID (required to switch Teams on). */
  botAppId: z.uuid().optional(),
});
export type UpdateMicrosoftIntegration = z.infer<typeof UpdateMicrosoftIntegration>;

// ---------------------------------------------------------------------------------------
// Outlook add-in and Teams: saving mail and messages, attachments as links, upload requests
// ---------------------------------------------------------------------------------------

export const SaveTarget = z.discriminatedUnion('kind', [
  /** A new page in a space (under `parentId` when given). */
  z.object({ kind: z.literal('page'), spaceId: Id, parentId: Id.nullable().optional() }),
  /** A card on a board (first column unless `columnId`). */
  z.object({ kind: z.literal('card'), boardId: Id, columnId: Id.optional() }),
  /** A message in a conversation. */
  z.object({ kind: z.literal('chat'), conversationId: Id }),
]);
export type SaveTarget = z.infer<typeof SaveTarget>;

export const SAVE_LIMITS = { textChars: 100_000, titleChars: 300 } as const;

export const SaveToCrewhall = z.object({
  source: z.enum(['outlook', 'teams']),
  target: SaveTarget,
  title: z.string().trim().min(1).max(SAVE_LIMITS.titleChars),
  from: z
    .object({ name: z.string().max(200).nullable(), email: z.string().max(320).nullable() })
    .nullable(),
  sentAt: Timestamp.nullable(),
  /** Plain text of the mail or message (HTML is converted on the client). */
  text: z.string().max(SAVE_LIMITS.textChars),
  /** Link back to the original (Outlook web link, Teams message link). */
  link: z.url().max(2000).nullable().optional(),
});
export type SaveToCrewhall = z.infer<typeof SaveToCrewhall>;

export const SavedToCrewhall = z.object({
  kind: z.enum(['page', 'card', 'chat']),
  id: Id,
  /** Web path of what was created (page, card or the conversation). */
  path: z.string(),
});
export type SavedToCrewhall = z.infer<typeof SavedToCrewhall>;

/** An attachment turned into a Drive link (Outlook compose). */
export const OUTLOOK_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

export const ShareAttachment = z.object({
  name: z.string().trim().min(1).max(255),
  mime: z.string().max(200).nullable(),
  contentBase64: z
    .string()
    .min(1)
    .max(Math.ceil((OUTLOOK_ATTACHMENT_MAX_BYTES * 4) / 3) + 4),
  password: z.string().min(4).max(128).optional(),
  expiresAt: Timestamp.nullable().optional(),
});
export type ShareAttachment = z.infer<typeof ShareAttachment>;

export const SharedAttachment = z.object({
  nodeId: Id,
  url: z.url(),
  expiresAt: Timestamp.nullable(),
  passwordProtected: z.boolean(),
});
export type SharedAttachment = z.infer<typeof SharedAttachment>;

/** "Bana dosya yükle": a public link that only lets people upload into one folder. */
export const UploadRequest = z.object({
  id: Id,
  folderId: Id,
  folderName: z.string(),
  spaceId: Id,
  /** Only in the create response (the token is stored hashed). */
  url: z.url().optional(),
  expiresAt: Timestamp,
  passwordProtected: z.boolean(),
  uploads: z.number().int(),
  createdAt: Timestamp,
  revokedAt: Timestamp.nullable(),
});
export type UploadRequest = z.infer<typeof UploadRequest>;

export const CreateUploadRequest = z.object({
  /** Name of the folder made for the uploads (in the personal space unless `spaceId`). */
  folderName: z.string().trim().min(1).max(200),
  spaceId: Id.optional(),
  parentId: Id.nullable().optional(),
  /** At most 30 days ahead; default 7 days. */
  expiresAt: Timestamp.optional(),
  password: z.string().min(4).max(128).optional(),
});
export type CreateUploadRequest = z.infer<typeof CreateUploadRequest>;

export const UPLOAD_REQUEST_LIMITS = {
  fileBytes: 100 * 1024 * 1024,
  maxDays: 30,
  defaultDays: 7,
  /** Per link (burst); each address also has its own, smaller limit. */
  filesPerMinute: 20,
} as const;

export const PublicUploadRequest = z.object({
  /** Who asked (name only) and the org's name for the page header. */
  requestedBy: z.string(),
  orgName: z.string(),
  folderName: z.string(),
  expiresAt: Timestamp,
  passwordRequired: z.boolean(),
  maxFileBytes: z.number().int(),
});
export type PublicUploadRequest = z.infer<typeof PublicUploadRequest>;

export const UploadToRequest = z.object({
  name: z.string().trim().min(1).max(255),
  mime: z.string().max(200).nullable(),
  contentBase64: z
    .string()
    .min(1)
    .max(Math.ceil((UPLOAD_REQUEST_LIMITS.fileBytes * 4) / 3) + 4),
  password: z.string().max(128).optional(),
  /** Uploader's name, shown in the folder's activity. */
  uploaderName: z.string().trim().max(120).optional(),
});
export type UploadToRequest = z.infer<typeof UploadToRequest>;

export const UploadedToRequest = z.object({ name: z.string(), sizeBytes: z.number().int() });

/** Single-use code the Teams sign-in popup hands to the message extension (`state`). */
export const TeamsLinkCode = z.object({ code: z.string(), expiresAt: Timestamp });

/** A Teams message waiting in "Crewhall'a kaydet" (stored by the bot for 15 minutes). */
export const TeamsDraft = z.object({
  id: Id,
  title: z.string(),
  text: z.string(),
  from: z.string().nullable(),
  sentAt: Timestamp.nullable(),
  link: z.url().nullable(),
});
export type TeamsDraft = z.infer<typeof TeamsDraft>;

// ---------------------------------------------------------------------------------------
// External storage: SharePoint, OneDrive (Graph) and SMB shares as Drive mounts
// ---------------------------------------------------------------------------------------

export const MountKind = z.enum(['sharepoint', 'onedrive', 'smb']);
export type MountKind = z.infer<typeof MountKind>;

/** Path inside a mount: `/`-separated, no `..`, no leading slash (empty = mount root). */
export const MountPath = z
  .string()
  .max(1000)
  .refine((p) => !p.split('/').some((s) => s === '..' || s === '.'), 'invalid path')
  .transform((p) => p.replace(/^\/+|\/+$/g, ''));

export const SharePointMountConfig = z.object({
  /** Site URL, e.g. https://contoso.sharepoint.com/sites/Finans */
  siteUrl: z.url().max(500),
  /** Document library name; empty = the site's default library. */
  library: z.string().trim().max(200).default(''),
  rootPath: MountPath.default(''),
});

export const OneDriveMountConfig = z.object({
  /** OneDrive owner's user principal name (e-mail). */
  user: z.string().trim().min(3).max(320),
  rootPath: MountPath.default(''),
});

export const SmbMountConfig = z.object({
  /** `\\server\share` or `//server/share`. */
  share: z
    .string()
    .trim()
    .regex(/^(\\\\|\/\/)[^\\/\s]+[\\/][^\\/]+$/, '\\\\server\\share'),
  domain: z.string().trim().max(200).default(''),
  username: z.string().trim().min(1).max(200),
  rootPath: MountPath.default(''),
});

export const MountConfig = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('sharepoint'), config: SharePointMountConfig }),
  z.object({ kind: z.literal('onedrive'), config: OneDriveMountConfig }),
  z.object({
    kind: z.literal('smb'),
    config: SmbMountConfig,
    /** SMB password; omit on update to keep it. */
    password: z.string().max(500).optional(),
  }),
]);

export const CreateDriveMount = z.intersection(
  z.object({
    spaceId: Id,
    name: z.string().trim().min(1).max(120),
    readOnly: z.boolean().default(false),
  }),
  MountConfig,
);
export type CreateDriveMount = z.infer<typeof CreateDriveMount>;

export const UpdateDriveMount = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  readOnly: z.boolean().optional(),
  password: z.string().max(500).optional(),
});
export type UpdateDriveMount = z.infer<typeof UpdateDriveMount>;

export const DriveMount = z.object({
  id: Id,
  spaceId: Id,
  spaceName: z.string(),
  name: z.string(),
  kind: MountKind,
  /** Where it points, for people: site + library, OneDrive owner or `\\server\share`. */
  location: z.string(),
  readOnly: z.boolean(),
  lastCheckAt: Timestamp.nullable(),
  lastOk: z.boolean().nullable(),
  lastError: z.string().nullable(),
  createdAt: Timestamp,
});
export type DriveMount = z.infer<typeof DriveMount>;

export const MountTestResult = z.object({ ok: z.boolean(), error: z.string().nullable() });

export const MountItem = z.object({
  name: z.string(),
  /** Path inside the mount, for the next listing or a download. */
  path: z.string(),
  type: z.enum(['folder', 'file']),
  sizeBytes: z.number().int().nullable(),
  mime: z.string().nullable(),
  modifiedAt: Timestamp.nullable(),
});
export type MountItem = z.infer<typeof MountItem>;

export const MountItemsQuery = z.object({ path: MountPath.default('') });

export const MountListing = z.object({
  mount: DriveMount,
  path: z.string(),
  items: z.array(MountItem),
  /** The caller may upload and create folders (space editor and the mount is not read-only). */
  canWrite: z.boolean(),
});
export type MountListing = z.infer<typeof MountListing>;

export const CreateMountFolder = z.object({
  path: MountPath,
  name: z.string().trim().min(1).max(255),
});

/** Copy into Drive: a folder of a mount, or a person's whole OneDrive (move tool). */
export const ImportSource = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('mount'), mountId: Id, path: MountPath }),
  /** Admin move tool: the OneDrive of `user` (UPN) into that person's personal space. */
  z.object({ kind: z.literal('onedrive'), user: z.string().trim().min(3).max(320) }),
]);

export const StartImport = z.object({
  source: ImportSource,
  /** Mount copies only; OneDrive moves go to the person's personal space. */
  target: z.object({ spaceId: Id, parentId: Id.nullable() }).optional(),
});
export type StartImport = z.infer<typeof StartImport>;

/** Admin move tool: several OneDrives at once. */
export const StartOneDriveMove = z.object({
  users: z.array(z.string().trim().min(3).max(320)).min(1).max(500),
  /** Folder created in each personal space. */
  folderName: z.string().trim().min(1).max(200).default('OneDrive'),
});
export type StartOneDriveMove = z.infer<typeof StartOneDriveMove>;

export const ImportJob = z.object({
  id: Id,
  source: z.string(),
  status: z.enum(['queued', 'running', 'done', 'failed']),
  files: z.number().int(),
  bytes: z.number().int(),
  skipped: z.number().int(),
  error: z.string().nullable(),
  targetSpaceId: Id,
  targetFolderId: Id.nullable(),
  createdAt: Timestamp,
  finishedAt: Timestamp.nullable(),
});
export type ImportJob = z.infer<typeof ImportJob>;
