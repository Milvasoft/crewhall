import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { SearchView } from '@/components/wiki/SearchView';

/** Full-text page search (design 5.18): `/pages/search?q=…`. */
export const Route = createFileRoute('/_app/pages/search')({
  validateSearch: z.object({
    q: z.string().optional(),
    space: z.string().optional(),
    comments: z.boolean().optional(),
    days: z.number().int().optional(),
  }),
  component: function WikiSearch() {
    return <SearchView search={Route.useSearch()} />;
  },
});
