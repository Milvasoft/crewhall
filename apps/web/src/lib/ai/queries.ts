import { queryOptions } from '@tanstack/react-query';
import { api } from '@/lib/api';

/** Query keys and fetchers of the AI module (yol haritası #5). */
export const aiKeys = {
  all: ['ai'] as const,
  status: ['ai', 'status'] as const,
  settings: ['ai', 'settings'] as const,
  index: ['ai', 'index'] as const,
  usage: (month: string | undefined) => ['ai', 'usage', month ?? 'current'] as const,
};

export const aiStatusQuery = queryOptions({
  queryKey: aiKeys.status,
  queryFn: ({ signal }) => api.call('getAiStatus', { signal }),
  staleTime: 60_000,
  retry: false,
});

export const aiSettingsQuery = queryOptions({
  queryKey: aiKeys.settings,
  queryFn: ({ signal }) => api.call('getAiSettings', { signal }),
});

export const aiUsageQuery = (month?: string) =>
  queryOptions({
    queryKey: aiKeys.usage(month),
    queryFn: ({ signal }) => api.call('getAiUsage', { query: month ? { month } : {}, signal }),
  });

export const aiIndexQuery = queryOptions({
  queryKey: aiKeys.index,
  queryFn: ({ signal }) => api.call('getAiIndexStatus', { signal }),
});
