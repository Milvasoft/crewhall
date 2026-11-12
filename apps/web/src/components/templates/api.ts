import { queryOptions } from '@tanstack/react-query';
import { api } from '@/lib/api';

export const templateKeys = {
  all: ['templates'] as const,
  list: (spaceId: string | undefined) => ['templates', spaceId ?? null] as const,
};

/** Every template the caller can use (built-in, org, reachable spaces, own). */
export const templatesQuery = (spaceId?: string) =>
  queryOptions({
    queryKey: templateKeys.list(spaceId),
    queryFn: ({ signal }) => api.call('listTemplates', { query: {}, signal }),
    staleTime: 60_000,
  });
