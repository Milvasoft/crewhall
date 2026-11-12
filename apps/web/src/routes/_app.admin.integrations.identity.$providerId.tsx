import { Skeleton } from '@crewhall/ui';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useMemo } from 'react';
import { Notice } from '@/components/auth/AuthLayout';
import { ProviderEditor } from '@/components/identity/ProviderEditor';
import { Workspace } from '@/components/shell/Workspace';
import { isApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n/I18nContext';
import { providerToForm } from '@/lib/identity/providers';
import { identityProviderQuery } from '@/lib/identity/queries';

/** Settings of one identity provider (9.14 "Ayarlar"). */
export const Route = createFileRoute('/_app/admin/integrations/identity/$providerId')({
  component: ProviderPage,
});

function ProviderPage() {
  const { t } = useI18n();
  const { providerId } = Route.useParams();
  const provider = useQuery(identityProviderQuery(providerId));
  // The first load seeds the form; later refetches (status after a test or sync) keep edits.
  const loaded = provider.data;
  const initial = useMemo(() => (loaded ? providerToForm(loaded) : null), [loaded]);
  if (provider.isError) {
    return (
      <Workspace crumbs={[{ label: t('admin.title') }, { label: t('identity.nav.integrations') }]}>
        <Notice tone="error">
          {isApiError(provider.error) ? t(`errors.${provider.error.code}`) : t('errors.internal')}
        </Notice>
      </Workspace>
    );
  }
  if (!provider.data || !initial) {
    return (
      <Workspace crumbs={[{ label: t('admin.title') }, { label: t('identity.nav.integrations') }]}>
        <Skeleton className="h-96 w-full rounded-2xl" />
      </Workspace>
    );
  }
  return <ProviderEditor key={provider.data.id} provider={provider.data} initial={initial} />;
}
