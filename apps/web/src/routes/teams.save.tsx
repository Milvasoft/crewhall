import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { TeamsSavePage } from '@/components/microsoft/TeamsPages';

/** Dialog of the Teams message action "Crewhall'a kaydet". */
export const Route = createFileRoute('/teams/save')({
  validateSearch: z.object({ client: z.string().catch(''), draft: z.string().catch('') }),
  component: function TeamsSaveRoute() {
    const { client, draft } = Route.useSearch();
    return <TeamsSavePage clientId={client} draftId={draft} />;
  },
});
