import { queryKeys } from '@crewhall/api-client';
import { type QueryOf } from '@crewhall/shared';
import { queryOptions } from '@tanstack/react-query';
import { api } from '@/lib/api';

/** Query option factories: one place for keys, fetchers and stale times. */

export const bootstrapQuery = queryOptions({
  queryKey: queryKeys.bootstrap,
  queryFn: ({ signal }) => api.call('bootstrap', { signal }),
  staleTime: 5 * 60_000,
});

/** What the server says of itself: its version, and the store links of the apps. */
export const compatQuery = queryOptions({
  queryKey: ['compat'],
  queryFn: ({ signal }) => api.call('getCompat', { signal }),
  staleTime: 60_000,
  retry: false,
});

export const meQuery = queryOptions({
  queryKey: queryKeys.me,
  queryFn: ({ signal }) => api.call('me', { signal }),
  staleTime: 60_000,
  retry: false,
});

export const spacesQuery = (archived = false) =>
  queryOptions({
    queryKey: queryKeys.spaces({ archived }),
    queryFn: ({ signal }) =>
      api.call('listSpaces', { query: { archived: archived ? 'true' : 'false' }, signal }),
    staleTime: 30_000,
  });

/** Admin view of every shared space, member or not (doc 09 · 9.9). */
export const orgSpacesQuery = (archived = false) =>
  queryOptions({
    queryKey: ['org', 'spaces', { archived }] as const,
    queryFn: ({ signal }) =>
      api.call('listOrgSpaces', { query: { archived: archived ? 'true' : 'false' }, signal }),
    staleTime: 30_000,
  });

export const spaceQuery = (spaceId: string) =>
  queryOptions({
    queryKey: queryKeys.space(spaceId),
    queryFn: ({ signal }) => api.call('getSpace', { params: { spaceId }, signal }),
  });

export const spaceMembersQuery = (spaceId: string) =>
  queryOptions({
    queryKey: queryKeys.spaceMembers(spaceId),
    queryFn: ({ signal }) => api.call('listSpaceMembers', { params: { spaceId }, signal }),
  });

export const orgQuery = queryOptions({
  queryKey: queryKeys.org,
  queryFn: ({ signal }) => api.call('getOrg', { signal }),
  staleTime: 60_000,
});

export const themeQuery = queryOptions({
  queryKey: queryKeys.theme,
  queryFn: ({ signal }) => api.call('getTheme', { signal }),
});

export const membersQuery = (filters: Omit<QueryOf<'listMembers'>, 'cursor'> = {}) =>
  queryOptions({
    queryKey: queryKeys.members(filters),
    queryFn: ({ signal }) => api.call('listMembers', { query: { limit: 100, ...filters }, signal }),
    staleTime: 30_000,
  });

export const invitationsQuery = queryOptions({
  queryKey: queryKeys.invitations,
  queryFn: ({ signal }) => api.call('listInvitations', { signal }),
});

export const sessionsQuery = queryOptions({
  queryKey: queryKeys.sessions,
  queryFn: ({ signal }) => api.call('listSessions', { signal }),
});
