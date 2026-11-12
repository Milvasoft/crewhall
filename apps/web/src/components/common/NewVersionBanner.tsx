import { Button, Icon, IconButton } from '@crewhall/ui';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useNewVersion } from '@/lib/newVersion';

/** "Yeni sürüm hazır · Yenile" at the bottom of the window (lib/newVersion). */
export function NewVersionBanner() {
  const { t } = useI18n();
  const ready = useNewVersion();
  const [later, setLater] = useState(false);
  if (!ready || later) return null;
  return (
    <div
      role="status"
      className="fixed bottom-4 left-1/2 z-[70] flex -translate-x-1/2 animate-rise-in items-center gap-2 rounded-full bg-fg py-1.5 pr-1.5 pl-4 text-sm font-medium text-bg shadow-overlay"
    >
      <Icon name="sparkle" size={15} />
      <span>{t('shell.newVersion.ready')}</span>
      <Button size="xs" variant="pri" onClick={() => window.location.reload()}>
        {t('shell.newVersion.reload')}
      </Button>
      <IconButton
        size="xs"
        tone="plain"
        className="text-bg hover:bg-bg/10"
        aria-label={t('shell.newVersion.later')}
        onClick={() => setLater(true)}
      >
        <Icon name="x" size={14} />
      </IconButton>
    </div>
  );
}
