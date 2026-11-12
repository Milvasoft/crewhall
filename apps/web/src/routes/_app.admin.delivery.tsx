import { createFileRoute } from '@tanstack/react-router';
import { DeliverySettingsPanel } from '@/components/admin/DeliverySettingsPanel';
import { PageHeader } from '@/components/admin/Settings';
import { Workspace } from '@/components/shell/Workspace';
import { useI18n } from '@/lib/i18n/I18nContext';

export const Route = createFileRoute('/_app/admin/delivery')({
  component: AdminDeliveryPage,
});

/** Yönetim › Bildirim gönderimi: how the org's e-mail and push notifications go out. */
function AdminDeliveryPage() {
  const { t } = useI18n();
  return (
    <Workspace crumbs={[{ label: t('admin.title') }, { label: t('admin.delivery.title') }]}>
      <PageHeader title={t('admin.delivery.title')} subtitle={t('admin.delivery.subtitle')} />
      <DeliverySettingsPanel />
    </Workspace>
  );
}
