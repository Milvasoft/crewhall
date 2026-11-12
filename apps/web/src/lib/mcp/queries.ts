import { type QueryOf } from '@crewhall/shared';
import { queryOptions } from '@tanstack/react-query';
import { api } from '@/lib/api';

/** Query keys and fetchers of the MCP screens (design 18). */
export const mcpKeys = {
  all: ['mcp'] as const,
  overview: ['mcp', 'overview'] as const,
  grants: ['mcp', 'grants'] as const,
  grant: (id: string) => ['mcp', 'grants', id] as const,
  tokens: ['mcp', 'tokens'] as const,
  activity: (q: object) => ['mcp', 'activity', q] as const,
  approvals: (status: 'pending' | 'history') => ['mcp', 'approvals', status] as const,
  approval: (id: string) => ['mcp', 'approval', id] as const,
  catalog: ['mcp', 'catalog'] as const,
  consent: (q: object) => ['mcp', 'consent', q] as const,
  policy: ['mcp', 'policy'] as const,
  clients: ['mcp', 'clients'] as const,
  orgConnections: ['mcp', 'org', 'connections'] as const,
  usage: (days: number) => ['mcp', 'org', 'usage', days] as const,
};

export const overviewQuery = queryOptions({
  queryKey: mcpKeys.overview,
  queryFn: ({ signal }) => api.call('getMcpOverview', { signal }),
  staleTime: 15_000,
});

export const grantsQuery = queryOptions({
  queryKey: mcpKeys.grants,
  queryFn: ({ signal }) => api.call('listMcpGrants', { signal }),
});

export const grantQuery = (grantId: string) =>
  queryOptions({
    queryKey: mcpKeys.grant(grantId),
    queryFn: ({ signal }) => api.call('getMcpGrant', { params: { grantId }, signal }),
    retry: false,
  });

export const tokensQuery = queryOptions({
  queryKey: mcpKeys.tokens,
  queryFn: ({ signal }) => api.call('listMcpTokens', { signal }),
});

export const approvalsQuery = (status: 'pending' | 'history') =>
  queryOptions({
    queryKey: mcpKeys.approvals(status),
    queryFn: ({ signal }) => api.call('listMcpApprovals', { query: { status }, signal }),
    staleTime: 10_000,
  });

export const approvalQuery = (approvalId: string) =>
  queryOptions({
    queryKey: mcpKeys.approval(approvalId),
    queryFn: ({ signal }) => api.call('getMcpApproval', { params: { approvalId }, signal }),
    retry: false,
  });

export const catalogQuery = queryOptions({
  queryKey: mcpKeys.catalog,
  queryFn: ({ signal }) => api.call('getMcpToolCatalog', { signal }),
  staleTime: 5 * 60_000,
});

export const consentQuery = (query: QueryOf<'getMcpConsent'>) =>
  queryOptions({
    queryKey: mcpKeys.consent(query),
    queryFn: ({ signal }) => api.call('getMcpConsent', { query, signal }),
    retry: false,
    staleTime: Infinity,
  });

export const policyQuery = queryOptions({
  queryKey: mcpKeys.policy,
  queryFn: ({ signal }) => api.call('getMcpPolicy', { signal }),
});

export const clientsQuery = queryOptions({
  queryKey: mcpKeys.clients,
  queryFn: ({ signal }) => api.call('listMcpClients', { signal }),
});

export const orgConnectionsQuery = queryOptions({
  queryKey: mcpKeys.orgConnections,
  queryFn: ({ signal }) => api.call('listMcpOrgConnections', { query: {}, signal }),
});

export const usageQuery = (days: number) =>
  queryOptions({
    queryKey: mcpKeys.usage(days),
    queryFn: ({ signal }) => api.call('getMcpUsage', { query: { days }, signal }),
  });
