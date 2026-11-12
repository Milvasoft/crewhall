import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { SearchPage } from '@/features/drive/pages/SearchPage';

export const Route = createFileRoute('/_app/drive/search')({
  validateSearch: z.object({
    q: z.string().optional(),
    space: z.string().optional(),
    type: z.enum(['folder', 'file', 'page', 'board', 'drawing']).optional(),
  }),
  component: function DriveSearch() {
    return <SearchPage search={Route.useSearch()} />;
  },
});
