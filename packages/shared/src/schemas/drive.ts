import { z } from 'zod';
import { Id, Timestamp } from './common';
import { UserSummary } from './org';
import { SpaceColor, SpaceRole } from './space';

/**
 * Drive (design 03, 19.1-19.5; doc 17 §4, §5, §8). One node tree per space: folders,
 * files and, from later phases, pages, boards and drawings. Real-time updates arrive
 * with the phase 3 WebSocket; until then clients refetch.
 */

export const NodeType = z.enum(['folder', 'file', 'page', 'board', 'drawing']);
export type NodeType = z.infer<typeof NodeType>;

/** Types that can hold children (doc 17 §4; boards and drawings cannot). */
export const CONTAINER_NODE_TYPES = ['folder', 'page'] as const satisfies readonly NodeType[];

export const NodeName = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine((s) => !/[/\\\u0000]/.test(s), 'Name cannot contain / or \\');

/** Single file limit and multipart part size (doc 17 §8). */
export const UPLOAD_PART_SIZE = 16 * 1024 * 1024;
export const DEFAULT_MAX_FILE_BYTES = 5 * 1024 ** 3;
/** Days a trashed node stays restorable. */
export const TRASH_RETENTION_DAYS = 30;

export const PreviewKind = z.enum(['thumb_256', 'thumb_1024', 'pdf_p1', 'poster']);
export type PreviewKind = z.infer<typeof PreviewKind>;

/** Thumbnail state of a file node; load it with getPreview once `ready`. */
export const PreviewState = z.enum(['none', 'pending', 'ready', 'failed']);

export const DriveNode = z.object({
  id: Id,
  spaceId: Id,
  parentId: Id.nullable(),
  type: NodeType,
  name: z.string(),
  /** Detected from content once processed (files only). */
  mime: z.string().nullable(),
  /** Logical size: files their current version, folders 0. */
  sizeBytes: z.number().int(),
  hasChildren: z.boolean(),
  /** Caller's effective role: space role or a node share, whichever is higher. */
  myRole: SpaceRole,
  /** The node or an ancestor has person shares or a public link (lock icon, 3.4). */
  shared: z.boolean(),
  favorite: z.boolean(),
  preview: PreviewState,
  /** Current version number for files, null otherwise. */
  version: z.number().int().nullable(),
  createdBy: UserSummary.nullable(),
  updatedBy: UserSummary.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  /** Set while the node is in the trash. */
  deletedAt: Timestamp.nullable(),
});
export type DriveNode = z.infer<typeof DriveNode>;

export const Breadcrumb = z.array(z.object({ id: Id, name: z.string() }));

export const DriveNodeDetail = DriveNode.extend({
  /** From the space root to the parent, for the path bar. */
  path: Breadcrumb,
  space: z.object({ id: Id, name: z.string(), color: SpaceColor }),
});
export type DriveNodeDetail = z.infer<typeof DriveNodeDetail>;

export const NodeSort = z.enum(['name', 'updatedAt', 'size', 'type']);

export const ListNodesQuery = z.object({
  /** Omit for the space root. */
  parentId: Id.optional(),
  type: NodeType.optional(),
  sort: NodeSort.default('name'),
  order: z.enum(['asc', 'desc']).default('asc'),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/**
 * Folders a client keeps for the app itself (pasted page images, page and import attachments).
 * Asked for by role, so the same folder comes back each time; Drive lists, searches and child
 * counts leave them out. Card and table attachment folders are made by the server.
 */
export const SystemFolder = z.enum(['page_images', 'page_attachments', 'import_attachments']);
export type SystemFolder = z.infer<typeof SystemFolder>;

export const CreateFolder = z.object({
  parentId: Id.nullable().default(null),
  name: NodeName,
  /** Find or make the app's folder of this role here instead of a folder of the person's. */
  system: SystemFolder.optional(),
});

export const UpdateNode = z.object({ name: NodeName.optional() });

/** Where to put nodes; `afterId` / `beforeId` place them in manual order (key computed server-side). */
export const NodeTarget = z.object({
  spaceId: Id,
  parentId: Id.nullable(),
  afterId: Id.nullable().optional(),
  beforeId: Id.nullable().optional(),
});

export const MoveNodes = z.object({
  nodeIds: z.array(Id).min(1).max(500),
  target: NodeTarget,
});

export const CopyNodes = MoveNodes;

export const NodeIds = z.object({ nodeIds: z.array(Id).min(1).max(500) });

export const TrashItem = DriveNode.extend({
  deletedAt: Timestamp,
  deletedBy: UserSummary.nullable(),
  /** When the purge job removes it for good. */
  purgeAt: Timestamp,
  /** Names from the space root to where it was, e.g. "Sunumlar / 2025". */
  originalPath: z.string(),
});
export type TrashItem = z.infer<typeof TrashItem>;

/* ---------------------------------- uploads --------------------------------- */

/** What to do when a file with the same name exists in the folder (3.14). */
export const UploadConflict = z.enum(['ask', 'version', 'rename', 'replace']);

export const CreateUpload = z.object({
  spaceId: Id,
  parentId: Id.nullable().default(null),
  name: NodeName,
  sizeBytes: z.number().int().min(0),
  /** Browser-reported type; the server detects the real one from content. */
  mime: z.string().max(255).optional(),
  /** Default `ask`: a name clash answers 409 node_name_taken with `details.nodeId`. */
  onConflict: UploadConflict.default('ask'),
  /** Upload a new version of this file instead of a new node. */
  nodeId: Id.optional(),
  /**
   * With `nodeId`: the version the client edited. When the file's current version differs,
   * creating or completing the upload answers 409 version_conflict; omit it to write anyway.
   */
  baseVersion: z.number().int().min(1).optional(),
});
export type CreateUpload = z.infer<typeof CreateUpload>;

export const UploadStatus = z.enum(['uploading', 'completed', 'aborted', 'expired']);

export const Upload = z.object({
  id: Id,
  spaceId: Id,
  parentId: Id.nullable(),
  /** Set when uploading a new version, and after completion. */
  nodeId: Id.nullable(),
  name: z.string(),
  sizeBytes: z.number().int(),
  partSize: z.number().int(),
  partCount: z.number().int(),
  status: UploadStatus,
  /** Parts the store already has; resume by uploading the rest (design 3.7). */
  uploadedParts: z.array(
    z.object({ partNumber: z.number().int(), sizeBytes: z.number().int(), etag: z.string() }),
  ),
  expiresAt: Timestamp,
  createdAt: Timestamp,
});
export type Upload = z.infer<typeof Upload>;

export const UploadPartsRequest = z.object({
  /** 1-based part numbers; at most 100 per call. */
  partNumbers: z.array(z.number().int().min(1).max(10_000)).min(1).max(100),
});

export const UploadPartUrls = z.object({
  /** PUT the part body to `url` and keep the returned ETag header. */
  parts: z.array(z.object({ partNumber: z.number().int(), url: z.url() })),
  expiresAt: Timestamp,
});

export const CompleteUpload = z.object({
  parts: z
    .array(z.object({ partNumber: z.number().int().min(1), etag: z.string().min(1) }))
    .min(1)
    .max(10_000),
});

/* --------------------------- download, preview, versions --------------------------- */

export const SignedUrl = z.object({
  /** Short-lived (5 min) presigned store address. */
  url: z.url(),
  expiresAt: Timestamp,
});

/**
 * `inline` opens the file in the browser (PDF, images, video, audio, plain text); any other
 * type, HTML and SVG included, is always served as an attachment.
 */
export const Disposition = z.enum(['attachment', 'inline']);
export type Disposition = z.infer<typeof Disposition>;

/** MIME types the server agrees to serve inline (never HTML or SVG: they could run script). */
export function isInlineSafe(mime: string | null | undefined): boolean {
  if (!mime) return false;
  const m = mime.toLowerCase().split(';')[0]!.trim();
  if (m === 'image/svg+xml') return false;
  return (
    m === 'application/pdf' ||
    m === 'text/plain' ||
    m.startsWith('image/') ||
    m.startsWith('video/') ||
    m.startsWith('audio/')
  );
}

export const DownloadUrl = SignedUrl.extend({
  fileName: z.string(),
  sizeBytes: z.number().int(),
  mime: z.string().nullable(),
  /** What the URL was signed with; `attachment` when inline was asked for an unsafe type. */
  disposition: Disposition.optional(),
});

export const DownloadQuery = z.object({
  versionId: Id.optional(),
  /** Default `attachment`. */
  disposition: Disposition.optional(),
});

export const PreviewUrl = SignedUrl.extend({
  kind: PreviewKind,
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
});

export const PreviewQuery = z.object({ kind: PreviewKind.default('thumb_256') });

export const VersionSource = z.enum(['web', 'mobile', 'mcp', 'api']);

export const NodeVersion = z.object({
  id: Id,
  version: z.number().int(),
  sizeBytes: z.number().int(),
  mime: z.string().nullable(),
  label: z.string().nullable(),
  source: VersionSource,
  current: z.boolean(),
  createdBy: UserSummary.nullable(),
  createdAt: Timestamp,
});
export type NodeVersion = z.infer<typeof NodeVersion>;

export const CompletedUpload = z.object({ node: DriveNode, version: NodeVersion });

/* ---------------------------------- shares ---------------------------------- */

/** Node shares only widen access (doc 17 §5); links are always read-only in v1. */
export const ShareRole = z.enum(['viewer', 'editor']);
export type ShareRole = z.infer<typeof ShareRole>;

export const Share = z.object({
  id: Id,
  nodeId: Id,
  kind: z.enum(['user', 'link']),
  role: ShareRole,
  grantee: UserSummary.nullable(),
  expiresAt: Timestamp.nullable(),
  allowDownload: z.boolean(),
  hasPassword: z.boolean(),
  /** Set when the share sits on an ancestor and reaches this node by inheritance. */
  inheritedFrom: z.object({ id: Id, name: z.string() }).nullable(),
  openCount: z.number().int(),
  createdBy: UserSummary.nullable(),
  createdAt: Timestamp,
  /**
   * Public address `HUB_URL/s/<token>` of a link. Shown to the person who made the link and to
   * those who may share links on the node (H16), in lists too, so it can always be copied.
   */
  url: z.url().optional(),
  /**
   * The link was made before addresses were kept (H16): it still works, but its address can't
   * be shown. Regenerate it to get a copyable one (the old address then stops working).
   */
  urlLost: z.boolean().optional(),
});
export type Share = z.infer<typeof Share>;

export const CreateShare = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('user'),
    /** An org member (guests too); a person cannot grant more than their own role. */
    userId: Id,
    role: ShareRole,
    expiresAt: Timestamp.nullable().optional(),
  }),
  z.object({
    kind: z.literal('link'),
    role: z.literal('viewer').default('viewer'),
    expiresAt: Timestamp.nullable().optional(),
    password: z.string().min(4).max(128).optional(),
    allowDownload: z.boolean().default(true),
  }),
]);
export type CreateShare = z.infer<typeof CreateShare>;

export const UpdateShare = z.object({
  role: ShareRole.optional(),
  expiresAt: Timestamp.nullable().optional(),
  allowDownload: z.boolean().optional(),
  /** null removes the password. */
  password: z.string().min(4).max(128).nullable().optional(),
});

export const NodeShares = z.object({
  items: z.array(Share),
  /** Space members reach the node through their space role (3.11, first layer). */
  space: z.object({ id: Id, name: z.string(), memberCount: z.number().int() }),
});

/* ------------------------------ public links (/s/:token) ------------------------------ */

export const PublicNode = z.object({
  id: Id,
  type: NodeType,
  name: z.string(),
  mime: z.string().nullable(),
  sizeBytes: z.number().int(),
  hasChildren: z.boolean(),
  preview: PreviewState,
  updatedAt: Timestamp,
});
export type PublicNode = z.infer<typeof PublicNode>;

const PublicShareBase = z.object({
  orgName: z.string(),
  sharedBy: z.object({ name: z.string() }),
});

/**
 * GET /api/v1/public/shares/:token. Unknown, revoked and deleted links all answer 404
 * not_found (19.3); expired ones 410 share_expired with `details.sharedByName`.
 */
export const PublicShare = z.discriminatedUnion('status', [
  PublicShareBase.extend({ status: z.literal('password_required') }),
  PublicShareBase.extend({
    status: z.literal('ok'),
    node: PublicNode,
    allowDownload: z.boolean(),
    expiresAt: Timestamp.nullable(),
  }),
]);
export type PublicShare = z.infer<typeof PublicShare>;

/** `grant` from unlockPublicShare; required on every public call of a password link. */
export const PublicShareQuery = z.object({ grant: z.string().optional() });

export const UnlockPublicShare = z.object({ password: z.string().min(1).max(128) });

/** Valid 12 hours (19.2: "Doğru şifre bu tarayıcıda 12 saat hatırlanır"). */
export const PublicShareGrant = z.object({ grant: z.string(), expiresAt: Timestamp });

export const PublicChildrenQuery = PublicShareQuery.extend({
  /** A folder inside the shared folder; omit for the shared folder itself. */
  parentId: Id.optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const PublicFileQuery = PublicShareQuery.extend({
  /** A file inside a shared folder; omit for the shared file itself. */
  nodeId: Id.optional(),
  /** Default `attachment`; see Disposition. */
  disposition: Disposition.optional(),
});

export const PublicPreviewQuery = PublicFileQuery.extend({
  kind: PreviewKind.default('thumb_1024'),
});

/* ------------------------- favorites, recent, search, quota ------------------------- */

export const SetFavorite = z.object({
  favorite: z.boolean(),
  /** Manual order of the favorites strip (3.17): put it after this node; null = first. */
  afterId: Id.nullable().optional(),
});

export const RecentNode = DriveNode.extend({ lastOpenedAt: Timestamp });
export type RecentNode = z.infer<typeof RecentNode>;

export const SearchNodesQuery = z.object({
  q: z.string().trim().min(1).max(200),
  /** Omit to search every space the caller can see. */
  spaceId: Id.optional(),
  type: NodeType.optional(),
  /** Also match file contents (roadmap 10); `false` searches names only. */
  content: z.stringbool().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const NodeSearchHit = z.object({
  node: DriveNode,
  path: Breadcrumb,
  space: z.object({ id: Id, name: z.string(), color: SpaceColor }),
  /** Where the query matched: the name, or only the file's text (roadmap 10). */
  matchedIn: z.enum(['name', 'content']).optional(),
  /** Content matches: excerpt with matches between SNIPPET_MARK_START / SNIPPET_MARK_END. */
  snippet: z.string().nullable().optional(),
});
export type NodeSearchHit = z.infer<typeof NodeSearchHit>;

/** How long a change-feed cursor stays valid after it was issued. */
export const DRIVE_CHANGES_RETENTION_DAYS = 30;

export const ListDriveChangesQuery = z.object({
  /** From the last page. Without one: no items and the current head (first sync, see below). */
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
  /** Comma list, e.g. `folder,file`: only changes of these node types (space changes stay). */
  types: z
    .string()
    .regex(/^(folder|file|page|board|drawing)(,(folder|file|page|board|drawing))*$/)
    .optional(),
});

export const DriveChangeType = z.enum([
  'created',
  'updated',
  'moved',
  'deleted',
  'accessGained',
  'accessChanged',
  'accessLost',
  'spaceUpdated',
  'spaceRemoved',
]);
export type DriveChangeType = z.infer<typeof DriveChangeType>;

/**
 * One entry of the Drive change feed, as the caller sees it.
 * - `created`, `updated`, `moved`: `node` is the node's current state, so upsert by id. A rename is
 *   `updated`; a parent or space change is `moved`. Restoring from the trash is `created`, one per
 *   node of the subtree. A folder you do not know yet that arrives as `moved` came into your view:
 *   list its subtree.
 * - `deleted`: `node` is null; `reason` says why. Trash and purge come one per node of the subtree;
 *   a move out of what you can see comes for the moved node only.
 * - `accessGained`: you can now see `nodeId` (a share, with `node`) or the whole space (`nodeId`
 *   null, with `space`). List it; the feed does not expand the subtree.
 * - `accessChanged`: still visible, your role changed (`node.myRole` or `space.myRole`). `myRole`
 *   is null when only shares inside the space remain: list it again.
 * - `accessLost`: remove `nodeId` with its subtree, or the whole space when `nodeId` is null.
 * - `spaceUpdated`: `space` was renamed, recoloured or archived. `spaceRemoved`: it was deleted.
 *
 * `node.version` changes on every content change and never on a rename or a move; use it to tell
 * whether a local copy is still good.
 */
export const DriveChange = z.object({
  type: DriveChangeType,
  spaceId: Id,
  nodeId: Id.nullable(),
  node: DriveNode.nullable(),
  space: z
    .object({
      id: Id,
      name: z.string(),
      slug: z.string(),
      kind: z.enum(['personal', 'shared']),
      color: SpaceColor,
      archived: z.boolean(),
      myRole: SpaceRole.nullable(),
    })
    .nullable(),
  reason: z.enum(['trashed', 'purged', 'access_lost']).nullable(),
  at: Timestamp,
});
export type DriveChange = z.infer<typeof DriveChange>;

/**
 * A page of the change feed. Unlike other lists `nextCursor` is always set: store it after
 * applying the page, and keep reading while `hasMore` is true.
 * - An empty page with `hasMore: true` is normal (what it walked past was filtered out): it is not
 *   the end, and the cursor still advanced.
 * - Rows are in commit order, but several changes of a node collapse into its latest, so a child
 *   may come before its parent. Hold rows with an unknown parent until the end of the page.
 * - A change shows up once every earlier transaction has finished: seconds behind at most, nothing
 *   skipped. Applying a change twice must be harmless. WebSocket `node.updated` is the hint to poll.
 * - First sync: call without a cursor, keep the head, then list the tree with listNodes. What
 *   changes while listing arrives through the feed.
 * - A cursor older than DRIVE_CHANGES_RETENTION_DAYS, or from before a server restore, answers 410
 *   drive_changes_expired: scan again and start from a new head.
 */
export const DriveChangesPage = z.object({
  items: z.array(DriveChange),
  nextCursor: z.string(),
  hasMore: z.boolean(),
});
export type DriveChangesPage = z.infer<typeof DriveChangesPage>;

/** Org storage (3.16): logical bytes of every node, versions and trash included (doc 17 §8). */
export const OrgQuota = z.object({
  usedBytes: z.number().int(),
  /** null = unlimited (self-hosted default). */
  quotaBytes: z.number().int().nullable(),
  trashBytes: z.number().int(),
  maxFileBytes: z.number().int(),
  /** ≥ 90 %: show the banner to owners and admins. */
  warning: z.boolean(),
  /** ≥ 100 %: new uploads are refused with quota_exceeded. */
  full: z.boolean(),
});
export type OrgQuota = z.infer<typeof OrgQuota>;

/** Paths outside the JSON contract: browsers can point `<a href>` / `<img src>` at them. */
export const RAW_PATHS = {
  /** 302 to a 5-minute signed URL (session cookie). `?versionId=` for an older version. */
  download: '/api/v1/nodes/:nodeId/download',
  /** 302 to the preview image. `?kind=thumb_256|thumb_1024|pdf_p1|poster`. */
  preview: '/api/v1/nodes/:nodeId/preview/raw',
  /** 302 for public links. `?nodeId=&grant=`. */
  publicDownload: '/api/v1/public/shares/:token/download',
  /** Profile photos and brand images, no session, cached for a year (H5). */
  asset: '/api/assets/:assetId',
} as const;
