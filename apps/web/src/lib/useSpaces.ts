import { type Space } from '@crewhall/shared';
import { useQuery } from '@tanstack/react-query';
import { readStorage, StorageKey, writeStorage } from '@/lib/storage';
import { spacesQuery } from '@/lib/queries';

/** Active spaces plus a lookup by slug; remembers the last space across modules (19.19). */
export function useSpaces() {
  const q = useQuery(spacesQuery());
  const items = q.data?.items ?? [];
  return {
    ...q,
    items,
    bySlug: (slug: string | undefined): Space | undefined => items.find((s) => s.slug === slug),
    preferred: (): Space | undefined => {
      const last = readStorage(StorageKey.lastSpace);
      return (
        items.find((s) => s.slug === last) ?? items.find((s) => s.kind === 'shared') ?? items[0]
      );
    },
  };
}

export function rememberSpace(slug: string): void {
  writeStorage(StorageKey.lastSpace, slug);
}
