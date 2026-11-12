import { createFileRoute, notFound, redirect } from '@tanstack/react-router';
import { MODULE_BY_SEGMENT } from '@/lib/modules';
import { spacesQuery } from '@/lib/queries';
import { readStorage, StorageKey } from '@/lib/storage';

/** `/drive` etc. open the last used space (or the first shared one). */
export const Route = createFileRoute('/_app/$module/')({
  beforeLoad: async ({ params, context: { queryClient } }) => {
    if (!MODULE_BY_SEGMENT[params.module]) throw notFound({ routeId: '/_app' });
    const { items } = await queryClient.ensureQueryData(spacesQuery());
    const last = readStorage(StorageKey.lastSpace);
    const target =
      items.find((s) => s.slug === last) ?? items.find((s) => s.kind === 'shared') ?? items[0];
    if (target) {
      throw redirect({
        to: '/$module/$spaceSlug',
        params: { module: params.module, spaceSlug: target.slug },
        replace: true,
      });
    }
  },
});
