import { z } from 'zod';
import { Id, PageQuery, Timestamp } from './common';

/**
 * MCP and API access (design 18, doc 17 §13). Claude and other MCP clients act on a
 * person's behalf; every connection (OAuth grant or personal token) is narrowed by
 * scopes and a space list. The vault is never a scope.
 */

/** Connection scopes (doc 17 §13). `hub:read` is always granted. */
export const MCP_SCOPES = [
  'hub:read',
  'pages:write',
  'quick:write',
  'drive:write',
  'boards:write',
  'chat:send',
  'portal:draft',
  'portal:publish',
  'meetings:write',
  'calendar:write',
  'contacts:write',
  'tables:write',
  /** Plugins only for now: notify people who opened the plugin (no REST endpoint needs it). */
  'notifications:write',
] as const;
export const McpScope = z.enum(MCP_SCOPES);
export type McpScope = z.infer<typeof McpScope>;

export const MCP_REQUIRED_SCOPE: McpScope = 'hub:read';

/** Scopes whose every risky call goes through the approval queue regardless of policy. */
export const MCP_ALWAYS_APPROVED_SCOPES: readonly McpScope[] = ['portal:publish'];

/** Personal access tokens start with this prefix (design 18.4). */
export const PAT_PREFIX = 'mhp_';

/** Server limits shown in the UI and enforced on /mcp (doc 17 §13 "Sınırlar"). */
export const MCP_LIMITS = {
  requestsPerMinute: 60,
  writesPerMinute: 20,
  responseBytes: 256 * 1024,
  inlineUploadBytes: 25 * 1024 * 1024,
  pageMarkdownChars: 200_000,
  toolTimeoutMs: 30_000,
  concurrentCallsPerGrant: 4,
  approvalTtlHours: 24,
  undoDays: 7,
  activityRetentionDays: 90,
  accessTokenSeconds: 3600,
} as const;

export const McpVia = z.object({
  kind: z.enum(['oauth', 'token']),
  /** Client name (OAuth) or token name. */
  name: z.string(),
  grantId: Id.nullable(),
  tokenId: Id.nullable(),
});
export type McpVia = z.infer<typeof McpVia>;

export const McpSpaceRef = z.object({
  id: Id,
  name: z.string(),
  kind: z.enum(['personal', 'shared']),
  color: z.string(),
});
export type McpSpaceRef = z.infer<typeof McpSpaceRef>;

// ---- connected clients (OAuth grants) ----------------------------------------------

export const McpClientRegistration = z.enum(['dcr', 'admin', 'builtin']);
export const McpClientStatus = z.enum(['allowed', 'pending', 'blocked']);

export const McpClientInfo = z.object({
  id: Id,
  clientId: z.string(),
  name: z.string(),
  softwareId: z.string().nullable(),
  softwareVersion: z.string().nullable(),
  redirectUris: z.array(z.string()),
  registration: McpClientRegistration,
  status: McpClientStatus,
  createdAt: Timestamp,
});
export type McpClientInfo = z.infer<typeof McpClientInfo>;

export const McpGrant = z.object({
  id: Id,
  client: McpClientInfo.pick({ id: true, name: true, softwareId: true, registration: true }),
  label: z.string().nullable(),
  scopes: z.array(McpScope),
  /** null = every space the person can reach. */
  spaces: z.array(McpSpaceRef).nullable(),
  expiresAt: Timestamp.nullable(),
  lastUsedAt: Timestamp.nullable(),
  lastIp: z.string().nullable(),
  createdAt: Timestamp,
  revokedAt: Timestamp.nullable(),
});
export type McpGrant = z.infer<typeof McpGrant>;

export const UpdateMcpGrant = z.object({
  label: z.string().trim().min(1).max(80).optional(),
  /** Narrowing applies at once; widening needs a fresh re-verification (mcp_reauth_required). */
  scopes: z.array(McpScope).min(1).optional(),
  spaceIds: z.array(Id).max(200).nullable().optional(),
  /** Extend the expiry by this many days from now (policy maximum applies). */
  extendDays: z.number().int().min(1).max(3650).optional(),
});
export type UpdateMcpGrant = z.infer<typeof UpdateMcpGrant>;

// ---- personal access tokens ----------------------------------------------------------

export const ApiToken = z.object({
  id: Id,
  name: z.string(),
  /** First 8 characters, e.g. "mhp_4fT9", to recognise the token in lists. */
  prefix: z.string(),
  scopes: z.array(McpScope),
  spaces: z.array(McpSpaceRef).nullable(),
  allowedIps: z.array(z.string()).nullable(),
  expiresAt: Timestamp.nullable(),
  lastUsedAt: Timestamp.nullable(),
  createdAt: Timestamp,
  revokedAt: Timestamp.nullable(),
});
export type ApiToken = z.infer<typeof ApiToken>;

const Cidr = z
  .string()
  .trim()
  .regex(/^[0-9a-fA-F:.]+(\/\d{1,3})?$/, 'cidr');

export const CreateApiToken = z.object({
  name: z.string().trim().min(1).max(80),
  scopes: z.array(McpScope).min(1),
  spaceIds: z.array(Id).max(200).nullable(),
  /** null = no expiry (only when the org policy allows it). */
  expiresInDays: z.number().int().min(1).max(3650).nullable(),
  allowedIps: z.array(Cidr).max(20).nullable().optional(),
});
export type CreateApiToken = z.infer<typeof CreateApiToken>;

/** `value` is shown exactly once; the server keeps only its sha256. */
export const CreatedApiToken = z.object({ token: ApiToken, value: z.string() });
export type CreatedApiToken = z.infer<typeof CreatedApiToken>;

// ---- overview ------------------------------------------------------------------------

export const McpOverview = z.object({
  serverUrl: z.url(),
  /** Org policy: MCP on, and this person may connect (guests only when allowed). */
  enabled: z.boolean(),
  disabledReason: z.enum(['org_disabled', 'guests_not_allowed']).nullable(),
  patsEnabled: z.boolean(),
  /** Policy bounds the person's own choices (consent, tokens, narrowing). */
  allowedScopes: z.array(McpScope),
  maxTokenDays: z.number().int().nullable(),
  todayCalls: z.number().int(),
  todayWrites: z.number().int(),
  todayErrors: z.number().int(),
  pendingApprovals: z.number().int(),
  grants: z.number().int(),
  tokens: z.number().int(),
});
export type McpOverview = z.infer<typeof McpOverview>;

// ---- activity (tool_calls) -----------------------------------------------------------

export const ToolCallResult = z.enum(['ok', 'error', 'pending_approval']);

export const ToolCall = z.object({
  /** tool_calls is a bigint identity table; the id travels as a string. */
  id: z.string(),
  tool: z.string(),
  via: McpVia,
  /** Trimmed parameters: secrets and long texts cut. */
  params: z.record(z.string(), z.unknown()),
  target: z
    .object({ type: z.string(), id: z.string().nullable(), label: z.string().nullable() })
    .nullable(),
  result: ToolCallResult,
  errorCode: z.string().nullable(),
  summary: z.string().nullable(),
  approvalId: Id.nullable(),
  approvalStatus: z.string().nullable(),
  canUndo: z.boolean(),
  undoneAt: Timestamp.nullable(),
  write: z.boolean(),
  requestId: z.string().nullable(),
  durationMs: z.number().int().nullable(),
  ip: z.string().nullable(),
  at: Timestamp,
});
export type ToolCall = z.infer<typeof ToolCall>;

export const ActivityFilter = z.enum(['all', 'write', 'pending', 'error', 'undone']);

export const ActivityQuery = PageQuery.extend({
  filter: ActivityFilter.default('write'),
  grantId: Id.optional(),
  tokenId: Id.optional(),
  q: z.string().trim().max(100).optional(),
  /** Hours back from now; default 24. */
  hours: z.coerce
    .number()
    .int()
    .min(1)
    .max(24 * 90)
    .default(24),
});

// ---- approvals -----------------------------------------------------------------------

export const ApprovalStatus = z.enum([
  'pending',
  'approved',
  'rejected',
  'expired',
  'stale',
  'applied',
  'failed',
]);
export type ApprovalStatus = z.infer<typeof ApprovalStatus>;

export const ApprovalAction = z.enum([
  'node.trash',
  'bulk',
  'share.external',
  'portal.publish',
  'chat.space_message',
  /** Proposed by the AI assistant (yol haritası #18). */
  'ai.action',
  /** A plugin's assistant tool that writes (docs/contracts/eklentiler.md). */
  'plugin.tool',
]);
export type ApprovalAction = z.infer<typeof ApprovalAction>;

export const ApprovalPreviewItem = z.object({
  kind: z.string(),
  label: z.string(),
  detail: z.string().nullable(),
  /** e.g. a node path "Milvasoft › Toplantı notları". */
  location: z.string().nullable(),
});

export const ApprovalSummary = z.object({
  id: Id,
  action: ApprovalAction,
  tool: z.string(),
  title: z.string(),
  target: z.string().nullable(),
  itemCount: z.number().int(),
  via: McpVia,
  status: ApprovalStatus,
  createdAt: Timestamp,
  expiresAt: Timestamp,
  decidedAt: Timestamp.nullable(),
});
export type ApprovalSummary = z.infer<typeof ApprovalSummary>;

export const ApprovalDetail = ApprovalSummary.extend({
  /** Unverified text from the client: context, not a reason to approve. */
  clientNote: z.string().nullable(),
  items: z.array(ApprovalPreviewItem),
  /** The frozen tool input the approval applies to. */
  payload: z.record(z.string(), z.unknown()),
  decidedBy: z.object({ id: Id, name: z.string() }).nullable(),
  errorCode: z.string().nullable(),
  /** Approving needs a passkey or password check in the last 10 minutes. */
  needsReauth: z.boolean(),
  /** What the applied action created or changed (ids), once it is applied. */
  result: z.record(z.string(), z.unknown()).nullable().optional(),
});
export type ApprovalDetail = z.infer<typeof ApprovalDetail>;

export const ApprovalListQuery = PageQuery.extend({
  status: z.enum(['pending', 'history']).default('pending'),
});

export const RejectApproval = z.object({ reason: z.string().trim().max(500).optional() });

// ---- re-verification -----------------------------------------------------------------

/**
 * Password check for approvals and widening a connection. A passkey sign-in counts too:
 * it starts a fresh session, which is itself a recent verification.
 */
export const McpReauth = z.object({ password: z.string().min(1).max(256) });
export const McpReauthResult = z.object({ verifiedUntil: Timestamp });

// ---- tool catalog --------------------------------------------------------------------

export const McpToolDoc = z.object({
  name: z.string(),
  title: z.string(),
  description: z.string(),
  scope: McpScope,
  /** When a human approval kicks in: null = never. */
  approval: z.enum(['always', 'bulk', 'policy']).nullable(),
  readOnly: z.boolean(),
  destructive: z.boolean(),
  idempotent: z.boolean(),
  inputSchema: z.record(z.string(), z.unknown()),
  example: z.record(z.string(), z.unknown()).nullable(),
  /** In at least one of my connections. */
  available: z.boolean(),
});
export type McpToolDoc = z.infer<typeof McpToolDoc>;

export const McpToolCatalog = z.object({
  tools: z.array(McpToolDoc),
  resources: z.array(
    z.object({ uriTemplate: z.string(), name: z.string(), description: z.string() }),
  ),
  limits: z.object({
    requestsPerMinute: z.number().int(),
    writesPerMinute: z.number().int(),
    responseBytes: z.number().int(),
  }),
});
export type McpToolCatalog = z.infer<typeof McpToolCatalog>;

// ---- OAuth consent (design 18.2, 18.3) -----------------------------------------------

/** The /oauth/authorize query, passed through to the consent page unchanged. */
export const ConsentRequest = z.object({
  client_id: z.string().min(1).max(200),
  redirect_uri: z.string().min(1).max(2000),
  response_type: z.literal('code'),
  code_challenge: z.string().min(43).max(128),
  code_challenge_method: z.literal('S256'),
  scope: z.string().max(1000).optional(),
  state: z.string().max(2000).optional(),
  resource: z.string().max(2000).optional(),
});
export type ConsentRequest = z.infer<typeof ConsentRequest>;

export const ConsentDuration = z.enum(['7d', '30d', '90d', 'never']);
export type ConsentDuration = z.infer<typeof ConsentDuration>;

export const ConsentScopeOption = z.object({
  scope: McpScope,
  requested: z.boolean(),
  /** false: the org policy does not allow it; shown disabled. */
  allowed: z.boolean(),
  required: z.boolean(),
  /** Some calls under this scope wait for a human approval. */
  approval: z.boolean(),
});

export const ConsentInfo = z.object({
  client: z.object({
    name: z.string(),
    registration: McpClientRegistration,
    status: McpClientStatus,
    redirectUri: z.string(),
    /** Shown prominently: the client name is not verified (DCR). */
    redirectHost: z.string(),
  }),
  user: z.object({ name: z.string(), email: z.string(), orgName: z.string() }),
  scopes: z.array(ConsentScopeOption),
  spaces: z.array(McpSpaceRef),
  durations: z.array(ConsentDuration),
  defaultDuration: ConsentDuration,
  needsReauth: z.boolean(),
  /** Binds the decision to this user, session and request (CSRF); 10 minutes. */
  consentToken: z.string(),
});
export type ConsentInfo = z.infer<typeof ConsentInfo>;

export const ConsentDecision = ConsentRequest.extend({
  consentToken: z.string().min(1).max(500),
  scopes: z.array(McpScope).min(1),
  spaceIds: z.array(Id).max(200).nullable(),
  duration: ConsentDuration,
  label: z.string().trim().max(80).optional(),
});
export type ConsentDecision = z.infer<typeof ConsentDecision>;

export const ConsentDenial = ConsentRequest.extend({ consentToken: z.string().min(1).max(500) });

/** The browser goes here next: the client's redirect_uri with code/error, state and iss. */
export const ConsentResult = z.object({
  redirectTo: z.string(),
  grantId: Id.nullable(),
});
export type ConsentResult = z.infer<typeof ConsentResult>;

// ---- org policy (design 18.10) -------------------------------------------------------

export const ApprovalRule = z.enum([
  'portal_publish',
  'trash',
  'bulk',
  'external_share',
  'chat_space_message',
]);
export type ApprovalRule = z.infer<typeof ApprovalRule>;

/** These always go through a human approval; the policy cannot turn them off. */
export const LOCKED_APPROVAL_RULES: readonly ApprovalRule[] = [
  'portal_publish',
  'trash',
  'bulk',
  'external_share',
];

export const McpPolicy = z.object({
  enabled: z.boolean(),
  patsEnabled: z.boolean(),
  guestsAllowed: z.boolean(),
  /** "listed": new DCR clients wait for an admin; "all": any MCP client may connect. */
  clientMode: z.enum(['listed', 'all']),
  /** Longest lifetime of a connection or token in days; null = no expiry allowed. */
  maxTokenDays: z.number().int().min(1).max(3650).nullable(),
  allowedScopes: z.array(McpScope),
  approvalRules: z.array(ApprovalRule),
  requestsPerMinute: z.number().int().min(1).max(600),
  writesPerMinute: z.number().int().min(1).max(200),
  updatedAt: Timestamp.nullable(),
});
export type McpPolicy = z.infer<typeof McpPolicy>;

export const UpdateMcpPolicy = McpPolicy.omit({ updatedAt: true }).partial();
export type UpdateMcpPolicy = z.infer<typeof UpdateMcpPolicy>;

export const UpdateMcpClient = z.object({ status: McpClientStatus });

/** A connection in the org list: admins see who and what, never content or token values. */
export const McpOrgConnection = z.object({
  id: Id,
  kind: z.enum(['grant', 'token']),
  user: z.object({ id: Id, name: z.string(), imageUrl: z.string().nullable() }),
  name: z.string(),
  scopes: z.array(McpScope),
  spaces: z.array(McpSpaceRef).nullable(),
  lastUsedAt: Timestamp.nullable(),
  expiresAt: Timestamp.nullable(),
  createdAt: Timestamp,
});
export type McpOrgConnection = z.infer<typeof McpOrgConnection>;

export const McpUsage = z.object({
  days: z.array(
    z.object({
      date: z.string(),
      calls: z.number().int(),
      writes: z.number().int(),
      errors: z.number().int(),
    }),
  ),
  tools: z.array(z.object({ tool: z.string(), calls: z.number().int() })),
  people: z.number().int(),
});
export type McpUsage = z.infer<typeof McpUsage>;

export const McpGrantDetail = McpGrant.extend({
  client: McpClientInfo.pick({
    id: true,
    name: true,
    softwareId: true,
    registration: true,
    redirectUris: true,
  }),
  calls24h: z.number().int(),
  recentCalls: z.array(ToolCall),
});
export type McpGrantDetail = z.infer<typeof McpGrantDetail>;
