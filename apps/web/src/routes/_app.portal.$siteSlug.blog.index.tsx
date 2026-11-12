import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { BlogList } from '@/components/portal/blog/BlogList';

/** 10.6 blog posts. */
export const Route = createFileRoute('/_app/portal/$siteSlug/blog/')({
  validateSearch: z.object({
    status: z.enum(['all', 'published', 'scheduled', 'draft']).optional(),
  }),
  component: BlogList,
});
