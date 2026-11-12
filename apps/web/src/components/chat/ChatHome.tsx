import { Button, EmptyState, Icon } from '@crewhall/ui';
import { Link } from '@tanstack/react-router';
import { DesktopTitleBarRow } from '@/lib/desktop-titlebar';
import { useI18n } from '@/lib/i18n/I18nContext';

/** /chat with nothing open: pick a chat on the left or start one. */
export function ChatHome() {
  const { t } = useI18n();
  return (
    <>
      <DesktopTitleBarRow />
      <EmptyState
        className="m-auto"
        icon="chat"
        title={t('chat.home.title')}
        description={t('chat.home.body')}
      >
        <Button variant="inv" asChild>
          <Link to="/chat/new">
            <Icon name="compose" size={16} />
            {t('chat.list.newChat')}
          </Link>
        </Button>
      </EmptyState>
    </>
  );
}

/** Chat is turned off for the org (`module_disabled`). */
export function ChatDisabled() {
  const { t } = useI18n();
  return (
    <EmptyState
      className="m-auto"
      icon="chat"
      title={t('chat.disabled.title')}
      description={t('chat.disabled.body')}
    >
      <Button variant="inv" asChild>
        <Link to="/">{t('chat.disabled.home')}</Link>
      </Button>
    </EmptyState>
  );
}
