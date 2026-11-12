import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { pageIdFromRef } from '@crewhall/shared';
import { PageView } from '@/components/wiki/PageView';
import { pageQuery } from '@/lib/wiki/api';
import { warm } from '@/lib/prefetch';

/** A wiki page: `/p/{slug}-{id}` (design 05 "Kalıcı linkler"). */
export const Route = createFileRoute('/_app/p/$pageRef')({
  validateSearch: z.object({
    comment: z.string().optional(),
    version: z.string().optional(),
    panel: z.enum(['comments', 'versions']).optional(),
    new: z.boolean().optional(),
    import: z.string().optional(),
  }),
  loader: ({ params, context: { queryClient } }) => {
    const nodeId = pageIdFromRef(params.pageRef);
    if (nodeId) warm(queryClient, pageQuery(nodeId));
  },
  component: function WikiPage() {
    const { pageRef } = Route.useParams();
    return <PageView pageRef={pageRef} search={Route.useSearch()} />;
  },
});
