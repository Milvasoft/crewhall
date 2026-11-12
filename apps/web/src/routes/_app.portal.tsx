import { can } from '@crewhall/shared';
import { createFileRoute, notFound, Outlet } from '@tanstack/react-router';
import { meQuery } from '@/lib/queries';
import { actorFrom } from '@/lib/session';

const ORG = {
  type: 'org' as const,
  org: { settings: { membersCanCreateSpaces: false, publicLinksEnabled: true } },
};

/** Portal CMS (design 10). Only people with portal permissions see it; others get a 404. */
export const Route = createFileRoute('/_app/portal')({
  beforeLoad: async ({ context: { queryClient } }) => {
    const actor = actorFrom(await queryClient.ensureQueryData(meQuery));
    if (!can(actor, 'portal.edit', ORG) && !can(actor, 'portal.publish', ORG)) {
      throw notFound({ routeId: '/_app' });
    }
  },
  component: Outlet,
});
