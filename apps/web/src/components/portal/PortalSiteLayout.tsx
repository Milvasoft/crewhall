import { useQuery } from '@tanstack/react-query';
import { Outlet, useParams } from '@tanstack/react-router';
import { useEffect, useMemo } from 'react';
import { PendingPage } from '@/components/common/PendingPage';
import { siteQuery, sitesQuery } from '@/lib/portal/api';
import { PortalSiteContext, writeLastSite } from '@/lib/portal/context';

/** Provides the open site to every portal screen and remembers it for the rail. */
export function PortalSiteLayout() {
  const { siteSlug } = useParams({ from: '/_app/portal/$siteSlug' });
  const sites = useQuery(sitesQuery);
  const summary = sites.data?.items.find((s) => s.slug === siteSlug);
  const site = useQuery({ ...siteQuery(summary?.id ?? ''), enabled: Boolean(summary) });

  useEffect(() => {
    writeLastSite(siteSlug);
  }, [siteSlug]);

  const value = useMemo(
    () => (site.data && sites.data ? { site: site.data, sites: sites.data.items } : null),
    [site.data, sites.data],
  );
  if (!value) return <PendingPage />;
  return (
    <PortalSiteContext.Provider value={value}>
      <Outlet />
    </PortalSiteContext.Provider>
  );
}
