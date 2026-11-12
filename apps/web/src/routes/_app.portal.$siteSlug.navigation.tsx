import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { NavigationEditor } from '@/components/portal/NavigationEditor';

/** 10.9 navbar and footer. */
export const Route = createFileRoute('/_app/portal/$siteSlug/navigation')({
  validateSearch: z.object({ lang: z.string().optional() }),
  component: NavigationEditor,
});
