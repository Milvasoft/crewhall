import { createFileRoute } from '@tanstack/react-router';
import { PageHeader } from '@/components/admin/Settings';
import { AiSettingsPanel } from '@/components/ai/AiSettingsPanel';
import { Workspace } from '@/components/shell/Workspace';
import { useI18n } from '@/lib/i18n/I18nContext';

export const Route = createFileRoute('/_app/admin/ai')({
  component: AdminAiPage,
});

/** Yönetim › Yapay zekâ (yol haritası #5): the org's model, key, quotas and usage. */
function AdminAiPage() {
  const { t } = useI18n();
  return (
    <Workspace crumbs={[{ label: t('admin.title') }, { label: t('ai.admin.title') }]}>
      <PageHeader title={t('ai.admin.title')} subtitle={t('ai.admin.subtitle')} />
      <AiSettingsPanel />
    </Workspace>
  );
}
