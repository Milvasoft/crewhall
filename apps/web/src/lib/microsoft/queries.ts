import { queryOptions } from '@tanstack/react-query';
import { api } from '@/lib/api';

/** Query keys of the Microsoft integrations. */
export const microsoftKeys = {
  overview: ['microsoft', 'overview'] as const,
  mounts: ['microsoft', 'mounts'] as const,
  jobs: ['microsoft', 'imports'] as const,
  spaceMounts: (spaceId: string) => ['microsoft', 'space-mounts', spaceId] as const,
  listing: (mountId: string, path: string) => ['microsoft', 'mount', mountId, path] as const,
};

export const microsoftQuery = queryOptions({
  queryKey: microsoftKeys.overview,
  queryFn: ({ signal }) => api.call('getMicrosoftIntegrations', { signal }),
});
