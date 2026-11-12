import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { OfficeSignInPage } from '@/components/microsoft/OfficeAuth';

/** Sign-in dialog of the Outlook add-in and the Teams app (Crewhall OIDC with PKCE). */
export const Route = createFileRoute('/office/signin')({
  validateSearch: z.object({
    client: z.string().catch(''),
    host: z.enum(['office', 'teams']).catch('office'),
  }),
  component: function OfficeSignInRoute() {
    const { client, host } = Route.useSearch();
    return <OfficeSignInPage clientId={client} host={host} />;
  },
});
