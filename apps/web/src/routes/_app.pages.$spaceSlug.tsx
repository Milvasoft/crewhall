import { createFileRoute, notFound } from '@tanstack/react-router';
import { SpaceHome } from '@/components/wiki/SpaceHome';
import { cachedSpaceId, warm } from '@/lib/prefetch';
import { spacesQuery } from '@/lib/queries';
import { pageTreeQuery } from '@/lib/wiki/api';

/** Pages of one space (design 05). Unknown or hidden spaces are 404 so they do not leak. */
export const Route = createFileRoute('/_app/pages/$spaceSlug')({
  beforeLoad: async ({ params, context: { queryClient } }) => {
    const { items } = await queryClient.ensureQueryData(spacesQuery());
    if (!items.some((s) => s.slug === params.spaceSlug)) throw notFound({ routeId: '/_app' });
  },
  loader: ({ params, context: { queryClient } }) => {
    const spaceId = cachedSpaceId(queryClient, params.spaceSlug);
    if (spaceId) warm(queryClient, pageTreeQuery(spaceId));
  },
  component: function WikiSpace() {
    const { spaceSlug } = Route.useParams();
    return <SpaceHome spaceSlug={spaceSlug} />;
  },
});
