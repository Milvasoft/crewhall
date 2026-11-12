import { createFileRoute } from '@tanstack/react-router';
import { PageHeader } from '@/components/admin/Settings';
import { NotificationPrefsBody } from '@/components/notifications/NotificationPrefs';
import { Workspace } from '@/components/shell/Workspace';
import { useI18n } from '@/lib/i18n/I18nContext';

export const Route = createFileRoute('/_app/account/notifications')({
  component: NotificationsPage,
});

/** Hesabım › Bildirimler: every kind of notification × bell, desktop, phone and e-mail digest. */
function NotificationsPage() {
  const { t } = useI18n();
  return (
    <Workspace crumbs={[{ label: t('account.title') }, { label: t('account.nav.notifications') }]}>
      <PageHeader title={t('chat.prefs.title')} subtitle={t('chat.prefs.pageSubtitle')} />
      <div className="flex max-w-[860px] flex-col gap-5">
        <NotificationPrefsBody />
      </div>
    </Workspace>
  );
}
