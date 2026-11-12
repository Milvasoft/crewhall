import { eq } from 'drizzle-orm';
import {
  boardCards,
  conversations,
  meetings,
  messages,
  nodes,
  shares,
  surfaceCards,
  surfaces,
  uploads,
  users,
  type DbOrTx,
} from '@crewhall/db';
import { isGuest } from '../guests';
import {
  endpoints,
  MODULE_OF_ENDPOINT,
  type EndpointDef,
  type EndpointName,
  type McpScope,
} from '@crewhall/shared';
import type { Context } from 'hono';
import type { Deps } from '../../deps';
import { clientIp } from '../../http/client-ip';
import { AppError } from '../../http/errors';
import type { AppEnv, AuthSession, AuthUser } from '../../http/types';
import { personalSpaceId } from '../spaces';
import { TOKEN_PREFIX } from './crypto';
import { effectiveScopes, getPolicy, moduleOn } from './policy';
import { resolveBearer, touchPrincipal, type McpPrincipal } from './principal';
import { take } from './rate-limit';

/**
 * Personal access tokens on the REST API (design 18.4, 18.14): `Authorization: Bearer mhp_…`
 * acts as the token's owner, narrowed by the token's scopes and spaces, with the same
 * limits as /mcp. Better-auth bearer session tokens (mobile) never start with `mhp_`.
 */

/** The audience a personal token is checked against on the REST API. */
export const REST_RESOURCE = 'rest';

export const isTokenRequest = (c: Context<AppEnv>) =>
  /^Bearer\s+mhp_/i.test(c.req.header('authorization') ?? '');

// ---- endpoint → scope (the one place that decides what a token may call) ------------------

/**
 * Never with a token: identity, account and security (password, 2FA, passkeys, sessions,
 * SSO, token management), org and space administration, and everything that elsewhere
 * waits for a human approval (trash, permanent delete, external links, portal publishing).
 */
const NEVER = new Set<string>([
  // account and sessions
  'updateMe',
  'switchOrg',
  'listSessions',
  'revokeSession',
  'createMobileConnect',
  'createMobileHandoff',
  'createOAuthHandoff',
  'getPushDiagnostics',
  'acceptInvitation',
  // org administration
  'updateOrg',
  'updateBranding',
  'publishTheme',
  'updateMember',
  'unlockMember',
  'listInvitations',
  'createInvitation',
  'revokeInvitation',
  // space administration
  'createSpace',
  'updateSpace',
  'archiveSpace',
  'deleteSpace',
  'restoreSpace',
  'addSpaceMember',
  'updateSpaceMember',
  'removeSpaceMember',
  // approval-only actions (MCP: trash_nodes; publishing: request_portal_publish)
  'trashNodes',
  'purgeNodes',
  'emptyTrash',
  'createShare',
  'updateShare',
  'deleteShare',
  'regenerateShareLink',
  // chat: deleting chats (H19, people only), realtime, devices, webhooks, settings
  'clearConversation',
  'deleteConversation',
  'createWsTicket',
  'updateChatSettings',
  'updateNotificationPrefs',
  'registerPushDevice',
  'unregisterPushDevice',
  'createIncomingWebhook',
  'updateIncomingWebhook',
  'deleteIncomingWebhook',
  'regenerateIncomingWebhookKey',
  // portal: site administration and publishing
  'createPortalSite',
  'updatePortalSite',
  'rotatePortalToken',
  'testPortalRevalidate',
  'freezePortalVersion',
  'publishPortal',
  'revertPortalPublish',
  'retryPortalPublishJob',
  // realtime collaboration tokens
  'createCollabToken',
  'createBoardsCollabToken',
  // meetings: live controls
  'joinMeeting',
  'rotateMeetingLink',
  'decideMeetingLobby',
  'moderateMeetingParticipant',
  'muteAllInMeeting',
  'endMeetingForAll',
  'startMeetingRecording',
  'stopMeetingRecording',
  'updateMeetSpaceSettings',
  // federation (roadmap 26): people and admins only
  'getFederation',
  'updateFederation',
  'addFederationPeer',
  'removeFederationPeer',
  'getMyFederationAddress',
  'lookupRemoteUser',
  'createRemoteConversation',
  'addRemoteConversationMember',
  'shareNodeRemote',
  // plugins: admin screens, and tokens never mint further tokens
  'listPluginCatalog',
  'listPluginInstallations',
  'installPlugin',
  'updatePluginInstallation',
  'upgradePlugin',
  'uninstallPlugin',
  'listPluginSurfaces',
  'createPluginSessionToken',
  'getPluginOfflineGrant',
  'grantPluginOffline',
  'revokePluginOffline',
  'runPluginCommand',
  'listSharedChannels',
  'shareChannel',
  'listConversationShares',
  'acceptSharedChannel',
  'declineSharedChannel',
  'endSharedChannel',
  'blockRemoteMember',
  'listSharedFolders',
  'shareFolder',
  'endSharedFolder',
  'joinSharedMeeting',
]);

/** Core writes by area (core endpoints have no module). */
const CORE_WRITES: Record<string, McpScope> = {
  createFolder: 'drive:write',
  updateNode: 'drive:write',
  moveNodes: 'drive:write',
  copyNodes: 'drive:write',
  restoreNodes: 'drive:write',
  createUpload: 'drive:write',
  getUploadPartUrls: 'drive:write',
  completeUpload: 'drive:write',
  abortUpload: 'drive:write',
  restoreVersion: 'drive:write',
  setFavorite: 'drive:write',
  markNodeOpened: 'drive:write',
  updateSurfaceLayout: 'quick:write',
  createCard: 'quick:write',
  updateCard: 'quick:write',
  deleteCard: 'quick:write',
  restoreCard: 'quick:write',
  duplicateCard: 'quick:write',
  moveCard: 'quick:write',
  pinCard: 'quick:write',
  addGroupLink: 'quick:write',
  removeGroupLink: 'quick:write',
  previewLink: 'quick:write',
  updateLink: 'quick:write',
  checkLinkNow: 'quick:write',
  recordLinkOpen: 'quick:write',
};

/** POSTs that only read. */
const READ_POSTS = new Set(['getPresence']);

const MODULE_WRITE: Partial<Record<string, McpScope>> = {
  chat: 'chat:send',
  portal: 'portal:draft',
  wiki: 'pages:write',
  boards: 'boards:write',
  meet: 'meetings:write',
  calendar: 'calendar:write',
  contacts: 'contacts:write',
  tables: 'tables:write',
};

/**
 * The scope a personal token needs for an endpoint; null = never callable with a token.
 * Reads need `hub:read`; writes the scope of their area. The vault and MCP management
 * are never reachable ("Kasa kapalı").
 */
export function tokenScopeOf(name: EndpointName): McpScope | null {
  const def: EndpointDef = endpoints[name];
  const module = MODULE_OF_ENDPOINT[name];
  if (module === 'vault' || module === 'mcp') return null;
  if (NEVER.has(name) || def.path.startsWith('/api/v1/identity')) return null;
  if (def.method === 'GET' || READ_POSTS.has(name)) return 'hub:read';
  if (!module) return CORE_WRITES[name] ?? null;
  return MODULE_WRITE[module] ?? null;
}

// ---- authentication -------------------------------------------------------------------------

export interface TokenAuth {
  principal: McpPrincipal;
  user: AuthUser;
  session: AuthSession;
  via: Record<string, unknown>;
}

function invalid(c: Context<AppEnv>): never {
  c.header('WWW-Authenticate', 'Bearer error="invalid_token"');
  throw new AppError('unauthenticated', { reason: 'invalid_token' });
}

/**
 * Checks a `Bearer mhp_…` request: the token (expiry, revoke, IP list), the policy, the
 * endpoint's scope and the per-person limits. Returns the owner as user and a stand-in
 * session (the token id; it is never stored and never counts as a fresh sign-in).
 */
export async function authenticateToken(
  deps: Deps,
  c: Context<AppEnv>,
  name: EndpointName,
): Promise<TokenAuth> {
  const bearer = /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') ?? '')?.[1] ?? '';
  if (!bearer.startsWith(TOKEN_PREFIX.pat)) invalid(c);
  const ip = clientIp(c);
  const principal = await resolveBearer(deps.db, bearer, REST_RESOURCE, ip);
  if (!principal || principal.kind !== 'token') invalid(c);

  const [user] = await deps.db.select().from(users).where(eq(users.id, principal.userId));
  if (!user) invalid(c);
  const policy = await getPolicy(deps.db, principal.orgId);
  if (!policy.enabled) throw new AppError('mcp_disabled');
  if (!policy.patsEnabled) throw new AppError('mcp_tokens_disabled');
  if (!policy.guestsAllowed && (await isGuest(deps.db, principal.orgId, principal.userId))) {
    throw new AppError('mcp_guests_not_allowed');
  }

  const needed = tokenScopeOf(name);
  if (needed === null) throw new AppError('token_scope', { endpoint: name, scope: null });
  if (!effectiveScopes(policy, principal.scopes).includes(needed)) {
    throw new AppError('token_scope', { endpoint: name, scope: needed });
  }

  const def: EndpointDef = endpoints[name];
  const limit = await take(
    deps.db,
    principal.userId,
    { kind: 'mcp_req', perMinute: policy.requestsPerMinute },
    principal.orgId,
  );
  if (!limit.allowed) {
    c.header('Retry-After', String(limit.retryAfter));
    throw new AppError('rate_limited', { retryAfter: limit.retryAfter });
  }
  if (def.method !== 'GET' && needed !== 'hub:read') {
    const w = await take(
      deps.db,
      principal.userId,
      { kind: 'mcp_write', perMinute: policy.writesPerMinute },
      principal.orgId,
    );
    if (!w.allowed) {
      c.header('Retry-After', String(w.retryAfter));
      throw new AppError('rate_limited', { retryAfter: w.retryAfter });
    }
  }
  await touchPrincipal(deps.db, principal, ip);

  const session = {
    id: principal.tokenId!,
    token: '',
    userId: user.id,
    // Never "just signed in": re-verification needs a real session.
    createdAt: new Date(0),
    updatedAt: new Date(0),
    expiresAt: principal.expiresAt ?? new Date(Date.now() + 60_000),
    ipAddress: ip,
    userAgent: c.req.header('user-agent') ?? null,
    activeOrganizationId: principal.orgId,
  } as unknown as AuthSession;
  return {
    principal,
    user: user as unknown as AuthUser,
    session,
    via: { kind: 'api', client: principal.name, token: principal.tokenId, grant: null },
  };
}

/** A token outside its org's MCP module switch is refused like on /mcp. */
export function tokenModuleCheck(org: { settings: object }) {
  if (!moduleOn(org, 'mcp')) throw new AppError('mcp_disabled');
}

// ---- space limits ---------------------------------------------------------------------------

/** Spaces a request touches, from its path parameters and body. null = not space-bound. */
async function spacesOf(
  db: DbOrTx,
  def: EndpointDef,
  params: Record<string, string>,
  body: unknown,
  personal: () => Promise<string | null>,
): Promise<(string | null)[]> {
  const out: (string | null)[] = [];
  const one = async <T extends { spaceId: string | null }>(rows: Promise<T[]>) => {
    const [r] = await rows;
    if (r) out.push(r.spaceId);
  };
  const nodeSpace = (id: string) =>
    one(db.select({ spaceId: nodes.spaceId }).from(nodes).where(eq(nodes.id, id)));
  const conversationSpace = async (id: string) => {
    const [c] = await db
      .select({ spaceId: conversations.spaceId })
      .from(conversations)
      .where(eq(conversations.id, id));
    if (c) out.push(c.spaceId ?? (await personal()));
  };
  const surfaceSpace = async (id: string) => {
    const [s] = await db.select().from(surfaces).where(eq(surfaces.id, id));
    if (s) out.push(s.ownerType === 'space' ? s.ownerId : await personal());
  };

  if (params.spaceId) out.push(params.spaceId);
  if (params.nodeId) await nodeSpace(params.nodeId);
  if (params.boardId) await nodeSpace(params.boardId);
  if (params.uploadId) {
    await one(
      db.select({ spaceId: uploads.spaceId }).from(uploads).where(eq(uploads.id, params.uploadId)),
    );
  }
  if (params.shareId) {
    const [s] = await db
      .select({ nodeId: shares.nodeId })
      .from(shares)
      .where(eq(shares.id, params.shareId));
    if (s) await nodeSpace(s.nodeId);
  }
  if (params.surfaceId) await surfaceSpace(params.surfaceId);
  if (params.cardId) {
    if (def.path.startsWith('/api/v1/cards/')) {
      const [card] = await db
        .select({ surfaceId: surfaceCards.surfaceId })
        .from(surfaceCards)
        .where(eq(surfaceCards.id, params.cardId));
      if (card) await surfaceSpace(card.surfaceId);
    } else {
      const [card] = await db
        .select({ boardId: boardCards.boardNodeId })
        .from(boardCards)
        .where(eq(boardCards.id, params.cardId));
      if (card) await nodeSpace(card.boardId);
    }
  }
  if (params.conversationId) await conversationSpace(params.conversationId);
  if (params.messageId) {
    const [m] = await db
      .select({ conversationId: messages.conversationId })
      .from(messages)
      .where(eq(messages.id, params.messageId));
    if (m) await conversationSpace(m.conversationId);
  }
  if (params.meetingId) {
    await one(
      db
        .select({ spaceId: meetings.spaceId })
        .from(meetings)
        .where(eq(meetings.id, params.meetingId)),
    );
  }

  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    if (typeof b.spaceId === 'string') out.push(b.spaceId);
    const target = b.target as { spaceId?: unknown } | undefined;
    if (target && typeof target.spaceId === 'string') out.push(target.spaceId);
    if (Array.isArray(b.nodeIds)) {
      for (const id of b.nodeIds) if (typeof id === 'string') await nodeSpace(id);
    }
  }
  return out;
}

/** Outside the token's spaces the resource does not exist for it (design 1.18: 404). */
export async function checkTokenSpaces(
  db: DbOrTx,
  principal: McpPrincipal,
  def: EndpointDef,
  params: Record<string, string>,
  body: unknown,
) {
  if (principal.spaceIds === null) return;
  const allowed = new Set(principal.spaceIds);
  const personal = () => personalSpaceId(db, principal.orgId, principal.userId);
  for (const id of await spacesOf(db, def, params, body, personal)) {
    if (id === null || !allowed.has(id)) throw new AppError('not_found');
  }
}

/**
 * Lists across spaces (search, recent, spaces, conversations…) drop what lies outside the
 * token's spaces. Items without a space (people, org data) stay.
 */
export async function filterTokenItems(
  db: DbOrTx,
  principal: McpPrincipal,
  name: EndpointName,
  data: unknown,
): Promise<unknown> {
  if (principal.spaceIds === null || !data || typeof data !== 'object') return data;
  const d = data as { items?: unknown };
  if (!Array.isArray(d.items)) return data;
  const allowed = new Set(principal.spaceIds);
  const personal = await personalSpaceId(db, principal.orgId, principal.userId);
  const spaceOf = (item: Record<string, unknown>): string | null | undefined => {
    if (name === 'listSpaces' || name === 'listOrgSpaces') return item.id as string;
    if (typeof item.spaceId === 'string') return item.spaceId;
    if (item.spaceId === null && 'type' in item && 'peer' in item) return personal; // chat
    const space = item.space as { id?: unknown } | undefined;
    if (space && typeof space.id === 'string') return space.id;
    const node = item.node as { spaceId?: unknown } | undefined;
    if (node && typeof node.spaceId === 'string') return node.spaceId;
    const owner = item.owner as { type?: unknown; spaceId?: unknown } | undefined;
    if (owner?.type === 'space' && typeof owner.spaceId === 'string') return owner.spaceId;
    if (owner?.type === 'user') return personal;
    return undefined;
  };
  return {
    ...d,
    items: d.items.filter((raw) => {
      if (!raw || typeof raw !== 'object') return true;
      const s = spaceOf(raw as Record<string, unknown>);
      return s === undefined || (s !== null && allowed.has(s));
    }),
  };
}
