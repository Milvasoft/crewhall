import { queryKeys } from '@crewhall/api-client';
import { type DriveNode, type NodeType } from '@crewhall/shared';
import { queryOptions, type QueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

/** Drive queries (design 03). No real-time events until phase 3: writes invalidate. */

export type NodeSort = 'name' | 'updatedAt' | 'size' | 'type';

/** Every child of a folder; follows the cursor (folders rarely exceed a few pages). */
export const nodesQuery = (
  spaceId: string,
  parentId: string | null,
  opts: { sort?: NodeSort; order?: 'asc' | 'desc'; type?: NodeType } = {},
) =>
  queryOptions({
    queryKey: queryKeys.nodes(spaceId, { parentId, ...opts }),
    queryFn: async ({ signal }) => {
      const items: DriveNode[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 20; i++) {
        const page = await api.call('listNodes', {
          params: { spaceId },
          query: {
            parentId: parentId ?? undefined,
            sort: opts.sort ?? 'name',
            order: opts.order ?? 'asc',
            type: opts.type,
            cursor,
            limit: 100,
          },
          signal,
        });
        items.push(...page.items);
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      return items;
    },
    staleTime: 15_000,
  });

export const nodeQuery = (nodeId: string) =>
  queryOptions({
    queryKey: queryKeys.node(nodeId),
    queryFn: ({ signal }) => api.call('getNode', { params: { nodeId }, signal }),
    staleTime: 15_000,
  });

export const versionsQuery = (nodeId: string) =>
  queryOptions({
    queryKey: queryKeys.versions(nodeId),
    queryFn: ({ signal }) => api.call('listVersions', { params: { nodeId }, signal }),
  });

export const sharesQuery = (nodeId: string) =>
  queryOptions({
    queryKey: queryKeys.shares(nodeId),
    queryFn: ({ signal }) => api.call('listShares', { params: { nodeId }, signal }),
  });

export const trashQuery = (spaceId: string) =>
  queryOptions({
    queryKey: queryKeys.trash(spaceId),
    queryFn: ({ signal }) =>
      api.call('listTrash', { params: { spaceId }, query: { limit: 100 }, signal }),
  });

export const favoritesQuery = queryOptions({
  queryKey: queryKeys.favorites,
  queryFn: ({ signal }) => api.call('listFavorites', { signal }),
  staleTime: 30_000,
});

export const recentQuery = queryOptions({
  queryKey: queryKeys.recent,
  queryFn: ({ signal }) => api.call('listRecent', { query: { limit: 50 }, signal }),
  staleTime: 30_000,
});

export const searchQuery = (filters: {
  q: string;
  spaceId?: string;
  type?: NodeType;
  limit?: number;
}) =>
  queryOptions({
    queryKey: queryKeys.searchNodes(filters),
    queryFn: ({ signal }) => api.call('searchNodes', { query: { limit: 20, ...filters }, signal }),
    enabled: filters.q.trim().length > 0,
    staleTime: 15_000,
  });

export const quotaQuery = queryOptions({
  queryKey: queryKeys.quota,
  queryFn: ({ signal }) => api.call('getQuota', { signal }),
  staleTime: 60_000,
});

/** After any write to the tree: lists, details, favorites, recent, search, quota, node cards. */
export function invalidateDrive(qc: QueryClient): void {
  for (const key of [
    ['nodes'],
    ['node'],
    ['search'],
    queryKeys.favorites,
    queryKeys.recent,
    queryKeys.quota,
    ['surfaces'],
  ]) {
    void qc.invalidateQueries({ queryKey: key });
  }
}
