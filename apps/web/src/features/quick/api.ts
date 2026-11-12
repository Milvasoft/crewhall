import { queryKeys } from '@crewhall/api-client';
import { type Card, type CardLayout, type Surface } from '@crewhall/shared';
import { queryOptions, type QueryClient } from '@tanstack/react-query';
import { type z } from 'zod';
import { api } from '@/lib/api';

/** Quick access queries (design 02). No real-time events yet: mutations patch the cache. */

export type Layout = z.infer<typeof CardLayout>;

export const surfacesQuery = queryOptions({
  queryKey: queryKeys.surfaces,
  queryFn: ({ signal }) => api.call('listSurfaces', { signal }),
  staleTime: 60_000,
});

export const surfaceQuery = (surfaceId: string) =>
  queryOptions({
    queryKey: queryKeys.surface(surfaceId),
    queryFn: ({ signal }) => api.call('getSurface', { params: { surfaceId }, signal }),
    staleTime: 30_000,
    // Link health changes on the server every minute; no real-time events until phase 3.
    refetchInterval: 60_000,
  });

export const linkHistoryQuery = (linkId: string) =>
  queryOptions({
    queryKey: queryKeys.linkHistory(linkId),
    queryFn: ({ signal }) =>
      api.call('getLinkHistory', { params: { linkId }, query: { hours: 24 }, signal }),
    staleTime: 60_000,
  });

/** Replace or add a card in the cached surface. */
export function putCard(qc: QueryClient, card: Card): void {
  qc.setQueryData<Surface>(queryKeys.surface(card.surfaceId), (sf) => {
    if (!sf) return sf;
    const exists = sf.cards.some((c) => c.id === card.id);
    return {
      ...sf,
      cards: exists ? sf.cards.map((c) => (c.id === card.id ? card : c)) : [...sf.cards, card],
    };
  });
  void qc.invalidateQueries({ queryKey: queryKeys.surfaces, exact: true });
}

export function dropCard(qc: QueryClient, surfaceId: string, cardId: string): void {
  qc.setQueryData<Surface>(queryKeys.surface(surfaceId), (sf) =>
    sf ? { ...sf, cards: sf.cards.filter((c) => c.id !== cardId) } : sf,
  );
  void qc.invalidateQueries({ queryKey: queryKeys.surfaces, exact: true });
}

/** Cards that show this card's content elsewhere (pinned copies) need a refetch. */
export function refreshOtherSurfaces(qc: QueryClient, surfaceId: string): void {
  void qc.invalidateQueries({
    predicate: (q) =>
      q.queryKey[0] === 'surfaces' && q.queryKey.length === 2 && q.queryKey[1] !== surfaceId,
  });
}

export function setLayouts(
  qc: QueryClient,
  surfaceId: string,
  layouts: Record<string, Layout>,
  layoutRev?: number,
): void {
  qc.setQueryData<Surface>(queryKeys.surface(surfaceId), (sf) =>
    sf
      ? {
          ...sf,
          layoutRev: layoutRev ?? sf.layoutRev,
          cards: sf.cards.map((c) => (layouts[c.id] ? { ...c, layout: layouts[c.id]! } : c)),
        }
      : sf,
  );
}
