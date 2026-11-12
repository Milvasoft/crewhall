import { z } from 'zod';
import { Empty, def, items, type EndpointDef } from './endpoint-def';
import { portalEndpoints } from './endpoints/portal';
import { mcpEndpoints } from './endpoints/mcp';
import { chatEndpoints } from './endpoints/chat';
import { vaultEndpoints } from './endpoints/vault';
import { wikiEndpoints } from './endpoints/wiki';
import { templateEndpoints } from './endpoints/templates';
import { meetEndpoints } from './endpoints/meet';
import { boardsCollabEndpoints, boardsEndpoints, drawingsEndpoints } from './endpoints/boards';
import { identityEndpoints } from './endpoints/identity';
import { federationEndpoints } from './endpoints/federation';
import { pluginsEndpoints } from './endpoints/plugins';
import { announcementsEndpoints } from './endpoints/announcements';
import { formsEndpoints } from './endpoints/forms';
import { calendarEndpoints } from './endpoints/calendar';
import { contactsEndpoints } from './endpoints/contacts';
import { automationsEndpoints } from './endpoints/automations';
import { tablesEndpoints } from './endpoints/tables';
import { aiEndpoints } from './endpoints/ai';
import { officeEndpoints } from './endpoints/office';
import { statsEndpoints } from './endpoints/stats';
import { mailEndpoints } from './endpoints/mail';
import { deliveryEndpoints } from './endpoints/delivery';
import { compatEndpoints } from './endpoints/compat';
import { desktopEndpoints } from './endpoints/desktop';
import { oauthEndpoints } from './endpoints/oauth';
import { quickEndpoints } from './endpoints/quick';
import { microsoftEndpoints } from './endpoints/microsoft';
import { AiSearchHit, AiSearchQuery } from './schemas/ai';
import type { ModuleKey } from './schemas/org';
import {
  OrgTheme,
  PublicBootstrap,
  Branding,
  UpdateBranding,
  UploadBrandAsset,
} from './schemas/branding';
import { ImageUpload, PageQuery, page } from './schemas/common';
import { AvatarResult, Me, SessionInfo, UiPrefs, UpdateMe, UpdateUiPrefs } from './schemas/me';
import {
  CreateInvitation,
  Invitation,
  InvitationPreview,
  MemberListQuery,
  OrgMember,
  Organization,
  UpdateOrgMember,
  UpdateOrganization,
} from './schemas/org';
import { SetupRequest, SetupResult, SmtpTestRequest } from './schemas/setup';
import {
  CompleteUpload,
  CompletedUpload,
  CopyNodes,
  CreateFolder,
  CreateShare,
  CreateUpload,
  DownloadQuery,
  DownloadUrl,
  DriveChangesPage,
  DriveNode,
  DriveNodeDetail,
  ListDriveChangesQuery,
  ListNodesQuery,
  MoveNodes,
  NodeIds,
  NodeSearchHit,
  NodeShares,
  NodeVersion,
  OrgQuota,
  PreviewQuery,
  PreviewUrl,
  PublicChildrenQuery,
  PublicFileQuery,
  PublicNode,
  PublicPreviewQuery,
  PublicShare,
  PublicShareGrant,
  PublicShareQuery,
  RecentNode,
  SearchNodesQuery,
  SetFavorite,
  Share,
  TrashItem,
  UnlockPublicShare,
  UpdateNode,
  UpdateShare,
  Upload,
  UploadPartUrls,
  UploadPartsRequest,
} from './schemas/drive';
import {
  AddGroupLink,
  Card,
  CreateCard,
  LayoutResult,
  Link,
  LinkHistory,
  LinkHistoryQuery,
  LinkPreview,
  LinkPreviewRequest,
  Surface,
  SurfaceSummary,
  MoveCard,
  TargetSurface,
  UpdateCard,
  UpdateLayout,
  UpdateLink,
} from './schemas/quick';
import {
  MobileConnectPreview,
  MobileConnectTicket,
  MobileHandoffCode,
  MobileHandoffExchange,
  MobileHandoffRequest,
  MobileHandoffSession,
} from './schemas/auth';
import {
  AddSpaceMember,
  CreateSpace,
  OrgSpace,
  Space,
  SpaceMember,
  UpdateSpace,
  UpdateSpaceMember,
} from './schemas/space';

/**
 * The HTTP contract between apps/api and the clients (web, mobile).
 * apps/api validates `body`/`query` with these schemas and must return `response`;
 * packages/api-client derives its typed calls from this table.
 * Changing an entry is a contract change: see CLAUDE.md "Sözleşme değişikliği".
 *
 * Authentication itself (sign-up, sign-in, 2FA, passkey, sessions, password reset)
 * is better-auth under /api/auth/* and is not listed here.
 * `org` paths act on the session's active organization.
 */

export type { EndpointDef } from './endpoint-def';
/** The `{}` body and response; named so generated docs (OpenAPI) can refer to it. */
export { Empty } from './endpoint-def';

/** Phase 0 and 1 endpoints. New modules add their own file under ./endpoints/ (one owner each). */
const coreEndpoints = {
  // Public bootstrap: branding, theme, setup state. Clients call it before anything else.
  bootstrap: def({
    method: 'GET',
    path: '/api/v1/bootstrap',
    auth: 'public',
    response: PublicBootstrap,
  }),

  // First-run wizard
  setup: def({
    method: 'POST',
    path: '/api/v1/setup',
    auth: 'public',
    body: SetupRequest,
    response: SetupResult,
  }),
  setupSmtpTest: def({
    method: 'POST',
    path: '/api/v1/setup/smtp-test',
    auth: 'public',
    body: SmtpTestRequest,
    response: Empty,
  }),

  // Me
  me: def({ method: 'GET', path: '/api/v1/me', auth: 'session', response: Me }),
  updateMe: def({
    method: 'PATCH',
    path: '/api/v1/me',
    auth: 'session',
    body: UpdateMe,
    response: Me,
  }),
  /** Personal interface choices in the active org (left menu order), on every device. */
  getUiPrefs: def({
    method: 'GET',
    path: '/api/v1/me/ui-prefs',
    auth: 'session',
    response: UiPrefs,
  }),
  updateUiPrefs: def({
    method: 'PATCH',
    path: '/api/v1/me/ui-prefs',
    auth: 'session',
    body: UpdateUiPrefs,
    response: UiPrefs,
  }),
  /** Profile photo (H5): stored, cropped to a square and resized; replaces the previous one. */
  uploadAvatar: def({
    method: 'POST',
    path: '/api/v1/me/avatar',
    auth: 'session',
    body: ImageUpload,
    response: AvatarResult,
  }),
  deleteAvatar: def({
    method: 'DELETE',
    path: '/api/v1/me/avatar',
    auth: 'session',
    response: Empty,
  }),
  switchOrg: def({
    method: 'POST',
    path: '/api/v1/me/active-org',
    auth: 'session',
    body: z.object({ orgId: z.uuid() }),
    response: Me,
  }),
  listSessions: def({
    method: 'GET',
    path: '/api/v1/me/sessions',
    auth: 'session',
    response: items(SessionInfo),
  }),
  revokeSession: def({
    method: 'DELETE',
    path: '/api/v1/me/sessions/:sessionId',
    auth: 'session',
    response: Empty,
  }),

  // Mobile app linking (docs/contracts/faz-0-kapanis.md)
  /** Web › Hesabım › Güvenlik › "Mobil uygulamayı bağla": QR payload, 5 min, single use. */
  createMobileConnect: def({
    method: 'POST',
    path: '/api/v1/mobile/connect',
    auth: 'session',
    response: MobileConnectTicket,
  }),
  /** App after scanning: pre-fills the e-mail. Consumes the token; 410 mobile_connect_invalid. */
  getMobileConnect: def({
    method: 'GET',
    path: '/api/v1/mobile/connect/:token',
    auth: 'public',
    response: MobileConnectPreview,
  }),
  /** Web /mobile-login, after sign-in: one-time code bound to the app's PKCE challenge (60 s). */
  createMobileHandoff: def({
    method: 'POST',
    path: '/api/v1/mobile/handoff',
    auth: 'session',
    body: MobileHandoffRequest,
    response: MobileHandoffCode,
  }),
  /** App: code + verifier → new bearer session for this device; 400 mobile_handoff_invalid. */
  exchangeMobileHandoff: def({
    method: 'POST',
    path: '/api/v1/mobile/handoff/exchange',
    auth: 'public',
    body: MobileHandoffExchange,
    response: MobileHandoffSession,
  }),

  // Organization (active org)
  getOrg: def({ method: 'GET', path: '/api/v1/org', auth: 'session', response: Organization }),
  updateOrg: def({
    method: 'PATCH',
    path: '/api/v1/org',
    auth: 'session',
    body: UpdateOrganization,
    response: Organization,
  }),
  updateBranding: def({
    method: 'PATCH',
    path: '/api/v1/org/branding',
    auth: 'session',
    body: UpdateBranding,
    response: Branding,
  }),
  /** Logo, mark or favicon (H5); org.update_branding. Answers the updated branding. */
  uploadBrandAsset: def({
    method: 'POST',
    path: '/api/v1/org/branding/assets',
    auth: 'session',
    body: UploadBrandAsset,
    response: Branding,
  }),
  /** Back to the product default for that slot. */
  deleteBrandAsset: def({
    method: 'DELETE',
    path: '/api/v1/org/branding/assets/:slot',
    auth: 'session',
    response: Branding,
  }),
  getTheme: def({ method: 'GET', path: '/api/v1/org/theme', auth: 'session', response: OrgTheme }),
  publishTheme: def({
    method: 'PUT',
    path: '/api/v1/org/theme',
    auth: 'session',
    body: OrgTheme.omit({ version: true }),
    response: OrgTheme,
  }),

  listMembers: def({
    method: 'GET',
    path: '/api/v1/org/members',
    auth: 'session',
    query: PageQuery.extend(MemberListQuery.shape),
    response: page(OrgMember),
  }),
  updateMember: def({
    method: 'PATCH',
    path: '/api/v1/org/members/:userId',
    auth: 'session',
    body: UpdateOrgMember,
    response: OrgMember,
  }),

  /** Lift a sign-in lock early (org.manage_members); audited. */
  unlockMember: def({
    method: 'POST',
    path: '/api/v1/org/members/:userId/unlock',
    auth: 'session',
    response: OrgMember,
  }),

  /** Admin list of every shared space in the org (org.manage_spaces), without content. */
  listOrgSpaces: def({
    method: 'GET',
    path: '/api/v1/org/spaces',
    auth: 'session',
    query: z.object({ archived: z.stringbool().optional() }),
    response: items(OrgSpace),
  }),

  listInvitations: def({
    method: 'GET',
    path: '/api/v1/org/invitations',
    auth: 'session',
    response: items(Invitation),
  }),
  createInvitation: def({
    method: 'POST',
    path: '/api/v1/org/invitations',
    auth: 'session',
    body: CreateInvitation,
    response: Invitation,
  }),
  revokeInvitation: def({
    method: 'DELETE',
    path: '/api/v1/org/invitations/:invitationId',
    auth: 'session',
    response: Empty,
  }),
  getInvitation: def({
    method: 'GET',
    path: '/api/v1/invitations/:token',
    auth: 'public',
    response: InvitationPreview,
  }),
  acceptInvitation: def({
    method: 'POST',
    path: '/api/v1/invitations/:token/accept',
    auth: 'session',
    response: Me,
  }),

  // Spaces
  listSpaces: def({
    method: 'GET',
    path: '/api/v1/spaces',
    auth: 'session',
    /** deleted=true: spaces the caller owns that wait for permanent deletion (restorable). */
    query: z.object({ archived: z.stringbool().optional(), deleted: z.stringbool().optional() }),
    response: items(Space),
  }),
  createSpace: def({
    method: 'POST',
    path: '/api/v1/spaces',
    auth: 'session',
    body: CreateSpace,
    response: Space,
  }),
  getSpace: def({
    method: 'GET',
    path: '/api/v1/spaces/:spaceId',
    auth: 'session',
    response: Space,
  }),
  updateSpace: def({
    method: 'PATCH',
    path: '/api/v1/spaces/:spaceId',
    auth: 'session',
    body: UpdateSpace,
    response: Space,
  }),
  archiveSpace: def({
    method: 'POST',
    path: '/api/v1/spaces/:spaceId/archive',
    auth: 'session',
    response: Space,
  }),
  /** Owner only; the space disappears for everyone and is removed for good after 30 days. */
  deleteSpace: def({
    method: 'DELETE',
    path: '/api/v1/spaces/:spaceId',
    auth: 'session',
    response: Space,
  }),
  /** Owner only, within the 30 days. */
  restoreSpace: def({
    method: 'POST',
    path: '/api/v1/spaces/:spaceId/restore',
    auth: 'session',
    response: Space,
  }),
  listSpaceMembers: def({
    method: 'GET',
    path: '/api/v1/spaces/:spaceId/members',
    auth: 'session',
    response: items(SpaceMember),
  }),
  addSpaceMember: def({
    method: 'POST',
    path: '/api/v1/spaces/:spaceId/members',
    auth: 'session',
    body: AddSpaceMember,
    response: SpaceMember,
  }),
  updateSpaceMember: def({
    method: 'PATCH',
    path: '/api/v1/spaces/:spaceId/members/:userId',
    auth: 'session',
    body: UpdateSpaceMember,
    response: SpaceMember,
  }),
  removeSpaceMember: def({
    method: 'DELETE',
    path: '/api/v1/spaces/:spaceId/members/:userId',
    auth: 'session',
    response: Empty,
  }),

  // ---- Phase 1 · Drive (design 03, 19.1-19.5; doc 17 §4, §5, §8) ----------------
  // Cursor pagination everywhere; no real-time events yet, clients refetch.

  /** Children of a folder (or the space root), folders first. */
  listNodes: def({
    method: 'GET',
    path: '/api/v1/spaces/:spaceId/nodes',
    auth: 'session',
    query: ListNodesQuery,
    response: page(DriveNode),
  }),
  getNode: def({
    method: 'GET',
    path: '/api/v1/nodes/:nodeId',
    auth: 'session',
    response: DriveNodeDetail,
  }),
  createFolder: def({
    method: 'POST',
    path: '/api/v1/spaces/:spaceId/folders',
    auth: 'session',
    body: CreateFolder,
    response: DriveNode,
  }),
  /** Rename. A name clash in the folder answers 409 node_name_taken. */
  updateNode: def({
    method: 'PATCH',
    path: '/api/v1/nodes/:nodeId',
    auth: 'session',
    body: UpdateNode,
    response: DriveNode,
  }),
  /** Move within or across spaces (one subtree UPDATE; person shares are dropped across spaces). */
  moveNodes: def({
    method: 'POST',
    path: '/api/v1/nodes/move',
    auth: 'session',
    body: MoveNodes,
    response: items(DriveNode),
  }),
  /** Copy; files share the same blobs, so even large ones copy instantly (3.13). */
  copyNodes: def({
    method: 'POST',
    path: '/api/v1/nodes/copy',
    auth: 'session',
    body: CopyNodes,
    response: items(DriveNode),
  }),
  /** Move to the trash (30 days); a folder takes its subtree with it. */
  trashNodes: def({
    method: 'POST',
    path: '/api/v1/nodes/trash',
    auth: 'session',
    body: NodeIds,
    response: items(DriveNode),
  }),
  /** Back to the old place, or the root when the parent is gone (3.16). */
  restoreNodes: def({
    method: 'POST',
    path: '/api/v1/nodes/restore',
    auth: 'session',
    body: NodeIds,
    response: items(DriveNode),
  }),
  /** Permanent delete of trashed nodes (space.purge). */
  purgeNodes: def({
    method: 'POST',
    path: '/api/v1/nodes/purge',
    auth: 'session',
    body: NodeIds,
    response: Empty,
  }),
  listTrash: def({
    method: 'GET',
    path: '/api/v1/spaces/:spaceId/trash',
    auth: 'session',
    query: PageQuery,
    response: page(TrashItem),
  }),
  emptyTrash: def({
    method: 'POST',
    path: '/api/v1/spaces/:spaceId/trash/empty',
    auth: 'session',
    response: Empty,
  }),

  // Uploads: presigned S3 multipart, 16 MiB parts, resumable (doc 17 §8)
  /** Checks rights, file size and quota (reserves it); 409 node_name_taken when onConflict=ask. */
  createUpload: def({
    method: 'POST',
    path: '/api/v1/uploads',
    auth: 'session',
    body: CreateUpload,
    response: Upload,
  }),
  /** Resume: which parts the store already has. */
  getUpload: def({
    method: 'GET',
    path: '/api/v1/uploads/:uploadId',
    auth: 'session',
    response: Upload,
  }),
  getUploadPartUrls: def({
    method: 'POST',
    path: '/api/v1/uploads/:uploadId/parts',
    auth: 'session',
    body: UploadPartsRequest,
    response: UploadPartUrls,
  }),
  /** Joins the parts, checks the size, creates the node or version and commits the quota. */
  completeUpload: def({
    method: 'POST',
    path: '/api/v1/uploads/:uploadId/complete',
    auth: 'session',
    body: CompleteUpload,
    response: CompletedUpload,
  }),
  abortUpload: def({
    method: 'DELETE',
    path: '/api/v1/uploads/:uploadId',
    auth: 'session',
    response: Empty,
  }),

  // Download, preview, versions
  /** 5-minute signed URL (also RAW_PATHS.download as a 302 for browsers). */
  getDownloadUrl: def({
    method: 'GET',
    path: '/api/v1/nodes/:nodeId/download-url',
    auth: 'session',
    query: DownloadQuery,
    response: DownloadUrl,
  }),
  /** 404 preview_unavailable until the worker made it (DriveNode.preview = ready). */
  getPreview: def({
    method: 'GET',
    path: '/api/v1/nodes/:nodeId/preview',
    auth: 'session',
    query: PreviewQuery,
    response: PreviewUrl,
  }),
  listVersions: def({
    method: 'GET',
    path: '/api/v1/nodes/:nodeId/versions',
    auth: 'session',
    response: items(NodeVersion),
  }),
  /** Copies the old version on top as a new version; history stays (3.8). */
  restoreVersion: def({
    method: 'POST',
    path: '/api/v1/nodes/:nodeId/versions/:versionId/restore',
    auth: 'session',
    response: NodeVersion,
  }),

  // Shares (3.11)
  listShares: def({
    method: 'GET',
    path: '/api/v1/nodes/:nodeId/shares',
    auth: 'session',
    response: NodeShares,
  }),
  createShare: def({
    method: 'POST',
    path: '/api/v1/nodes/:nodeId/shares',
    auth: 'session',
    body: CreateShare,
    response: Share,
  }),
  updateShare: def({
    method: 'PATCH',
    path: '/api/v1/shares/:shareId',
    auth: 'session',
    body: UpdateShare,
    response: Share,
  }),
  deleteShare: def({
    method: 'DELETE',
    path: '/api/v1/shares/:shareId',
    auth: 'session',
    response: Empty,
  }),
  /** New token for a link share (the old address stops working); the response carries `url`. */
  regenerateShareLink: def({
    method: 'POST',
    path: '/api/v1/shares/:shareId/regenerate',
    auth: 'session',
    response: Share,
  }),

  // Public link pages /s/:token (19.1-19.5), no session
  getPublicShare: def({
    method: 'GET',
    path: '/api/v1/public/shares/:token',
    auth: 'public',
    query: PublicShareQuery,
    response: PublicShare,
  }),
  /** 401 share_password_invalid (details.remainingAttempts), 423 share_locked after 5 tries. */
  unlockPublicShare: def({
    method: 'POST',
    path: '/api/v1/public/shares/:token/unlock',
    auth: 'public',
    body: UnlockPublicShare,
    response: PublicShareGrant,
  }),
  listPublicShareNodes: def({
    method: 'GET',
    path: '/api/v1/public/shares/:token/nodes',
    auth: 'public',
    query: PublicChildrenQuery,
    response: page(PublicNode),
  }),
  /** 403 forbidden when the link does not allow downloads. */
  getPublicDownloadUrl: def({
    method: 'GET',
    path: '/api/v1/public/shares/:token/download-url',
    auth: 'public',
    query: PublicFileQuery,
    response: DownloadUrl,
  }),
  getPublicPreview: def({
    method: 'GET',
    path: '/api/v1/public/shares/:token/preview',
    auth: 'public',
    query: PublicPreviewQuery,
    response: PreviewUrl,
  }),

  // Favorites, recent, search, quota (3.15-3.17)
  listFavorites: def({
    method: 'GET',
    path: '/api/v1/me/favorites',
    auth: 'session',
    response: items(DriveNode),
  }),
  setFavorite: def({
    method: 'PUT',
    path: '/api/v1/nodes/:nodeId/favorite',
    auth: 'session',
    body: SetFavorite,
    response: DriveNode,
  }),
  listRecent: def({
    method: 'GET',
    path: '/api/v1/me/recent',
    auth: 'session',
    query: z.object({ limit: z.coerce.number().int().min(1).max(100).default(30) }),
    response: items(RecentNode),
  }),
  /** Call when a node is opened or previewed; feeds "Son açılanlar". */
  markNodeOpened: def({
    method: 'POST',
    path: '/api/v1/nodes/:nodeId/opened',
    auth: 'session',
    response: Empty,
  }),
  /** What changed in the caller's view of Drive since a cursor (virtual drive, sync clients). */
  listDriveChanges: def({
    method: 'GET',
    path: '/api/v1/drive/changes',
    auth: 'session',
    query: ListDriveChangesQuery,
    response: DriveChangesPage,
  }),
  /** Name search (pg_trgm), filtered by what the caller may see. */
  searchNodes: def({
    method: 'GET',
    path: '/api/v1/search/nodes',
    auth: 'session',
    query: SearchNodesQuery,
    response: page(NodeSearchHit),
  }),
  /**
   * Text search over pages, Drive, board cards and chat messages, also with the ai module off
   * (`search.content`). Only what the caller may open; a module that is off drops out; vault never.
   * Never calls a model: `searchAi` adds semantic results where the org has AI.
   */
  searchContent: def({
    method: 'GET',
    path: '/api/v1/search/content',
    auth: 'session',
    query: AiSearchQuery,
    response: items(AiSearchHit),
  }),
  getQuota: def({
    method: 'GET',
    path: '/api/v1/org/quota',
    auth: 'session',
    response: OrgQuota,
  }),

  // ---- Phase 1 · Quick access (design 02; doc 17 §4, §10) ------------------------

  /** Benim plus the surface of every shared space the caller belongs to. */
  listSurfaces: def({
    method: 'GET',
    path: '/api/v1/surfaces',
    auth: 'session',
    response: items(SurfaceSummary),
  }),
  getSurface: def({
    method: 'GET',
    path: '/api/v1/surfaces/:surfaceId',
    auth: 'session',
    response: Surface,
  }),
  /** Batch layout save after drag and resize; 409 conflict when layoutRev is stale. */
  updateSurfaceLayout: def({
    method: 'PUT',
    path: '/api/v1/surfaces/:surfaceId/layout',
    auth: 'session',
    body: UpdateLayout,
    response: LayoutResult,
  }),
  createCard: def({
    method: 'POST',
    path: '/api/v1/surfaces/:surfaceId/cards',
    auth: 'session',
    body: CreateCard,
    response: Card,
  }),
  updateCard: def({
    method: 'PATCH',
    path: '/api/v1/cards/:cardId',
    auth: 'session',
    body: UpdateCard,
    response: Card,
  }),
  /** Removes the card only (never the page or file it points to); undo with restoreCard. */
  deleteCard: def({
    method: 'DELETE',
    path: '/api/v1/cards/:cardId',
    auth: 'session',
    response: Empty,
  }),
  restoreCard: def({
    method: 'POST',
    path: '/api/v1/cards/:cardId/restore',
    auth: 'session',
    response: Card,
  }),
  duplicateCard: def({
    method: 'POST',
    path: '/api/v1/cards/:cardId/duplicate',
    auth: 'session',
    response: Card,
  }),
  /** "Başka space'e taşı" (2.7); targets from listCardMoveTargets. */
  moveCard: def({
    method: 'POST',
    path: '/api/v1/cards/:cardId/move',
    auth: 'session',
    body: MoveCard,
    response: Card,
  }),
  /** Pin to another surface as a live link to this card (2.8); viewers may pin to Benim. */
  pinCard: def({
    method: 'POST',
    path: '/api/v1/cards/:cardId/pin',
    auth: 'session',
    body: TargetSurface,
    response: Card,
  }),
  addGroupLink: def({
    method: 'POST',
    path: '/api/v1/cards/:cardId/links',
    auth: 'session',
    body: AddGroupLink,
    response: Card,
  }),
  removeGroupLink: def({
    method: 'DELETE',
    path: '/api/v1/cards/:cardId/links/:itemId',
    auth: 'session',
    response: Card,
  }),

  /** Fetch title and favicon of a pasted URL once (2.4). */
  previewLink: def({
    method: 'POST',
    path: '/api/v1/links/preview',
    auth: 'session',
    body: LinkPreviewRequest,
    response: LinkPreview,
  }),
  getLink: def({ method: 'GET', path: '/api/v1/links/:linkId', auth: 'session', response: Link }),
  /** Check settings are org-wide for the URL (one check however many cards show it). */
  updateLink: def({
    method: 'PATCH',
    path: '/api/v1/links/:linkId',
    auth: 'session',
    body: UpdateLink,
    response: Link,
  }),
  /** Recent checks for the hover strip (2.12). */
  getLinkHistory: def({
    method: 'GET',
    path: '/api/v1/links/:linkId/checks',
    auth: 'session',
    query: LinkHistoryQuery,
    response: LinkHistory,
  }),
  /** "Şimdi dene" (2.12). */
  checkLinkNow: def({
    method: 'POST',
    path: '/api/v1/links/:linkId/check',
    auth: 'session',
    response: Link,
  }),
  /** Count an open, for the "most opened" sort (2.5). */
  recordLinkOpen: def({
    method: 'POST',
    path: '/api/v1/links/:linkId/opened',
    auth: 'session',
    response: Empty,
  }),
} as const satisfies Record<string, EndpointDef>;

export const endpoints = {
  ...coreEndpoints,
  ...portalEndpoints,
  ...mcpEndpoints,
  ...chatEndpoints,
  ...vaultEndpoints,
  ...wikiEndpoints,
  ...meetEndpoints,
  ...boardsEndpoints,
  ...drawingsEndpoints,
  ...boardsCollabEndpoints,
  ...identityEndpoints,
  ...federationEndpoints,
  ...pluginsEndpoints,
  ...announcementsEndpoints,
  ...formsEndpoints,
  ...calendarEndpoints,
  ...contactsEndpoints,
  ...automationsEndpoints,
  ...tablesEndpoints,
  ...aiEndpoints,
  ...templateEndpoints,
  ...statsEndpoints,
  ...mailEndpoints,
  ...deliveryEndpoints,
  ...compatEndpoints,
  ...desktopEndpoints,
  ...quickEndpoints,
  ...microsoftEndpoints,
  ...officeEndpoints,
  ...oauthEndpoints,
} as const satisfies Record<string, EndpointDef>;

const moduleTables: Record<ModuleKey, Record<string, EndpointDef>> = {
  chat: chatEndpoints,
  meet: meetEndpoints,
  wiki: wikiEndpoints,
  boards: boardsEndpoints,
  drawings: drawingsEndpoints,
  vault: vaultEndpoints,
  portal: portalEndpoints,
  mcp: mcpEndpoints,
  forms: formsEndpoints,
  calendar: calendarEndpoints,
  contacts: contactsEndpoints,
  automations: automationsEndpoints,
  tables: tablesEndpoints,
  ai: aiEndpoints,
  mail: mailEndpoints,
  // Tools run in the browser; the switch only hides the module.
  tools: {},
  office: officeEndpoints,
};

/**
 * Which switchable module an endpoint belongs to; core endpoints (phase 0/1, identity) are absent.
 * The backend rejects calls to a disabled module with 403 `module_disabled` from this map, so
 * module code never checks the switch itself.
 */
export const MODULE_OF_ENDPOINT: Readonly<Partial<Record<string, ModuleKey>>> = Object.fromEntries(
  (Object.entries(moduleTables) as [ModuleKey, Record<string, EndpointDef>][]).flatMap(
    ([mod, table]) => Object.keys(table).map((name) => [name, mod] as const),
  ),
);

export type Endpoints = typeof endpoints;
/** Phase 0/1 endpoints; module endpoints come from ./endpoints/<module>.ts. */
export type CoreEndpointName = keyof typeof coreEndpoints;
export type ModuleEndpointName = Exclude<keyof Endpoints, CoreEndpointName>;
export type EndpointName = keyof Endpoints;

type PathParamNames<P extends string> = P extends `${string}:${infer Name}/${infer Rest}`
  ? Name | PathParamNames<`/${Rest}`>
  : P extends `${string}:${infer Name}`
    ? Name
    : never;

export type PathParams<N extends EndpointName> = Record<
  PathParamNames<Endpoints[N]['path']>,
  string
>;
export type BodyOf<N extends EndpointName> = Endpoints[N] extends {
  body: infer B extends z.ZodType;
}
  ? z.input<B>
  : never;
export type QueryOf<N extends EndpointName> = Endpoints[N] extends {
  query: infer Q extends z.ZodType;
}
  ? z.input<Q>
  : never;
export type ResponseOf<N extends EndpointName> = z.output<Endpoints[N]['response']>;
