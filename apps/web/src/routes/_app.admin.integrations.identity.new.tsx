import { IdpPreset } from '@crewhall/shared';
import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { ProviderEditor } from '@/components/identity/ProviderEditor';
import { formForPreset } from '@/lib/identity/providers';

/** New identity provider from a preset ("Ekle › Keycloak", 9.14). */
export const Route = createFileRoute('/_app/admin/integrations/identity/new')({
  validateSearch: z.object({ preset: IdpPreset.catch('oidc').default('oidc') }),
  component: NewProviderPage,
});

function NewProviderPage() {
  const { preset } = Route.useSearch();
  // Keyed by preset: picking another preset starts a fresh form.
  return <ProviderEditor key={preset} initial={formForPreset(preset)} />;
}
