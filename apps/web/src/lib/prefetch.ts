import { type FetchQueryOptions, type QueryClient, type QueryKey } from '@tanstack/react-query';
import { spacesQuery } from '@/lib/queries';

/**
 * Route loaders call these to warm a screen's main query. The router runs loaders on link
 * hover (`defaultPreload: 'intent'`) and on navigation, so the data is usually in the cache
 * before the screen mounts and it draws at once. Never awaited: a slow request must not hold
 * the navigation; the screen shows its own (delayed) skeleton then.
 */

/** Hovering back and forth must not refetch: data younger than this counts as fresh. */
const WARM_MS = 15_000;

export function warm<T, K extends QueryKey>(
  qc: QueryClient,
  q: FetchQueryOptions<T, Error, T, K>,
): void {
  const staleTime = typeof q.staleTime === 'number' ? Math.max(q.staleTime, WARM_MS) : WARM_MS;
  void qc.prefetchQuery({ ...q, staleTime });
}

/** Space id by slug from the spaces list the shell loaded first. */
export function cachedSpaceId(qc: QueryClient, slug: string): string | undefined {
  return qc.getQueryData(spacesQuery().queryKey)?.items.find((s) => s.slug === slug)?.id;
}
