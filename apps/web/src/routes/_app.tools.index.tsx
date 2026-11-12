import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { ToolsHome } from '@/features/tools/ToolsHome';
import { CATEGORIES, type ToolCategoryId } from '@/features/tools/lib/tool-sdk';

const ids = CATEGORIES.map((c) => c.id) as [ToolCategoryId, ...ToolCategoryId[]];

/** Tools module home (roadmap: Too Much Tools): search, favorites, categories. */
export const Route = createFileRoute('/_app/tools/')({
  validateSearch: z.object({
    category: z.enum(ids).optional().catch(undefined),
    q: z.string().max(200).optional().catch(undefined),
  }),
  component: function ToolsRoute() {
    const { category, q } = Route.useSearch();
    return <ToolsHome category={category} q={q} />;
  },
});
