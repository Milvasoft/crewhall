import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import { sessions, users } from './auth';
import { organizations } from './org';
import { id, timestamps, tz } from './types';

/**
 * MCP and API access (doc 17 §13, design 18). Tokens, codes and refresh tokens are
 * stored only as sha256 hashes. Every table carries org_id.
 */

export const mcpClientRegistration = pgEnum('mcp_client_registration', ['dcr', 'admin', 'builtin']);
export const mcpClientStatus = pgEnum('mcp_client_status', ['allowed', 'pending', 'blocked']);
export const toolCallResult = pgEnum('tool_call_result', ['ok', 'error', 'pending_approval']);
export const approvalStatus = pgEnum('approval_status', [
  'pending',
  'approved',
  'rejected',
  'expired',
  'stale',
  'applied',
  'failed',
]);

/** Per-org MCP policy (18.10); a missing row means the defaults. */
export const mcpPolicies = pgTable('mcp_policies', {
  orgId: uuid('org_id')
    .primaryKey()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  enabled: boolean('enabled').notNull().default(true),
  patsEnabled: boolean('pats_enabled').notNull().default(true),
  guestsAllowed: boolean('guests_allowed').notNull().default(false),
  clientMode: text('client_mode', { enum: ['listed', 'all'] })
    .notNull()
    .default('all'),
  /** null = connections may be open-ended. */
  maxTokenDays: integer('max_token_days').default(90),
  allowedScopes: text('allowed_scopes').array().notNull(),
  approvalRules: text('approval_rules').array().notNull(),
  requestsPerMinute: integer('requests_per_minute').notNull().default(60),
  writesPerMinute: integer('writes_per_minute').notNull().default(20),
  ...timestamps(),
});

/** OAuth clients: dynamic registration, admin-added or built in. status is the allow list. */
export const mcpClients = pgTable(
  'mcp_clients',
  {
    id: id(),
    orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }),
    clientId: text('client_id').notNull().unique(),
    /** Not verified (DCR); the consent screen shows the redirect host next to it. */
    name: text('name').notNull(),
    softwareId: text('software_id'),
    softwareVersion: text('software_version'),
    clientUri: text('client_uri'),
    logoUri: text('logo_uri'),
    redirectUris: text('redirect_uris').array().notNull(),
    /** 'none' (public client, PKCE only) or a client secret method; secret stored as sha256. */
    tokenEndpointAuthMethod: text('token_endpoint_auth_method', {
      enum: ['none', 'client_secret_post', 'client_secret_basic'],
    })
      .notNull()
      .default('none'),
    clientSecretHash: text('client_secret_hash'),
    registration: mcpClientRegistration('registration').notNull().default('dcr'),
    status: mcpClientStatus('status').notNull().default('allowed'),
    registeredIp: text('registered_ip'),
    ...timestamps(),
  },
  (t) => [index('mcp_clients_org_idx').on(t.orgId, t.status)],
);

/** One row per person, client and device: what Claude may do on the person's behalf. */
export const mcpGrants = pgTable(
  'mcp_grants',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    clientId: uuid('client_id')
      .notNull()
      .references(() => mcpClients.id, { onDelete: 'cascade' }),
    label: text('label'),
    scopes: text('scopes').array().notNull(),
    /** null = every space the person can reach. */
    spaceIds: uuid('space_ids').array(),
    /** The protected resource the tokens are bound to (RFC 8707). */
    resource: text('resource').notNull(),
    refreshHash: text('refresh_hash').unique(),
    /** The refresh token rotated away last; presenting it again revokes the grant. */
    prevRefreshHash: text('prev_refresh_hash'),
    expiresAt: tz('expires_at'),
    lastUsedAt: tz('last_used_at'),
    lastIp: text('last_ip'),
    revokedAt: tz('revoked_at'),
    revokedBy: uuid('revoked_by').references(() => users.id, { onDelete: 'set null' }),
    revokeReason: text('revoke_reason'),
    ...timestamps(),
  },
  (t) => [
    index('mcp_grants_user_idx').on(t.userId, t.revokedAt),
    index('mcp_grants_org_idx').on(t.orgId),
    index('mcp_grants_prev_refresh_idx').on(t.prevRefreshHash),
  ],
);

/** Authorization codes: single use, 60 seconds, PKCE S256. */
export const mcpAuthCodes = pgTable('mcp_auth_codes', {
  id: id(),
  orgId: uuid('org_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  codeHash: text('code_hash').notNull().unique(),
  grantId: uuid('grant_id')
    .notNull()
    .references(() => mcpGrants.id, { onDelete: 'cascade' }),
  clientId: text('client_id').notNull(),
  redirectUri: text('redirect_uri').notNull(),
  codeChallenge: text('code_challenge').notNull(),
  resource: text('resource').notNull(),
  expiresAt: tz('expires_at').notNull(),
  consumedAt: tz('consumed_at'),
  createdAt: tz('created_at').notNull().defaultNow(),
});

/** Opaque one-hour access tokens, tied to their grant. */
export const mcpAccessTokens = pgTable(
  'mcp_access_tokens',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    grantId: uuid('grant_id')
      .notNull()
      .references(() => mcpGrants.id, { onDelete: 'cascade' }),
    resource: text('resource').notNull(),
    expiresAt: tz('expires_at').notNull(),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t) => [index('mcp_access_tokens_grant_idx').on(t.grantId)],
);

/** Personal access tokens (mhp_…) for MCP clients without OAuth, CI and the REST API. */
export const apiTokens = pgTable(
  'api_tokens',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    prefix: text('prefix').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    scopes: text('scopes').array().notNull(),
    spaceIds: uuid('space_ids').array(),
    /** CIDR blocks; null = any address. */
    allowedIps: text('allowed_ips').array(),
    expiresAt: tz('expires_at'),
    lastUsedAt: tz('last_used_at'),
    lastIp: text('last_ip'),
    revokedAt: tz('revoked_at'),
    revokedBy: uuid('revoked_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  (t) => [
    index('api_tokens_user_idx').on(t.userId, t.revokedAt),
    index('api_tokens_org_idx').on(t.orgId),
  ],
);

export interface ToolCallUndo {
  kind:
    | 'trash_nodes'
    | 'restore_nodes'
    | 'delete_card'
    | 'remove_group_link'
    | 'delete_message'
    | 'delete_portal_doc'
    | 'delete_portal_post';
  nodeIds?: string[];
  cardId?: string;
  itemId?: string;
  messageId?: string;
  docId?: string;
  postId?: string;
  /** updated_at of the targets right after the call; a later change blocks one-click undo. */
  revs?: Record<string, string>;
}

/** Every MCP tool call (18.6): kept 90 days, undo valid for 7. */
export const toolCalls = pgTable(
  'tool_calls',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    viaGrantId: uuid('via_grant_id').references(() => mcpGrants.id, { onDelete: 'set null' }),
    viaTokenId: uuid('via_token_id').references(() => apiTokens.id, { onDelete: 'set null' }),
    /** Client or token name at call time, so the row reads well after a revoke. */
    viaName: text('via_name').notNull(),
    tool: text('tool').notNull(),
    write: boolean('write').notNull().default(false),
    params: jsonb('params').$type<Record<string, unknown>>().notNull().default({}),
    targetType: text('target_type'),
    targetId: text('target_id'),
    targetLabel: text('target_label'),
    result: toolCallResult('result').notNull(),
    errorCode: text('error_code'),
    summary: text('summary'),
    approvalId: uuid('approval_id'),
    undo: jsonb('undo').$type<ToolCallUndo>(),
    undoneAt: tz('undone_at'),
    requestId: text('request_id'),
    durationMs: integer('duration_ms'),
    ip: text('ip'),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('tool_calls_user_at_idx').on(t.userId, t.createdAt.desc()),
    index('tool_calls_org_at_idx').on(t.orgId, t.createdAt.desc()),
    index('tool_calls_grant_idx').on(t.viaGrantId, t.createdAt.desc()),
  ],
);

export interface ApprovalPreviewData {
  title: string;
  target: string | null;
  items: { kind: string; label: string; detail: string | null; location: string | null }[];
}

/** Risky calls wait here (18.7); the approval applies to the frozen payload. */
export const approvalRequests = pgTable(
  'approval_requests',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    viaGrantId: uuid('via_grant_id').references(() => mcpGrants.id, { onDelete: 'set null' }),
    viaTokenId: uuid('via_token_id').references(() => apiTokens.id, { onDelete: 'set null' }),
    viaName: text('via_name').notNull(),
    toolCallId: bigint('tool_call_id', { mode: 'number' }),
    action: text('action').notNull(),
    tool: text('tool').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    payloadHash: text('payload_hash').notNull(),
    preview: jsonb('preview').$type<ApprovalPreviewData>().notNull(),
    targetRevs: jsonb('target_revs').$type<Record<string, string>>().notNull().default({}),
    clientNote: text('client_note'),
    status: approvalStatus('status').notNull().default('pending'),
    decidedBy: uuid('decided_by').references(() => users.id, { onDelete: 'set null' }),
    decidedAt: tz('decided_at'),
    rejectReason: text('reject_reason'),
    errorCode: text('error_code'),
    result: jsonb('result').$type<Record<string, unknown>>(),
    expiresAt: tz('expires_at').notNull(),
    ...timestamps(),
  },
  (t) => [
    index('approval_requests_user_status_idx').on(t.userId, t.status, t.createdAt.desc()),
    index('approval_requests_expiry_idx').on(t.status, t.expiresAt),
  ],
);

/** Token buckets for the per-person limits (doc 17 §13: Postgres on a single node). */
export const mcpRateBuckets = pgTable(
  'mcp_rate_buckets',
  {
    /** null for the anonymous OAuth endpoints (keyed by IP). */
    orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }),
    /** user id, or an IP for the anonymous OAuth endpoints. */
    subject: text('subject').notNull(),
    kind: text('kind').notNull(),
    tokens: doublePrecision('tokens').notNull(),
    /** Whether the last take succeeded (set in the same statement as the refill). */
    allowed: boolean('allowed').notNull().default(true),
    updatedAt: tz('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.subject, t.kind] })],
);

/** Recent password re-verification per session (approvals, widening): 10 minutes. */
export const mcpReauth = pgTable('mcp_reauth', {
  sessionId: uuid('session_id')
    .primaryKey()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  verifiedAt: tz('verified_at')
    .notNull()
    .default(sql`now()`),
});
