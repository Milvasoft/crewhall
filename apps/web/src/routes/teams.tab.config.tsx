import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { TeamsTabConfigPage } from '@/components/microsoft/TeamsPages';

/** Configuration page of the Teams tab: which page or board it shows. */
export const Route = createFileRoute('/teams/tab/config')({
  validateSearch: z.object({ client: z.string().catch('') }),
  component: function TeamsTabConfigRoute() {
    const { client } = Route.useSearch();
    return <TeamsTabConfigPage clientId={client} />;
  },
});
