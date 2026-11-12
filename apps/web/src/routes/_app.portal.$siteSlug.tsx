import { createFileRoute, notFound } from '@tanstack/react-router';
import { PortalSiteLayout } from '@/components/portal/PortalSiteLayout';
import { siteQuery, sitesQuery } from '@/lib/portal/api';

/**
 * One portal site; unknown slugs are 404. A slug missing from the cached list is fetched once
 * more first: right after "Siteyi oluştur" (or another manager's new site) the cache is stale.
 */
export const Route = createFileRoute('/_app/portal/$siteSlug')({
  beforeLoad: async ({ params, context: { queryClient } }) => {
    const find = (items: { id: string; slug: string }[]) =>
      items.find((s) => s.slug === params.siteSlug);
    const site =
      find((await queryClient.ensureQueryData(sitesQuery)).items) ??
      find((await queryClient.fetchQuery({ ...sitesQuery, staleTime: 0 })).items);
    if (!site) throw notFound({ routeId: '/_app' });
    await queryClient.ensureQueryData(siteQuery(site.id));
  },
  component: PortalSiteLayout,
});
