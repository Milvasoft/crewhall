import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { ToolPage } from '@/features/tools/ToolPage';

/** One tool; `?node=<id>` opens a Drive file in it. */
export const Route = createFileRoute('/_app/tools/$toolId')({
  validateSearch: z.object({ node: z.string().uuid().optional().catch(undefined) }),
  component: function ToolRoute() {
    const { toolId } = Route.useParams();
    const { node } = Route.useSearch();
    return <ToolPage key={toolId} toolId={toolId} nodeId={node} />;
  },
});
