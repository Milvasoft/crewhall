import { z } from 'zod';
import { page } from '../schemas/common';
import { Empty, def, items, type EndpointDef } from '../endpoint-def';
import {
  ActivityQuery,
  ApiToken,
  ApprovalDetail,
  ApprovalListQuery,
  ApprovalSummary,
  ConsentDecision,
  ConsentDenial,
  ConsentInfo,
  ConsentRequest,
  ConsentResult,
  CreateApiToken,
  CreatedApiToken,
  McpClientInfo,
  McpGrant,
  McpGrantDetail,
  McpOrgConnection,
  McpOverview,
  McpPolicy,
  McpReauth,
  McpReauthResult,
  McpToolCatalog,
  McpUsage,
  RejectApproval,
  ToolCall,
  UpdateMcpClient,
  UpdateMcpGrant,
  UpdateMcpPolicy,
} from '../schemas/mcp';

/**
 * MCP and API access (design 18, doc 17 §13). Only the mcp session edits this file.
 *
 * The MCP server itself (`/mcp`) and the OAuth 2.1 endpoints (`/.well-known/*`,
 * `/oauth/register`, `/oauth/authorize`, `/oauth/token`, `/oauth/revoke`) follow their
 * own RFCs and are not part of this table. The consent page talks to the endpoints below.
 */
export const mcpEndpoints = {
  // ---- Hesabım › MCP ve API (18.1, 18.4, 18.5) ----
  getMcpOverview: def({
    method: 'GET',
    path: '/api/v1/mcp/overview',
    auth: 'session',
    response: McpOverview,
  }),
  listMcpGrants: def({
    method: 'GET',
    path: '/api/v1/mcp/grants',
    auth: 'session',
    response: items(McpGrant),
  }),
  getMcpGrant: def({
    method: 'GET',
    path: '/api/v1/mcp/grants/:grantId',
    auth: 'session',
    response: McpGrantDetail,
  }),
  /** Narrowing is immediate; widening or extending needs re-verification (403 mcp_reauth_required). */
  updateMcpGrant: def({
    method: 'PATCH',
    path: '/api/v1/mcp/grants/:grantId',
    auth: 'session',
    body: UpdateMcpGrant,
    response: McpGrant,
  }),
  /** "Bağlantıyı kes": refresh and access tokens stop working (≤ 30 s on other nodes). */
  revokeMcpGrant: def({
    method: 'DELETE',
    path: '/api/v1/mcp/grants/:grantId',
    auth: 'session',
    response: Empty,
  }),
  listMcpTokens: def({
    method: 'GET',
    path: '/api/v1/mcp/tokens',
    auth: 'session',
    response: items(ApiToken),
  }),
  /** The value comes back once; 422 mcp_expiry_not_allowed beyond the policy maximum. */
  createMcpToken: def({
    method: 'POST',
    path: '/api/v1/mcp/tokens',
    auth: 'session',
    body: CreateApiToken,
    response: CreatedApiToken,
  }),
  revokeMcpToken: def({
    method: 'DELETE',
    path: '/api/v1/mcp/tokens/:tokenId',
    auth: 'session',
    response: Empty,
  }),
  /** Password re-verification for approvals and widening (valid 10 minutes). */
  mcpReauth: def({
    method: 'POST',
    path: '/api/v1/mcp/reauth',
    auth: 'session',
    body: McpReauth,
    response: McpReauthResult,
  }),

  // ---- Etkinlik (18.6) ----
  listMcpActivity: def({
    method: 'GET',
    path: '/api/v1/mcp/activity',
    auth: 'session',
    query: ActivityQuery,
    response: page(ToolCall),
  }),
  /** Reverse a write within 7 days; 409 mcp_undo_stale when someone changed the target. */
  undoMcpToolCall: def({
    method: 'POST',
    path: '/api/v1/mcp/activity/:callNo/undo',
    auth: 'session',
    response: ToolCall,
  }),

  // ---- Onay bekleyenler (18.7) ----
  listMcpApprovals: def({
    method: 'GET',
    path: '/api/v1/mcp/approvals',
    auth: 'session',
    query: ApprovalListQuery,
    response: page(ApprovalSummary),
  }),
  getMcpApproval: def({
    method: 'GET',
    path: '/api/v1/mcp/approvals/:approvalId',
    auth: 'session',
    response: ApprovalDetail,
  }),
  /** 403 mcp_reauth_required without a recent passkey/password check; applies in the worker. */
  approveMcpApproval: def({
    method: 'POST',
    path: '/api/v1/mcp/approvals/:approvalId/approve',
    auth: 'session',
    response: ApprovalDetail,
  }),
  rejectMcpApproval: def({
    method: 'POST',
    path: '/api/v1/mcp/approvals/:approvalId/reject',
    auth: 'session',
    body: RejectApproval,
    response: ApprovalDetail,
  }),

  // ---- Araç belgeleri (18.11) ----
  getMcpToolCatalog: def({
    method: 'GET',
    path: '/api/v1/mcp/tools',
    auth: 'session',
    response: McpToolCatalog,
  }),

  // ---- OAuth onay ekranı (18.2, 18.3) ----
  /** Validates the /oauth/authorize request and describes it; 400 mcp_consent_invalid. */
  getMcpConsent: def({
    method: 'GET',
    path: '/api/v1/mcp/consent',
    auth: 'session',
    query: ConsentRequest,
    response: ConsentInfo,
  }),
  approveMcpConsent: def({
    method: 'POST',
    path: '/api/v1/mcp/consent',
    auth: 'session',
    body: ConsentDecision,
    response: ConsentResult,
  }),
  denyMcpConsent: def({
    method: 'POST',
    path: '/api/v1/mcp/consent/deny',
    auth: 'session',
    body: ConsentDenial,
    response: ConsentResult,
  }),

  // ---- Yönetim › MCP ve API (18.10), org.update_settings ----
  getMcpPolicy: def({
    method: 'GET',
    path: '/api/v1/mcp/policy',
    auth: 'session',
    response: McpPolicy,
  }),
  /** Scopes taken out drop from existing connections at once. */
  updateMcpPolicy: def({
    method: 'PATCH',
    path: '/api/v1/mcp/policy',
    auth: 'session',
    body: UpdateMcpPolicy,
    response: McpPolicy,
  }),
  listMcpClients: def({
    method: 'GET',
    path: '/api/v1/mcp/org/clients',
    auth: 'session',
    response: items(McpClientInfo),
  }),
  updateMcpClient: def({
    method: 'PATCH',
    path: '/api/v1/mcp/org/clients/:mcpClientId',
    auth: 'session',
    body: UpdateMcpClient,
    response: McpClientInfo,
  }),
  listMcpOrgConnections: def({
    method: 'GET',
    path: '/api/v1/mcp/org/connections',
    auth: 'session',
    query: z.object({ kind: z.enum(['grant', 'token']).optional() }),
    response: items(McpOrgConnection),
  }),
  revokeMcpOrgGrant: def({
    method: 'DELETE',
    path: '/api/v1/mcp/org/grants/:grantId',
    auth: 'session',
    response: Empty,
  }),
  revokeMcpOrgToken: def({
    method: 'DELETE',
    path: '/api/v1/mcp/org/tokens/:tokenId',
    auth: 'session',
    response: Empty,
  }),
  getMcpUsage: def({
    method: 'GET',
    path: '/api/v1/mcp/org/usage',
    auth: 'session',
    query: z.object({ days: z.coerce.number().int().min(1).max(90).default(14) }),
    response: McpUsage,
  }),
} as const satisfies Record<string, EndpointDef>;
