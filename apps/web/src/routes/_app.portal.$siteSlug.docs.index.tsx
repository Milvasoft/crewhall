import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { DocsScreen } from '@/components/portal/docs/DocsScreen';

/** 10.2 doc tree and editor, 10.3 translation view (`translate`). */
export const Route = createFileRoute('/_app/portal/$siteSlug/docs/')({
  validateSearch: z.object({
    /** Version name. */
    v: z.string().optional(),
    /** Site language. */
    l: z.string().optional(),
    /** Translation group of the open doc or category (stable across languages). */
    g: z.string().optional(),
    /** Doc id to open (links from the overview, import report, publish history). */
    doc: z.string().optional(),
    translate: z.boolean().optional(),
  }),
  component: DocsScreen,
});
