import { Button, Icon } from '@crewhall/ui';
import { retrySocketNow, useSocketState } from '@/lib/chat/runtime';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useNow } from '@/lib/useNow';

/** 4.18: shown once a live connection dropped; counts down to the next attempt. */
export function ConnectionBanner() {
  const { t } = useI18n();
  const s = useSocketState();
  const now = useNow(1000);
  if (!s.everOpened || s.status === 'open' || s.status === 'idle') return null;
  const secs = s.retryAt ? Math.max(0, Math.ceil((s.retryAt - now) / 1000)) : 0;
  return (
    <div
      role="status"
      className="flex shrink-0 items-center gap-2.5 bg-[color-mix(in_srgb,var(--warning)_14%,transparent)] px-6 py-2 text-cap"
    >
      <Icon name="wifiOff" size={16} className="text-warning" />
      <span className="font-semibold">{t('chat.connection.lost')}</span>
      <span className="text-fg2">
        {s.status === 'connecting'
          ? t('chat.connection.connecting')
          : t('chat.connection.retryIn', { attempt: s.attempt, seconds: secs })}
      </span>
      <Button size="xs" variant="out" className="ml-auto" onClick={retrySocketNow}>
        {t('chat.connection.retryNow')}
      </Button>
    </div>
  );
}
