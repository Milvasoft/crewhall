import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { OutlookPane } from '@/components/microsoft/OutlookPane';

/** Outlook add-in task pane (manifest SourceLocation); no app shell, no session cookie. */
export const Route = createFileRoute('/office/outlook')({
  validateSearch: z.object({
    client: z.string().catch(''),
    mode: z.enum(['read', 'compose']).catch('read'),
  }),
  component: function OutlookRoute() {
    const { client, mode } = Route.useSearch();
    return <OutlookPane clientId={client} mode={mode} />;
  },
});
