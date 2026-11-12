import { createFileRoute } from '@tanstack/react-router';
import { OfficeCallbackPage } from '@/components/microsoft/OfficeAuth';

/** OIDC redirect URI of the add-in and Teams clients; hands the tokens back to the pane. */
export const Route = createFileRoute('/office/callback')({
  component: OfficeCallbackPage,
});
