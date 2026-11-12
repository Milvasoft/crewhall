import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { HomeEditor } from '@/components/portal/HomeEditor';

/** 10.8 home page editor. */
export const Route = createFileRoute('/_app/portal/$siteSlug/home')({
  validateSearch: z.object({ lang: z.string().optional(), section: z.string().optional() }),
  component: HomeEditor,
});
