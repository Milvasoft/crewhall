import { type PageTreeItem } from '@crewhall/shared';
import { queryOptions, type QueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

/** Wiki queries (design 05). Body edits go over collab; everything else refetches. */

export const wikiKeys = {
  all: ['wiki'] as const,
  tree: (spaceId: string) => ['wiki', 'tree', spaceId] as const,
  page: (nodeId: string) => ['wiki', 'page', nodeId] as const,
  versions: (nodeId: string) => ['wiki', 'versions', nodeId] as const,
  version: (nodeId: string, versionId: string) => ['wiki', 'version', nodeId, versionId] as const,
  comments: (nodeId: string) => ['wiki', 'comments', nodeId] as const,
  backlinks: (nodeId: string) => ['wiki', 'backlinks', nodeId] as const,
  templates: (spaceId: string | undefined) => ['wiki', 'templates', spaceId ?? null] as const,
  search: (q: Record<string, unknown>) => ['wiki', 'search', q] as const,
};

export const pageTreeQuery = (spaceId: string) =>
  queryOptions({
    queryKey: wikiKeys.tree(spaceId),
    queryFn: ({ signal }) => api.call('listPageTree', { params: { spaceId }, signal }),
    staleTime: 15_000,
  });

export const pageQuery = (nodeId: string) =>
  queryOptions({
    queryKey: wikiKeys.page(nodeId),
    queryFn: ({ signal }) => api.call('getPage', { params: { nodeId }, signal }),
    staleTime: 10_000,
  });

export const pageVersionsQuery = (nodeId: string) =>
  queryOptions({
    queryKey: wikiKeys.versions(nodeId),
    queryFn: ({ signal }) => api.call('listPageVersions', { params: { nodeId }, signal }),
  });

export const pageVersionQuery = (nodeId: string, versionId: string) =>
  queryOptions({
    queryKey: wikiKeys.version(nodeId, versionId),
    queryFn: ({ signal }) => api.call('getPageVersion', { params: { nodeId, versionId }, signal }),
    staleTime: Infinity,
  });

export const pageCommentsQuery = (nodeId: string) =>
  queryOptions({
    queryKey: wikiKeys.comments(nodeId),
    queryFn: ({ signal }) =>
      api.call('listPageComments', { params: { nodeId }, query: { status: 'all' }, signal }),
    staleTime: 10_000,
  });

export const backlinksQuery = (nodeId: string) =>
  queryOptions({
    queryKey: wikiKeys.backlinks(nodeId),
    queryFn: ({ signal }) => api.call('listPageBacklinks', { params: { nodeId }, signal }),
    staleTime: 30_000,
  });

/** Children by parent (null = top), in their manual order. */
export function treeChildren(items: PageTreeItem[]) {
  const map = new Map<string | null, PageTreeItem[]>();
  for (const item of items) {
    const list = map.get(item.parentId) ?? [];
    list.push(item);
    map.set(item.parentId, list);
  }
  for (const list of map.values()) {
    list.sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0));
  }
  return map;
}

/** Ancestors of a page in the tree, top first. */
export function treeAncestors(items: PageTreeItem[], id: string): string[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const out: string[] = [];
  let cur = byId.get(id)?.parentId ?? null;
  while (cur && !out.includes(cur)) {
    out.unshift(cur);
    cur = byId.get(cur)?.parentId ?? null;
  }
  return out;
}

export function invalidatePage(qc: QueryClient, nodeId: string, spaceId?: string) {
  void qc.invalidateQueries({ queryKey: wikiKeys.page(nodeId) });
  if (spaceId) void qc.invalidateQueries({ queryKey: wikiKeys.tree(spaceId) });
}
