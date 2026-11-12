import { createFileRoute } from '@tanstack/react-router';
import { SiteSettings } from '@/components/portal/SiteSettings';

/** 10.17 site settings (site managers). */
export const Route = createFileRoute('/_app/portal/$siteSlug/settings')({
  component: SiteSettings,
});
