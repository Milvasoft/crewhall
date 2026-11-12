import { createFileRoute, redirect } from '@tanstack/react-router';
import { NoSite } from '@/components/portal/CreateSite';
import { sitesQuery } from '@/lib/portal/api';
import { readLastSite } from '@/lib/portal/context';

/** /portal opens the last used site, else the first; with no site, managers create one. */
export const Route = createFileRoute('/_app/portal/')({
  beforeLoad: async ({ context: { queryClient } }) => {
    const { items } = await queryClient.ensureQueryData(sitesQuery);
    const last = readLastSite();
    const site = items.find((s) => s.slug === last) ?? items[0];
    if (site) throw redirect({ to: '/portal/$siteSlug', params: { siteSlug: site.slug } });
  },
  component: NoSite,
});
