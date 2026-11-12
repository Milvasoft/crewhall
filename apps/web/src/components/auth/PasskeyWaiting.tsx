import { Button, Icon, Spinner } from '@crewhall/ui';
import { useEffect, useState } from 'react';
import { AuthHeading, Notice, OrDivider } from '@/components/auth/AuthLayout';
import { useI18n } from '@/lib/i18n/I18nContext';

/** Waiting for the browser's WebAuthn sheet (doc 01 · 1.5). Gives up after 60 s. */
export function PasskeyWaiting({ onCancel }: { onCancel: () => void }) {
  const { t } = useI18n();
  const [left, setLeft] = useState(60);

  useEffect(() => {
    const id = window.setInterval(() => setLeft((v) => Math.max(0, v - 1)), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (left === 0) onCancel();
  }, [left, onCancel]);

  return (
    <>
      <span className="flex size-12 items-center justify-center rounded-[14px] bg-bg2 text-fg">
        <Icon name="finger" size={24} />
      </span>
      <AuthHeading title={t('auth.passkey.title')} subtitle={t('auth.passkey.subtitle')} />
      <div className="flex items-center gap-3 rounded-2xl bg-bg2 px-4 py-3.5" aria-live="polite">
        <Spinner />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-sm font-semibold">{t('auth.passkey.waiting')}</span>
          <span className="text-xs text-fg2">{t('auth.passkey.waitingHint')}</span>
        </div>
        <span className="font-mono text-cap text-fg2 tn">0:{String(left).padStart(2, '0')}</span>
      </div>
      <Button full onClick={onCancel}>
        {t('common.actions.cancel')}
      </Button>
      <OrDivider>{t('auth.login.or')}</OrDivider>
      <Button variant="out" full onClick={onCancel}>
        <Icon name="mail" size={18} />
        {t('auth.passkey.useEmail')}
      </Button>
      <Notice tone="info">{t('auth.passkey.where')}</Notice>
    </>
  );
}
