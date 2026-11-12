import { EmptyState } from '@crewhall/ui';
import { createFileRoute } from '@tanstack/react-router';
import { useI18n } from '@/lib/i18n/I18nContext';

export const Route = createFileRoute('/_app/account/approvals/')({
  component: NoSelection,
});

function NoSelection() {
  const { t } = useI18n();
  return (
    <EmptyState
      icon="shield"
      title={t('mcp.approvals.title')}
      description={t('mcp.approvals.select')}
      className="mt-16"
    />
  );
}
