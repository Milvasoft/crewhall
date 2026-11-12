import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { MountPage } from '@/components/microsoft/MountBrowser';
import { spacesQuery } from '@/lib/queries';
import { useQuery } from '@tanstack/react-query';

/** An external storage mount of the space (SharePoint, OneDrive, SMB), browsed live. */
export const Route = createFileRoute('/_app/drive/$spaceSlug/mount/$mountId')({
  validateSearch: z.object({ path: z.string().optional() }),
  component: function MountRoute() {
    const { spaceSlug, mountId } = Route.useParams();
    const { path } = Route.useSearch();
    const spaces = useQuery(spacesQuery());
    const space = spaces.data?.items.find((s) => s.slug === spaceSlug);
    if (!space) return null;
    return (
      <MountPage spaceSlug={spaceSlug} spaceId={space.id} mountId={mountId} path={path ?? ''} />
    );
  },
});
