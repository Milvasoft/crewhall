import {
  LOCKED_APPROVAL_RULES,
  MCP_SCOPES,
  type ApiToken,
  type ApprovalDetail,
  type McpClientInfo,
  type McpGrant,
  type McpPolicy,
  type McpScope,
  type McpSpaceRef,
  type ToolCall,
} from '@crewhall/shared';
import { type EndpointName } from '@crewhall/shared';
import { MockApiError, requireUser, type Resolvers } from './core';
import { db, newId } from './db';
import { type MockState, type MockUser } from './seed';

/**
 * MCP part of the contract mock (design 18): connections, tokens, activity, approvals,
 * consent and the org policy, kept on the mock state like the other modules.
 */

interface McpMockState {
  policy: McpPolicy;
  clients: McpClientInfo[];
  grants: (Omit<McpGrant, 'spaces' | 'client'> & {
    userId: string;
    clientRef: string;
    spaceIds: string[] | null;
  })[];
  tokens: (Omit<ApiToken, 'spaces'> & { userId: string; spaceIds: string[] | null })[];
  calls: (ToolCall & { userId: string })[];
  approvals: (Omit<ApprovalDetail, 'needsReauth' | 'decidedBy'> & {
    userId: string;
    decidedBy: { id: string; name: string } | null;
  })[];
  verifiedAt: number;
  nextCall: number;
}

/** Copy without the mock-only keys. */
function omit<T extends object, K extends keyof T>(obj: T, ...keys: K[]): Omit<T, K> {
  const out = { ...obj };
  for (const k of keys) delete out[k];
  return out;
}

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const ahead = (ms: number) => new Date(Date.now() + ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const SERVER_URL = 'http://localhost:4301/mcp';

function seed(s: MockState): McpMockState {
  const owner = s.users[0];
  const userId = owner?.id ?? '';
  const spaces = s.spaces.filter((x) =>
    s.spaceMembers.some((m) => m.spaceId === x.id && m.userId === userId),
  );
  const personal = spaces.find((x) => x.kind === 'personal')?.id ?? null;
  const shared = spaces.find((x) => x.kind === 'shared')?.id ?? null;
  const pick = [personal, shared].filter((x): x is string => !!x);
  const clients: McpClientInfo[] = [
    {
      id: newId(),
      clientId: 'mcp_c_claudecode',
      name: 'Claude Code',
      softwareId: null,
      softwareVersion: null,
      redirectUris: ['http://localhost:53682/callback'],
      registration: 'dcr',
      status: 'allowed',
      createdAt: ago(18 * DAY),
    },
    {
      id: newId(),
      clientId: 'mcp_c_desktop',
      name: 'Claude Desktop',
      softwareId: null,
      softwareVersion: null,
      redirectUris: ['https://claude.ai/api/mcp/auth_callback'],
      registration: 'dcr',
      status: 'allowed',
      createdAt: ago(30 * DAY),
    },
    {
      id: newId(),
      clientId: 'mcp_c_inspector',
      name: 'mcp-inspector',
      softwareId: null,
      softwareVersion: null,
      redirectUris: ['http://localhost:6274/oauth/callback'],
      registration: 'dcr',
      status: 'pending',
      createdAt: ago(2 * HOUR),
    },
  ];
  const g1 = newId();
  const g2 = newId();
  const t1 = newId();
  const a1 = newId();
  const call = (
    n: number,
    tool: string,
    at: string,
    extra: Partial<ToolCall> = {},
  ): ToolCall & { userId: string } => ({
    id: String(n),
    tool,
    via: { kind: 'oauth', name: 'Claude Code · Dizüstü', grantId: g1, tokenId: null },
    params: {},
    target: null,
    result: 'ok',
    errorCode: null,
    summary: null,
    approvalId: null,
    approvalStatus: null,
    canUndo: false,
    undoneAt: null,
    write: false,
    requestId: `req_${n}`,
    durationMs: 120 + n * 7,
    ip: '85.105.12.44',
    at,
    userId,
    ...extra,
  });
  return {
    policy: {
      enabled: true,
      patsEnabled: true,
      guestsAllowed: false,
      clientMode: 'all',
      maxTokenDays: 90,
      allowedScopes: [...MCP_SCOPES],
      approvalRules: [...LOCKED_APPROVAL_RULES],
      requestsPerMinute: 60,
      writesPerMinute: 20,
      updatedAt: null,
    },
    clients,
    grants: [
      {
        id: g1,
        userId,
        clientRef: clients[0]!.id,
        label: 'Dizüstü',
        scopes: ['hub:read', 'quick:write', 'drive:write'],
        spaceIds: pick.length ? pick : null,
        expiresAt: ahead(26 * DAY),
        lastUsedAt: ago(2 * MIN),
        lastIp: '85.105.12.44',
        createdAt: ago(4 * DAY),
        revokedAt: null,
      },
      {
        id: g2,
        userId,
        clientRef: clients[1]!.id,
        label: 'Windows',
        scopes: ['hub:read'],
        spaceIds: null,
        expiresAt: null,
        lastUsedAt: ago(36 * MIN),
        lastIp: '85.105.12.44',
        createdAt: ago(20 * DAY),
        revokedAt: null,
      },
    ],
    tokens: [
      {
        id: t1,
        userId,
        name: 'CI · sürüm notları',
        prefix: 'mhp_4fT9',
        scopes: ['hub:read', 'drive:write'],
        spaceIds: shared ? [shared] : null,
        allowedIps: null,
        expiresAt: ahead(89 * DAY),
        lastUsedAt: null,
        createdAt: ago(DAY),
        revokedAt: null,
      },
    ],
    calls: [
      call(6, 'trash_nodes', ago(5 * MIN), {
        write: true,
        result: 'pending_approval',
        approvalId: a1,
        approvalStatus: 'pending',
        target: { type: 'approval', id: a1, label: 'Toplantı notları' },
        params: { node_ids: ['…'] },
      }),
      call(5, 'add_link', ago(40 * MIN), {
        write: true,
        canUndo: true,
        target: { type: 'card', id: newId(), label: 'Benim · Status' },
        params: { url: 'https://status.example.com' },
      }),
      call(4, 'create_folder', ago(2 * HOUR), {
        write: true,
        canUndo: true,
        target: { type: 'node', id: newId(), label: 'Sözleşmeler' },
        params: { name: 'Sözleşmeler' },
      }),
      call(3, 'search', ago(2 * HOUR + 3 * MIN), { params: { query: 'sürüm notları' } }),
      call(2, 'send_message', ago(3 * HOUR), {
        write: true,
        result: 'error',
        errorCode: 'insufficient_scope',
        params: { text: 'Merhaba' },
      }),
    ],
    approvals: [
      {
        id: a1,
        userId,
        action: 'node.trash',
        tool: 'trash_nodes',
        title: 'Eski toplantı notları',
        target: 'Toplantı notları',
        itemCount: 3,
        via: { kind: 'oauth', name: 'Claude Code · Dizüstü', grantId: g1, tokenId: null },
        status: 'pending',
        createdAt: ago(5 * MIN),
        expiresAt: ahead(24 * HOUR - 5 * MIN),
        decidedAt: null,
        clientNote: 'Kullanıcı istedi: "Eski toplantı notlarını temizle."',
        items: [
          { kind: 'page', label: 'Eylül toplantısı', detail: null, location: 'Toplantı notları' },
          { kind: 'page', label: 'Ağustos toplantısı', detail: null, location: 'Toplantı notları' },
          { kind: 'file', label: 'notlar-temmuz.pdf', detail: null, location: 'Toplantı notları' },
        ],
        payload: { node_ids: ['…', '…', '…'] },
        decidedBy: null,
        errorCode: null,
      },
    ],
    verifiedAt: 0,
    nextCall: 7,
  };
}

/** The MCP part of the mock db, seeded on first use (tests read it directly). */
export function mcpMockState(s: MockState = db()): McpMockState {
  const holder = s as MockState & { mcp?: McpMockState };
  holder.mcp ??= seed(s);
  return holder.mcp;
}

function refs(s: MockState, ids: string[] | null): McpSpaceRef[] | null {
  if (ids === null) return null;
  return ids
    .map((id) => s.spaces.find((x) => x.id === id))
    .filter((x): x is NonNullable<typeof x> => !!x)
    .map((x) => ({ id: x.id, name: x.name, kind: x.kind, color: x.color }));
}

function mySpaces(s: MockState, u: MockUser): McpSpaceRef[] {
  return s.spaces
    .filter(
      (x) => !x.archivedAt && s.spaceMembers.some((m) => m.spaceId === x.id && m.userId === u.id),
    )
    .map((x) => ({ id: x.id, name: x.name, kind: x.kind, color: x.color }));
}

function toGrant(s: MockState, m: McpMockState, g: McpMockState['grants'][number]): McpGrant {
  const c = m.clients.find((x) => x.id === g.clientRef)!;
  const rest = omit(g, 'userId', 'clientRef', 'spaceIds');
  return {
    ...rest,
    client: { id: c.id, name: c.name, softwareId: c.softwareId, registration: c.registration },
    spaces: refs(s, g.spaceIds),
  };
}

function toToken(s: MockState, t: McpMockState['tokens'][number]): ApiToken {
  return { ...omit(t, 'userId', 'spaceIds'), spaces: refs(s, t.spaceIds) };
}

const fresh = (m: McpMockState) => Date.now() - m.verifiedAt < 10 * MIN;

function ownGrant(m: McpMockState, u: MockUser, id: string) {
  const g = m.grants.find((x) => x.id === id && x.userId === u.id && !x.revokedAt);
  if (!g) throw new MockApiError('not_found');
  return g;
}

function ownApproval(m: McpMockState, u: MockUser, id: string) {
  const a = m.approvals.find((x) => x.id === id && x.userId === u.id);
  if (!a) throw new MockApiError('not_found');
  return a;
}

const detail = (m: McpMockState, a: McpMockState['approvals'][number]): ApprovalDetail => {
  return { ...omit(a, 'userId'), needsReauth: a.status === 'pending' && !fresh(m) };
};

const TOOLS = [
  ['search', 'hub:read', null],
  ['list_spaces', 'hub:read', null],
  ['get_node', 'hub:read', null],
  ['list_children', 'hub:read', null],
  ['list_links', 'hub:read', null],
  ['add_link', 'quick:write', null],
  ['add_quick_card', 'quick:write', null],
  ['upload_file', 'drive:write', null],
  ['complete_upload', 'drive:write', null],
  ['create_folder', 'drive:write', null],
  ['trash_nodes', 'drive:write', 'always'],
  ['list_conversations', 'hub:read', null],
  ['send_message', 'chat:send', 'policy'],
  ['list_notifications', 'hub:read', null],
  ['list_portal_docs', 'hub:read', null],
  ['upsert_portal_doc', 'portal:draft', null],
  ['create_blog_post', 'portal:draft', null],
  ['request_portal_publish', 'portal:publish', 'always'],
  ['list_tables', 'hub:read', null],
  ['query_table_rows', 'hub:read', null],
  ['add_table_rows', 'tables:write', null],
  ['update_table_row', 'tables:write', null],
  ['get_approval', 'hub:read', null],
] as const;

type McpName = Extract<
  EndpointName,
  | 'getMcpOverview'
  | 'listMcpGrants'
  | 'getMcpGrant'
  | 'updateMcpGrant'
  | 'revokeMcpGrant'
  | 'listMcpTokens'
  | 'createMcpToken'
  | 'revokeMcpToken'
  | 'mcpReauth'
  | 'listMcpActivity'
  | 'undoMcpToolCall'
  | 'listMcpApprovals'
  | 'getMcpApproval'
  | 'approveMcpApproval'
  | 'rejectMcpApproval'
  | 'getMcpToolCatalog'
  | 'getMcpConsent'
  | 'approveMcpConsent'
  | 'denyMcpConsent'
  | 'getMcpPolicy'
  | 'updateMcpPolicy'
  | 'listMcpClients'
  | 'updateMcpClient'
  | 'listMcpOrgConnections'
  | 'revokeMcpOrgGrant'
  | 'revokeMcpOrgToken'
  | 'getMcpUsage'
>;

export const mcpResolvers: Resolvers<McpName> = {
  getMcpOverview: ({ s }) => {
    const u = requireUser(s);
    const m = mcpMockState(s);
    const today = m.calls.filter((c) => c.userId === u.id && Date.now() - Date.parse(c.at) < DAY);
    return {
      serverUrl: SERVER_URL,
      enabled: m.policy.enabled,
      disabledReason: m.policy.enabled ? null : 'org_disabled',
      patsEnabled: m.policy.patsEnabled,
      allowedScopes: m.policy.allowedScopes,
      maxTokenDays: m.policy.maxTokenDays,
      todayCalls: today.length,
      todayWrites: today.filter((c) => c.write).length,
      todayErrors: today.filter((c) => c.result === 'error').length,
      pendingApprovals: m.approvals.filter((a) => a.userId === u.id && a.status === 'pending')
        .length,
      grants: m.grants.filter((g) => g.userId === u.id && !g.revokedAt).length,
      tokens: m.tokens.filter((t) => t.userId === u.id && !t.revokedAt).length,
    };
  },
  listMcpGrants: ({ s }) => {
    const u = requireUser(s);
    const m = mcpMockState(s);
    return {
      items: m.grants.filter((g) => g.userId === u.id && !g.revokedAt).map((g) => toGrant(s, m, g)),
    };
  },
  getMcpGrant: ({ s, params }) => {
    const u = requireUser(s);
    const m = mcpMockState(s);
    const g = ownGrant(m, u, params.grantId ?? '');
    const c = m.clients.find((x) => x.id === g.clientRef)!;
    const recent = m.calls.filter((x) => x.via.grantId === g.id).map((x) => omit(x, 'userId'));
    return {
      ...toGrant(s, m, g),
      client: {
        id: c.id,
        name: c.name,
        softwareId: c.softwareId,
        registration: c.registration,
        redirectUris: c.redirectUris,
      },
      calls24h: recent.length,
      recentCalls: recent,
    };
  },
  updateMcpGrant: ({ s, params, body }) => {
    const u = requireUser(s);
    const m = mcpMockState(s);
    const g = ownGrant(m, u, params.grantId ?? '');
    const widens =
      (body.scopes ?? []).some((x) => !g.scopes.includes(x)) ||
      body.extendDays !== undefined ||
      (body.spaceIds === null && g.spaceIds !== null);
    if (widens && !fresh(m)) throw new MockApiError('mcp_reauth_required');
    if (body.scopes) g.scopes = [...new Set<McpScope>(['hub:read', ...body.scopes])];
    if (body.spaceIds !== undefined) g.spaceIds = body.spaceIds;
    if (body.label) g.label = body.label;
    if (body.extendDays) g.expiresAt = ahead(body.extendDays * DAY);
    return toGrant(s, m, g);
  },
  revokeMcpGrant: ({ s, params }) => {
    const u = requireUser(s);
    ownGrant(mcpMockState(s), u, params.grantId ?? '').revokedAt = new Date().toISOString();
    return {};
  },
  listMcpTokens: ({ s }) => {
    const u = requireUser(s);
    return {
      items: mcpMockState(s)
        .tokens.filter((t) => t.userId === u.id && !t.revokedAt)
        .map((t) => toToken(s, t)),
    };
  },
  createMcpToken: ({ s, body }) => {
    const u = requireUser(s);
    const m = mcpMockState(s);
    if (!m.policy.patsEnabled) throw new MockApiError('mcp_tokens_disabled');
    if (
      body.expiresInDays === null
        ? m.policy.maxTokenDays !== null
        : m.policy.maxTokenDays !== null && body.expiresInDays > m.policy.maxTokenDays
    ) {
      throw new MockApiError('mcp_expiry_not_allowed');
    }
    const value = `mhp_${Array.from(
      crypto.getRandomValues(new Uint8Array(40)),
      (b) => 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'[b % 56],
    )
      .join('')
      .slice(0, 40)}`;
    const row = {
      id: newId(),
      userId: u.id,
      name: body.name,
      prefix: value.slice(0, 8),
      scopes: [...new Set<McpScope>(['hub:read', ...body.scopes])],
      spaceIds: body.spaceIds,
      allowedIps: body.allowedIps?.length ? body.allowedIps : null,
      expiresAt: body.expiresInDays === null ? null : ahead(body.expiresInDays * DAY),
      lastUsedAt: null,
      createdAt: new Date().toISOString(),
      revokedAt: null,
    };
    m.tokens.unshift(row);
    return { token: toToken(s, row), value };
  },
  revokeMcpToken: ({ s, params }) => {
    const u = requireUser(s);
    const t = mcpMockState(s).tokens.find((x) => x.id === params.tokenId && x.userId === u.id);
    if (!t) throw new MockApiError('not_found');
    t.revokedAt = new Date().toISOString();
    return {};
  },
  mcpReauth: ({ s, body }) => {
    requireUser(s);
    if (body.password.length < 4) throw new MockApiError('mcp_password_invalid');
    const m = mcpMockState(s);
    m.verifiedAt = Date.now();
    return { verifiedUntil: new Date(m.verifiedAt + 10 * MIN).toISOString() };
  },
  listMcpActivity: ({ s, query }) => {
    const u = requireUser(s);
    const since = Date.now() - query.hours * HOUR;
    const rows = mcpMockState(s)
      .calls.filter((c) => c.userId === u.id && Date.parse(c.at) >= since)
      .filter((c) =>
        query.filter === 'write'
          ? c.write
          : query.filter === 'pending'
            ? c.result === 'pending_approval'
            : query.filter === 'error'
              ? c.result === 'error'
              : query.filter === 'undone'
                ? c.undoneAt !== null
                : true,
      )
      .filter((c) => (query.grantId ? c.via.grantId === query.grantId : true))
      .filter((c) => (query.tokenId ? c.via.tokenId === query.tokenId : true))
      .filter((c) =>
        query.q
          ? `${c.tool} ${c.target?.label ?? ''}`.toLowerCase().includes(query.q.toLowerCase())
          : true,
      )
      .map((c) => omit(c, 'userId'));
    return { items: rows.slice(0, query.limit), nextCursor: null };
  },
  undoMcpToolCall: ({ s, params }) => {
    const u = requireUser(s);
    const c = mcpMockState(s).calls.find((x) => x.id === params.callNo && x.userId === u.id);
    if (!c) throw new MockApiError('not_found');
    if (!c.canUndo) throw new MockApiError('mcp_undo_unavailable');
    c.canUndo = false;
    c.undoneAt = new Date().toISOString();
    return omit(c, 'userId');
  },
  listMcpApprovals: ({ s, query }) => {
    const u = requireUser(s);
    const m = mcpMockState(s);
    const items = m.approvals
      .filter((a) => a.userId === u.id && (query.status === 'pending') === (a.status === 'pending'))
      .map((a) => omit(a, 'clientNote', 'items', 'payload', 'decidedBy', 'errorCode', 'userId'));
    return { items, nextCursor: null };
  },
  getMcpApproval: ({ s, params }) => {
    const u = requireUser(s);
    const m = mcpMockState(s);
    return detail(m, ownApproval(m, u, params.approvalId ?? ''));
  },
  approveMcpApproval: ({ s, params }) => {
    const u = requireUser(s);
    const m = mcpMockState(s);
    const a = ownApproval(m, u, params.approvalId ?? '');
    if (a.status !== 'pending') throw new MockApiError('mcp_approval_closed');
    if (!fresh(m)) throw new MockApiError('mcp_reauth_required');
    a.status = 'applied';
    a.decidedAt = new Date().toISOString();
    a.decidedBy = { id: u.id, name: u.name };
    const call = m.calls.find((c) => c.approvalId === a.id);
    if (call) {
      call.result = 'ok';
      call.approvalStatus = 'applied';
      call.canUndo = true;
    }
    return detail(m, a);
  },
  rejectMcpApproval: ({ s, params }) => {
    const u = requireUser(s);
    const m = mcpMockState(s);
    const a = ownApproval(m, u, params.approvalId ?? '');
    if (a.status !== 'pending') throw new MockApiError('mcp_approval_closed');
    a.status = 'rejected';
    a.errorCode = 'rejected';
    a.decidedAt = new Date().toISOString();
    a.decidedBy = { id: u.id, name: u.name };
    const call = m.calls.find((c) => c.approvalId === a.id);
    if (call) {
      call.result = 'error';
      call.errorCode = 'rejected';
    }
    return detail(m, a);
  },
  getMcpToolCatalog: ({ s }) => {
    const u = requireUser(s);
    const m = mcpMockState(s);
    const mine = new Set(
      [...m.grants, ...m.tokens]
        .filter((x) => x.userId === u.id && !x.revokedAt)
        .flatMap((x) => x.scopes),
    );
    return {
      tools: TOOLS.map(([name, scope, approval]) => ({
        name,
        title: name,
        description: name,
        scope,
        approval,
        readOnly: scope === 'hub:read',
        destructive: name === 'trash_nodes',
        idempotent: scope === 'hub:read',
        inputSchema: { type: 'object', properties: {} },
        example: null,
        available: mine.has(scope),
      })),
      resources: [
        { uriTemplate: 'crewhall://page/{id}', name: 'page', description: 'Page as Markdown' },
      ],
      limits: { requestsPerMinute: 60, writesPerMinute: 20, responseBytes: 262144 },
    };
  },
  getMcpConsent: ({ s, query }) => {
    const u = requireUser(s);
    const m = mcpMockState(s);
    const client = m.clients.find((c) => c.clientId === query.client_id);
    if (
      !client ||
      !client.redirectUris.some(
        (r) =>
          r.split(':').slice(0, 2).join(':') ===
          query.redirect_uri.split(':').slice(0, 2).join(':'),
      )
    ) {
      throw new MockApiError('mcp_consent_invalid');
    }
    const requested = (query.scope ?? '').split(' ').filter(Boolean);
    return {
      client: {
        name: client.name,
        registration: client.registration,
        status: client.status,
        redirectUri: query.redirect_uri,
        redirectHost: new URL(query.redirect_uri).host,
      },
      user: { name: u.name, email: u.email, orgName: s.org?.branding.orgName ?? '' },
      scopes: MCP_SCOPES.map((scope) => ({
        scope,
        requested: scope === 'hub:read' || requested.length === 0 || requested.includes(scope),
        allowed: scope === 'hub:read' || m.policy.allowedScopes.includes(scope),
        required: scope === 'hub:read',
        approval: scope === 'portal:publish',
      })),
      spaces: mySpaces(s, u),
      durations:
        m.policy.maxTokenDays === null ? ['7d', '30d', '90d', 'never'] : ['7d', '30d', '90d'],
      defaultDuration: '30d',
      needsReauth: !fresh(m),
      consentToken: `mock.${newId()}`,
    };
  },
  approveMcpConsent: ({ s, body }) => {
    const u = requireUser(s);
    const m = mcpMockState(s);
    if (!fresh(m)) throw new MockApiError('mcp_reauth_required');
    const client = m.clients.find((c) => c.clientId === body.client_id);
    if (!client) throw new MockApiError('mcp_consent_invalid');
    if (client.status === 'pending') throw new MockApiError('mcp_client_pending');
    const grant = {
      id: newId(),
      userId: u.id,
      clientRef: client.id,
      label: body.label ?? null,
      scopes: [...new Set<McpScope>(['hub:read', ...body.scopes])],
      spaceIds: body.spaceIds,
      expiresAt: body.duration === 'never' ? null : ahead(Number.parseInt(body.duration, 10) * DAY),
      lastUsedAt: null,
      lastIp: null,
      createdAt: new Date().toISOString(),
      revokedAt: null,
    };
    m.grants.unshift(grant);
    const back = new URL(body.redirect_uri);
    back.searchParams.set('code', `mhc_${newId()}`);
    if (body.state) back.searchParams.set('state', body.state);
    return { redirectTo: back.href, grantId: grant.id };
  },
  denyMcpConsent: ({ body }) => {
    const back = new URL(body.redirect_uri);
    back.searchParams.set('error', 'access_denied');
    if (body.state) back.searchParams.set('state', body.state);
    return { redirectTo: back.href, grantId: null };
  },
  getMcpPolicy: ({ s }) => {
    requireUser(s);
    return mcpMockState(s).policy;
  },
  updateMcpPolicy: ({ s, body }) => {
    requireUser(s);
    const m = mcpMockState(s);
    m.policy = {
      ...m.policy,
      ...body,
      allowedScopes: [
        ...new Set<McpScope>(['hub:read', ...(body.allowedScopes ?? m.policy.allowedScopes)]),
      ],
      approvalRules: [
        ...new Set([...LOCKED_APPROVAL_RULES, ...(body.approvalRules ?? m.policy.approvalRules)]),
      ],
      updatedAt: new Date().toISOString(),
    };
    return m.policy;
  },
  listMcpClients: ({ s }) => {
    requireUser(s);
    return { items: mcpMockState(s).clients };
  },
  updateMcpClient: ({ s, params, body }) => {
    requireUser(s);
    const c = mcpMockState(s).clients.find((x) => x.id === params.mcpClientId);
    if (!c) throw new MockApiError('not_found');
    c.status = body.status;
    return c;
  },
  listMcpOrgConnections: ({ s }) => {
    requireUser(s);
    const m = mcpMockState(s);
    const person = (id: string) => {
      const u = s.users.find((x) => x.id === id);
      return { id, name: u?.name ?? '?', imageUrl: u?.imageUrl ?? null };
    };
    const grants = m.grants
      .filter((g) => !g.revokedAt)
      .map((g) => ({
        id: g.id,
        kind: 'grant' as const,
        user: person(g.userId),
        name: m.clients.find((c) => c.id === g.clientRef)?.name ?? '?',
        scopes: g.scopes,
        spaces: refs(s, g.spaceIds),
        lastUsedAt: g.lastUsedAt,
        expiresAt: g.expiresAt,
        createdAt: g.createdAt,
      }));
    const tokens = m.tokens
      .filter((t) => !t.revokedAt)
      .map((t) => ({
        id: t.id,
        kind: 'token' as const,
        user: person(t.userId),
        name: t.name,
        scopes: t.scopes,
        spaces: refs(s, t.spaceIds),
        lastUsedAt: t.lastUsedAt,
        expiresAt: t.expiresAt,
        createdAt: t.createdAt,
      }));
    return { items: [...grants, ...tokens] };
  },
  revokeMcpOrgGrant: ({ s, params }) => {
    requireUser(s);
    const g = mcpMockState(s).grants.find((x) => x.id === params.grantId);
    if (!g) throw new MockApiError('not_found');
    g.revokedAt = new Date().toISOString();
    return {};
  },
  revokeMcpOrgToken: ({ s, params }) => {
    requireUser(s);
    const t = mcpMockState(s).tokens.find((x) => x.id === params.tokenId);
    if (!t) throw new MockApiError('not_found');
    t.revokedAt = new Date().toISOString();
    return {};
  },
  getMcpUsage: ({ s, query }) => {
    requireUser(s);
    const m = mcpMockState(s);
    const days = Array.from({ length: query.days }, (_, i) => {
      const d = new Date(Date.now() - (query.days - 1 - i) * DAY);
      const calls = (i * 7 + 3) % 23;
      return {
        date: d.toISOString().slice(0, 10),
        calls,
        writes: Math.floor(calls / 3),
        errors: i % 5 === 0 ? 1 : 0,
      };
    });
    const counts = new Map<string, number>();
    for (const c of m.calls) counts.set(c.tool, (counts.get(c.tool) ?? 0) + 1);
    return {
      days,
      tools: [...counts]
        .map(([tool, calls]) => ({ tool, calls }))
        .sort((a, b) => b.calls - a.calls),
      people: 1,
    };
  },
};
