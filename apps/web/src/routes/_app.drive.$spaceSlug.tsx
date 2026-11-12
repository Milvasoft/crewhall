import { createFileRoute, notFound, Outlet } from '@tanstack/react-router';
import { spacesQuery } from '@/lib/queries';

/** Drive of one space (design 03). Unknown or hidden spaces are 404 so they do not leak. */
export const Route = createFileRoute('/_app/drive/$spaceSlug')({
  beforeLoad: async ({ params, context: { queryClient } }) => {
    const { items } = await queryClient.ensureQueryData(spacesQuery());
    if (!items.some((s) => s.slug === params.spaceSlug)) throw notFound({ routeId: '/_app' });
  },
  component: Outlet,
});
