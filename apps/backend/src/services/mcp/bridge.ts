import { eq } from 'drizzle-orm';
import { users } from '@crewhall/db';
import {
  MCP_SCOPES,
  MODULE_OF_ENDPOINT,
  endpoints,
  type ApprovalAction,
  type EndpointDef,
  type EndpointName,
  type McpScope,
} from '@crewhall/shared';
import type { Context } from 'hono';
import type { Deps } from '../../deps';
import { AppError } from '../../http/errors';
import type { AppEnv, AuthSession, AuthUser } from '../../http/types';
import type { McpPrincipal } from './principal';
import { tokenScopeOf, type TokenAuth } from './rest';
import { ToolError } from './tools/types';

/**
 * The operation bridge (MCP "neredeyse tüm Crewhall"): an MCP tool calls any contract
 * endpoint as the person, in process, through the same router web and mobile use. The
 * request carries no credentials; it is recognised by object identity (a WeakMap entry the
 * network can never create) and then runs exactly like a personal-token request: the
 * connection's scopes and spaces, the org's module switches, `can()` in every handler,
 * validation and audit (`via`).
 *
 * What MCP may call is decided here, on top of the REST token rules (rest.ts):
 * - everything a personal token may call, with the same scope;
 * - a few things tokens may not, but only after the person approves (sharing outside,
 *   sending mail, administration);
 * - deletions and other hard-to-reverse writes wait for approval too;
 * - a short list never (realtime, sending chat around `send_message`'s policy, the trash).
 */

// ---- which operations, with which scope --------------------------------------------------------

export interface OperationRule {
  scope: McpScope;
  /** Non-null: the call goes to the approval queue with this action. */
  approval: ApprovalAction | null;
}

/** Callable through dedicated tools only, or not at all over MCP. */
const BLOCKED = new Set<string>([
  // send_message keeps the org's approval policy and the "Claude ile" mark
  'sendMessage',
  // trash_nodes asks for approval; the permanent ones never run from an assistant
  'trashNodes',
  'purgeNodes',
  'emptyTrash',
  'clearConversation',
  'deleteConversation',
  // rings phones and opens live media
  'startCall',
  'ringCall',
  'ringToMeeting',
  'answerCall',
  'declineCall',
  'hangUpCall',
  'joinMeeting',
  'createWsTicket',
  // AI assistant inside Crewhall: an outside assistant does not drive another one
  'runAi',
  'acceptAiRun',
  'askAi',
  'planAiActions',
  // GIF provider and mail server settings carry outside credentials
  'updateGifSettings',
  'testGifSettings',
  'mailServerSettings',
  'mailUpdateServerSettings',
  'mailTestServer',
  'mailConnectAccount',
  'mailUpdateAccount',
  'mailDisconnectAccount',
]);

/** MCP-only rules for endpoints REST tokens cannot call (rest.ts NEVER or no write scope). */
const EXTRA: Record<string, OperationRule> = {
  // Drive: sharing with people needs no approval; links that open outside do.
  createShare: { scope: 'drive:write', approval: 'share.external' },
  updateShare: { scope: 'drive:write', approval: 'share.external' },
  regenerateShareLink: { scope: 'drive:write', approval: 'share.external' },
  deleteShare: { scope: 'drive:write', approval: 'api.call' },
  createOfficeDocument: { scope: 'drive:write', approval: null },
  // Mail: filing is free, anything that leaves the building waits for the person.
  mailUpdateFlags: { scope: 'mail:send', approval: null },
  mailMoveMessages: { scope: 'mail:send', approval: null },
  mailSaveAttachment: { scope: 'mail:send', approval: null },
  mailDeleteMessages: { scope: 'mail:send', approval: 'api.call' },
  mailSend: { scope: 'mail:send', approval: 'api.call' },
  mailInboxReply: { scope: 'mail:send', approval: 'api.call' },
  mailUpdateInboxConversation: { scope: 'mail:send', approval: null },
  mailAddInboxNote: { scope: 'mail:send', approval: null },
  mailDeleteInboxNote: { scope: 'mail:send', approval: 'api.call' },
  mailRecipients: { scope: 'hub:read', approval: null },
  // Announcements reach the whole org: publishing waits; reading and kudos do not.
  markAnnouncementRead: { scope: 'chat:send', approval: null },
  acknowledgeAnnouncement: { scope: 'chat:send', approval: null },
  createKudos: { scope: 'chat:send', approval: null },
  createAnnouncement: { scope: 'chat:send', approval: 'api.call' },
  updateAnnouncement: { scope: 'chat:send', approval: 'api.call' },
  deleteAnnouncement: { scope: 'chat:send', approval: 'api.call' },
  deleteKudos: { scope: 'chat:send', approval: 'api.call' },
  // Forms collect data like tables.
  createForm: { scope: 'tables:write', approval: null },
  updateForm: { scope: 'tables:write', approval: null },
  submitForm: { scope: 'tables:write', approval: null },
  uploadFormFile: { scope: 'tables:write', approval: null },
  exportFormToDrive: { scope: 'tables:write', approval: null },
  deleteForm: { scope: 'tables:write', approval: 'api.call' },
  deleteFormResponse: { scope: 'tables:write', approval: 'api.call' },
  regenerateFormLink: { scope: 'tables:write', approval: 'api.call' },
  // Page templates
  applyTemplate: { scope: 'pages:write', approval: null },
  createTemplate: { scope: 'pages:write', approval: null },
  deleteTemplate: { scope: 'pages:write', approval: 'api.call' },
  // Automations act on their own later: every change is an administrative one.
  createAutomationRule: { scope: 'admin:write', approval: 'api.call' },
  updateAutomationRule: { scope: 'admin:write', approval: 'api.call' },
  deleteAutomationRule: { scope: 'admin:write', approval: 'api.call' },
  testAutomationRule: { scope: 'admin:write', approval: 'api.call' },
  regenerateAutomationHook: { scope: 'admin:write', approval: 'api.call' },
  // Spaces, members, invitations, org settings: always the person's explicit decision.
  createSpace: { scope: 'admin:write', approval: 'api.call' },
  updateSpace: { scope: 'admin:write', approval: 'api.call' },
  archiveSpace: { scope: 'admin:write', approval: 'api.call' },
  restoreSpace: { scope: 'admin:write', approval: 'api.call' },
  addSpaceMember: { scope: 'admin:write', approval: 'api.call' },
  updateSpaceMember: { scope: 'admin:write', approval: 'api.call' },
  removeSpaceMember: { scope: 'admin:write', approval: 'api.call' },
  listInvitations: { scope: 'admin:write', approval: null },
  createInvitation: { scope: 'admin:write', approval: 'api.call' },
  revokeInvitation: { scope: 'admin:write', approval: 'api.call' },
  updateMember: { scope: 'admin:write', approval: 'api.call' },
  updateOrg: { scope: 'admin:write', approval: 'api.call' },
  updateMeetSpaceSettings: { scope: 'admin:write', approval: 'api.call' },
  updateCelebrationSettings: { scope: 'admin:write', approval: 'api.call' },
  createKudosBadge: { scope: 'admin:write', approval: 'api.call' },
  updateKudosBadge: { scope: 'admin:write', approval: 'api.call' },
};

/** Writes whose name says they remove, end or reach other people right away. */
const RISKY_NAME =
  /^(delete|purge|remove|revoke|archive|leave|end|cancel|clear|regenerate|rotate|sendScheduled|createScheduledMessage|createPoll|closePoll|import|syncWorkspace|createLegalHold)/;

/** Small, reversible writes the pattern above would catch. */
const TRIVIAL = new Set<string>([
  'removeReaction',
  'removeGroupLink',
  'deleteCard',
  'deleteChatReminder',
  'removeBoardCardLink',
  'deleteBoardTimeEntry',
  'cancelGuestRequest',
  'deleteBoardCardComment',
  'deletePageComment',
  'deleteTableRowComment',
]);

/**
 * The scope an MCP connection needs for an endpoint, and whether it waits for approval;
 * null = not reachable over MCP. The vault, MCP management, identity, federation and
 * plugin administration stay out as for REST tokens.
 */
export function operationRule(name: string): OperationRule | null {
  if (!Object.hasOwn(endpoints, name)) return null;
  const def: EndpointDef = endpoints[name as EndpointName];
  if (def.auth === 'public' || BLOCKED.has(name)) return null;
  const extra = EXTRA[name];
  if (extra) return extra;
  const scope = tokenScopeOf(name as EndpointName);
  if (!scope) return null;
  if (scope === 'hub:read') return { scope, approval: null };
  const risky = (def.method === 'DELETE' || RISKY_NAME.test(name)) && !TRIVIAL.has(name);
  return { scope, approval: risky ? 'api.call' : null };
}

export const isReadOperation = (name: string) => {
  const rule = operationRule(name);
  return rule !== null && rule.scope === 'hub:read' && rule.approval === null;
};

// ---- the in-process call --------------------------------------------------------------------

interface InternalCall {
  principal: McpPrincipal;
  via: Record<string, unknown>;
}

const CALLS = new WeakMap<Request, InternalCall>();

/** Keyed by the deps' database handle, which the worker's deps share with the api's. */
type Fetcher = { fetch(req: Request): Response | Promise<Response> };
const APPS = new WeakMap<object, Fetcher>();

export function registerInternalApp(deps: Pick<Deps, 'db'>, app: Fetcher) {
  APPS.set(deps.db, app);
}

async function appFor(deps: Deps): Promise<Fetcher> {
  const known = APPS.get(deps.db);
  if (known) return known;
  // The worker (approval.apply) has no router of its own: build one on its deps.
  const { createApp } = await import('../../app');
  const app = createApp(deps);
  APPS.set(deps.db, app);
  return app;
}

/**
 * Router side: an in-process MCP call authenticates as its person, like a personal token
 * (scopes were checked by the tool; spaces and items are filtered by the router).
 */
export async function internalAuth(deps: Deps, c: Context<AppEnv>): Promise<TokenAuth | null> {
  const call = CALLS.get(c.req.raw);
  if (!call) return null;
  const { principal } = call;
  const [user] = await deps.db.select().from(users).where(eq(users.id, principal.userId));
  if (!user) throw new AppError('unauthenticated');
  const session = {
    id: principal.tokenId ?? principal.grantId ?? 'mcp-internal',
    token: '',
    userId: user.id,
    // Never "just signed in": re-verification needs a real session.
    createdAt: new Date(0),
    updatedAt: new Date(0),
    expiresAt: new Date(Date.now() + 60_000),
    ipAddress: c.req.header('x-forwarded-for') ?? null,
    userAgent: 'mcp',
    activeOrganizationId: principal.orgId,
  } as unknown as AuthSession;
  return { principal, user: user as unknown as AuthUser, session, via: call.via };
}

export interface OperationInput {
  params?: Record<string, string> | undefined;
  query?: Record<string, unknown> | undefined;
  body?: unknown;
}

export interface CallerInfo {
  principal: McpPrincipal;
  via: Record<string, unknown>;
  locale: string | null;
  ip: string | null;
  requestId?: string;
  idempotencyKey?: string | null;
}

/** A person acting through an approval or an undo, outside any MCP connection's limits. */
export function personPrincipal(input: {
  userId: string;
  orgId: string;
  name: string;
  grantId?: string | null;
  tokenId?: string | null;
}): McpPrincipal {
  return {
    kind: input.grantId ? 'oauth' : 'token',
    grantId: input.grantId ?? null,
    tokenId: input.tokenId ?? null,
    name: input.name,
    userId: input.userId,
    orgId: input.orgId,
    scopes: [...MCP_SCOPES],
    spaceIds: null,
    expiresAt: null,
    allowedIps: null,
  };
}

function pathOf(def: EndpointDef, params: Record<string, string>) {
  return def.path.replace(/:([A-Za-z0-9_]+)/g, (_, key: string) => {
    const value = params[key];
    if (typeof value !== 'string' || value === '') {
      throw new ToolError('validation_failed', `params.${key} gerekli.`);
    }
    return encodeURIComponent(value);
  });
}

function queryString(query: Record<string, unknown> | undefined) {
  if (!query) return '';
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    qs.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  const s = qs.toString();
  return s ? `?${s}` : '';
}

/**
 * Runs one endpoint as the caller's person and returns its JSON. Errors come back as the
 * API's own codes and messages (ToolError), so the assistant reads what the screen would say.
 */
export async function callOperation(
  deps: Deps,
  caller: CallerInfo,
  name: EndpointName,
  input: OperationInput,
): Promise<unknown> {
  const def: EndpointDef = endpoints[name];
  const url = `http://crewhall.internal${pathOf(def, input.params ?? {})}${queryString(input.query)}`;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (caller.locale) headers['accept-language'] = caller.locale;
  if (caller.ip) headers['x-forwarded-for'] = caller.ip;
  if (caller.requestId) headers['x-request-id'] = caller.requestId;
  if (caller.idempotencyKey) headers['idempotency-key'] = caller.idempotencyKey;
  const req = new Request(url, {
    method: def.method,
    headers,
    ...(def.method !== 'GET' && def.body ? { body: JSON.stringify(input.body ?? {}) } : {}),
  });
  CALLS.set(req, { principal: caller.principal, via: caller.via });
  const app = await appFor(deps);
  const res = await app.fetch(req);
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  if (!res.ok) {
    const err = (json && typeof json === 'object' ? json : {}) as {
      code?: unknown;
      message?: unknown;
      details?: unknown;
    };
    throw new ToolError(
      typeof err.code === 'string' ? err.code : `http_${res.status}`,
      typeof err.message === 'string' ? err.message : `İstek ${res.status} ile bitti.`,
      err.details && typeof err.details === 'object'
        ? (err.details as Record<string, unknown>)
        : undefined,
    );
  }
  return json;
}

// ---- catalog --------------------------------------------------------------------------------

export interface OperationInfo {
  name: EndpointName;
  method: string;
  path: string;
  module: string;
  scope: McpScope;
  approval: ApprovalAction | null;
}

let catalog: OperationInfo[] | null = null;

/** Every operation MCP can reach, computed once from the contract table. */
export function operations(): OperationInfo[] {
  catalog ??= buildCatalog();
  return catalog;
}

function buildCatalog(): OperationInfo[] {
  const out: OperationInfo[] = [];
  for (const name of Object.keys(endpoints) as EndpointName[]) {
    const rule = operationRule(name);
    if (!rule) continue;
    const def: EndpointDef = endpoints[name];
    out.push({
      name,
      method: def.method,
      path: def.path,
      module: MODULE_OF_ENDPOINT[name] ?? 'core',
      scope: rule.scope,
      approval: rule.approval,
    });
  }
  return out;
}
