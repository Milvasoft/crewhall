import { type PortalPostListQuery, type PortalMediaQuery } from '@crewhall/shared';
import { infiniteQueryOptions, queryOptions, type QueryClient } from '@tanstack/react-query';
import { type z } from 'zod';
import { api } from '@/lib/api';

/** Portal CMS queries (design 10). Keys live under ['portal', …] so one call refreshes them. */

export const portalKeys = {
  all: ['portal'] as const,
  sites: ['portal', 'sites'] as const,
  site: (siteId: string) => ['portal', 'site', siteId] as const,
  overview: (siteId: string) => ['portal', 'overview', siteId] as const,
  versions: (siteId: string) => ['portal', 'versions', siteId] as const,
  diff: (siteId: string, from: string, to: string) => ['portal', 'diff', siteId, from, to] as const,
  tree: (siteId: string, version: string, locale: string) =>
    ['portal', 'tree', siteId, version, locale] as const,
  doc: (docId: string) => ['portal', 'doc', docId] as const,
  posts: (siteId: string, filters: object) => ['portal', 'posts', siteId, filters] as const,
  post: (postId: string) => ['portal', 'post', postId] as const,
  authors: (siteId: string) => ['portal', 'authors', siteId] as const,
  home: (siteId: string) => ['portal', 'home', siteId] as const,
  navigation: (siteId: string) => ['portal', 'navigation', siteId] as const,
  media: (siteId: string, filter: string) => ['portal', 'media', siteId, filter] as const,
  redirects: (siteId: string) => ['portal', 'redirects', siteId] as const,
  changes: (siteId: string) => ['portal', 'changes', siteId] as const,
  publishes: (siteId: string) => ['portal', 'publishes', siteId] as const,
  publish: (publishId: string) => ['portal', 'publish', publishId] as const,
  imports: (siteId: string) => ['portal', 'imports', siteId] as const,
};

export const sitesQuery = queryOptions({
  queryKey: portalKeys.sites,
  queryFn: ({ signal }) => api.call('listPortalSites', { signal }),
  staleTime: 30_000,
});

export const siteQuery = (siteId: string) =>
  queryOptions({
    queryKey: portalKeys.site(siteId),
    queryFn: ({ signal }) => api.call('getPortalSite', { params: { siteId }, signal }),
    staleTime: 30_000,
  });

export const overviewQuery = (siteId: string) =>
  queryOptions({
    queryKey: portalKeys.overview(siteId),
    queryFn: ({ signal }) => api.call('getPortalOverview', { params: { siteId }, signal }),
  });

export const versionsQuery = (siteId: string) =>
  queryOptions({
    queryKey: portalKeys.versions(siteId),
    queryFn: ({ signal }) => api.call('listPortalVersions', { params: { siteId }, signal }),
    staleTime: 30_000,
  });

export const diffQuery = (siteId: string, from: string, to: string) =>
  queryOptions({
    queryKey: portalKeys.diff(siteId, from, to),
    queryFn: ({ signal }) =>
      api.call('diffPortalVersions', { params: { siteId }, query: { from, to }, signal }),
  });

export const treeQuery = (siteId: string, version: string, locale: string) =>
  queryOptions({
    queryKey: portalKeys.tree(siteId, version, locale),
    queryFn: ({ signal }) =>
      api.call('getPortalDocTree', { params: { siteId }, query: { version, locale }, signal }),
    enabled: Boolean(version && locale),
  });

export const docQuery = (docId: string) =>
  queryOptions({
    queryKey: portalKeys.doc(docId),
    queryFn: ({ signal }) => api.call('getPortalDoc', { params: { docId }, signal }),
    enabled: Boolean(docId),
    // The editor owns the draft while open; refetch only on demand (conflict reload).
    staleTime: Infinity,
  });

type PostFilters = Partial<z.input<typeof PortalPostListQuery>>;

export const postsQuery = (siteId: string, filters: PostFilters = {}) =>
  queryOptions({
    queryKey: portalKeys.posts(siteId, filters),
    queryFn: ({ signal }) =>
      api.call('listPortalPosts', {
        params: { siteId },
        query: { status: filters.status ?? 'all', locale: filters.locale },
        signal,
      }),
  });

export const postQuery = (postId: string) =>
  queryOptions({
    queryKey: portalKeys.post(postId),
    queryFn: ({ signal }) => api.call('getPortalPost', { params: { postId }, signal }),
    staleTime: Infinity,
  });

export const authorsQuery = (siteId: string) =>
  queryOptions({
    queryKey: portalKeys.authors(siteId),
    queryFn: ({ signal }) => api.call('listPortalAuthors', { params: { siteId }, signal }),
    staleTime: 60_000,
  });

export const homeQuery = (siteId: string) =>
  queryOptions({
    queryKey: portalKeys.home(siteId),
    queryFn: ({ signal }) => api.call('getPortalHome', { params: { siteId }, signal }),
    staleTime: Infinity,
  });

export const navigationQuery = (siteId: string) =>
  queryOptions({
    queryKey: portalKeys.navigation(siteId),
    queryFn: ({ signal }) => api.call('getPortalNavigation', { params: { siteId }, signal }),
    staleTime: Infinity,
  });

export type MediaFilter = z.output<typeof PortalMediaQuery>['filter'];

export const mediaQuery = (siteId: string, filter: MediaFilter = 'all') =>
  queryOptions({
    queryKey: portalKeys.media(siteId, filter),
    queryFn: ({ signal }) =>
      api.call('listPortalMedia', { params: { siteId }, query: { filter }, signal }),
    staleTime: 15_000,
  });

export const redirectsQuery = (siteId: string) =>
  queryOptions({
    queryKey: portalKeys.redirects(siteId),
    queryFn: ({ signal }) => api.call('listPortalRedirects', { params: { siteId }, signal }),
  });

export const changesQuery = (siteId: string) =>
  queryOptions({
    queryKey: portalKeys.changes(siteId),
    queryFn: ({ signal }) => api.call('listPortalChanges', { params: { siteId }, signal }),
    staleTime: 10_000,
  });

export const publishesQuery = (siteId: string) =>
  infiniteQueryOptions({
    queryKey: portalKeys.publishes(siteId),
    queryFn: ({ signal, pageParam }) =>
      api.call('listPortalPublishes', {
        params: { siteId },
        query: { limit: 25, cursor: pageParam ?? undefined },
        signal,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });

export const publishQuery = (publishId: string) =>
  queryOptions({
    queryKey: portalKeys.publish(publishId),
    queryFn: ({ signal }) => api.call('getPortalPublish', { params: { publishId }, signal }),
    enabled: Boolean(publishId),
  });

export const importsQuery = (siteId: string) =>
  queryOptions({
    queryKey: portalKeys.imports(siteId),
    queryFn: ({ signal }) => api.call('listPortalImports', { params: { siteId }, signal }),
  });

/** After a write: everything portal except open editors (doc, post, home, navigation). */
export function invalidatePortal(qc: QueryClient, opts: { editors?: boolean } = {}): void {
  void qc.invalidateQueries({
    queryKey: portalKeys.all,
    predicate: (q) =>
      opts.editors || !['doc', 'post', 'home', 'navigation'].includes(String(q.queryKey[1] ?? '')),
  });
}
