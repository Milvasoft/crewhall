import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { SeoScreen } from '@/components/portal/Seo';

/** 10.10 SEO: page settings, site defaults, sitemap and robots, redirects. */
export const Route = createFileRoute('/_app/portal/$siteSlug/seo')({
  validateSearch: z.object({
    tab: z.enum(['page', 'defaults', 'sitemap', 'redirects']).optional(),
    page: z.string().optional(),
  }),
  component: SeoScreen,
});
