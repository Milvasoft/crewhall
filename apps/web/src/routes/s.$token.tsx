import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { PublicSharePage } from '@/features/drive/public/PublicSharePage';

/** Public link pages (19.1-19.5): no app shell and no session. */
export const Route = createFileRoute('/s/$token')({
  validateSearch: z.object({ file: z.string().optional(), folder: z.string().optional() }),
  component: function PublicShareRoute() {
    const { token } = Route.useParams();
    return <PublicSharePage token={token} search={Route.useSearch()} />;
  },
});
