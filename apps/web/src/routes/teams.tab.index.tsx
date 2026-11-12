import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { TeamsTabPage } from '@/components/microsoft/TeamsPages';

/** Content of the Teams tab: a read view of a page or a board. */
export const Route = createFileRoute('/teams/tab/')({
  validateSearch: z.object({
    client: z.string().catch(''),
    kind: z.enum(['page', 'board']).catch('page'),
    id: z.string().catch(''),
  }),
  component: function TeamsTabRoute() {
    const { client, kind, id } = Route.useSearch();
    return <TeamsTabPage clientId={client} kind={kind} id={id} />;
  },
});
