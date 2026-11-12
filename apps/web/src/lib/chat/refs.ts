import {
  internalTargetOf,
  toCurrentPath,
  type MessageRef,
  type ResolvedRef,
} from '@crewhall/shared';
import { queryOptions } from '@tanstack/react-query';
import { api } from '@/lib/api';

/** Internal references: the per-viewer card of an item and the composer's picker. */

const keyOf = (refs: MessageRef[]) => refs.map((r) => `${r.kind}:${r.id}`).join(',');

export const refsQuery = (refs: MessageRef[]) =>
  queryOptions({
    queryKey: ['chat', 'refs', 'resolve', keyOf(refs)] as const,
    queryFn: ({ signal }) =>
      api.call('resolveChatRefs', {
        body: { refs: refs.map(({ kind, id }) => ({ kind, id })) },
        signal,
      }),
    staleTime: 60_000,
    retry: false,
  });

export const refSearchQuery = (q: string) =>
  queryOptions({
    queryKey: ['chat', 'refs', 'search', q] as const,
    queryFn: ({ signal }) => api.call('searchChatRefs', { query: { q }, signal }),
    staleTime: 30_000,
    retry: false,
  });

/**
 * The item behind a pasted address of this Crewhall, as the sender can see it; null when it is
 * not an in-app item or they cannot open it (the address then stays plain text).
 */
export async function refFromUrl(pasted: string): Promise<ResolvedRef | null> {
  let url: URL;
  try {
    url = new URL(pasted);
  } catch {
    return null;
  }
  if (url.host !== window.location.host) return null;
  const target = internalTargetOf(`${toCurrentPath(url.pathname)}${url.search}`);
  if (!target) return null;
  try {
    let ref: MessageRef;
    if (target.kind === 'card') {
      const card = await api.call('getBoardCardByNumber', {
        params: { boardId: target.boardId, number: target.ref },
      });
      ref = { kind: 'card', id: card.id };
    } else {
      ref = target;
    }
    const { items } = await api.call('resolveChatRefs', { body: { refs: [ref] } });
    return items[0]?.state === 'ok' ? items[0] : null;
  } catch {
    return null;
  }
}
