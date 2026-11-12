import { createFileRoute, redirect } from '@tanstack/react-router';
import { GuestPage } from '@/components/meet/GuestPage';
import { meQuery } from '@/lib/queries';

/**
 * The room link everybody gets (design 7.12-7.14). Signed-in people go to the room in the
 * app; everyone else sees the guest page with the org's brand and no shell.
 */
export const Route = createFileRoute('/m/$slug')({
  beforeLoad: async ({ params, context: { queryClient } }) => {
    const me = await queryClient.ensureQueryData(meQuery).catch(() => null);
    if (me) {
      throw redirect({
        to: '/meetings/room/$slug',
        params: { slug: params.slug },
        replace: true,
      });
    }
  },
  component: function GuestRoute() {
    const { slug } = Route.useParams();
    return <GuestPage slug={slug} />;
  },
});
