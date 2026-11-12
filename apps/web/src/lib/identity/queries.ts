import { type OidcAuthorizeRequest } from '@crewhall/shared';
import { queryOptions } from '@tanstack/react-query';
import { api } from '@/lib/api';

/** Query keys and option factories of the identity module. */
export const identityKeys = {
  all: ['identity'] as const,
  providers: ['identity', 'providers'] as const,
  provider: (id: string) => ['identity', 'providers', id] as const,
  linked: (id: string) => ['identity', 'providers', id, 'users'] as const,
  security: ['identity', 'security'] as const,
  backups: ['identity', 'backups'] as const,
  compliance: ['identity', 'compliance'] as const,
  oidc: ['identity', 'oidc'] as const,
  consent: (q: OidcAuthorizeRequest) => ['identity', 'consent', q] as const,
};

export const identityProvidersQuery = queryOptions({
  queryKey: identityKeys.providers,
  queryFn: ({ signal }) => api.call('listIdentityProviders', { signal }),
  staleTime: 30_000,
});

export const identityProviderQuery = (providerId: string) =>
  queryOptions({
    queryKey: identityKeys.provider(providerId),
    queryFn: ({ signal }) => api.call('getIdentityProvider', { params: { providerId }, signal }),
  });

export const linkedIdentitiesQuery = (providerId: string) =>
  queryOptions({
    queryKey: identityKeys.linked(providerId),
    queryFn: ({ signal }) =>
      api.call('listLinkedIdentities', { params: { providerId }, query: { limit: 200 }, signal }),
  });

/** Polls while an eDiscovery export is being built. */
export const complianceQuery = queryOptions({
  queryKey: identityKeys.compliance,
  queryFn: ({ signal }) => api.call('getCompliance', { signal }),
  refetchInterval: (q) =>
    q.state.data?.exports.some((e) => e.status === 'queued' || e.status === 'running')
      ? 3000
      : false,
});

/** Polls while a backup is queued or running. */
export const backupsQuery = queryOptions({
  queryKey: identityKeys.backups,
  queryFn: ({ signal }) => api.call('getBackups', { signal }),
  refetchInterval: (q) =>
    q.state.data?.runs.some((r) => r.status === 'queued' || r.status === 'running') ? 3000 : false,
});

export const securityPolicyQuery = queryOptions({
  queryKey: identityKeys.security,
  queryFn: ({ signal }) => api.call('getSecurityPolicy', { signal }),
});

export const oidcProviderQuery = queryOptions({
  queryKey: identityKeys.oidc,
  queryFn: ({ signal }) => api.call('getOidcProvider', { signal }),
  staleTime: 30_000,
});

export const oidcConsentQuery = (request: OidcAuthorizeRequest) =>
  queryOptions({
    queryKey: identityKeys.consent(request),
    queryFn: ({ signal }) => api.call('getOidcConsent', { query: request, signal }),
    staleTime: 0,
    retry: false,
  });
