import { Button, Icon } from '@crewhall/ui';
import { Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { type LockInfo } from '@/lib/auth/auth';
import { useNow } from '@/lib/useNow';
import { AuthHeading, Notice } from '@/components/auth/AuthLayout';
import { useI18n } from '@/lib/i18n/I18nContext';
import { formatTime } from '@/lib/i18n/format';

/**
 * Account locked after repeated failures (doc 01 · 1.16). The countdown runs on the client
 * against the server's end time; the unlock link leads to password reset.
 */
export function LockedView({
  email,
  lock,
  onPasskey,
  onExpired,
}: {
  email: string;
  lock: LockInfo;
  onPasskey?: () => void;
  onExpired: () => void;
}) {
  const { t, rich, locale } = useI18n();
  const [fallbackEnd] = useState(() => Date.now() + 15 * 60_000);
  const end = lock.lockedUntil ? new Date(lock.lockedUntil).getTime() : fallbackEnd;
  const now = useNow(1000);

  const left = Math.max(0, Math.round((end - now) / 1000));
  useEffect(() => {
    if (left === 0) onExpired();
  }, [left, onExpired]);

  const mm = String(Math.floor(left / 60)).padStart(2, '0');
  const ss = String(left % 60).padStart(2, '0');

  return (
    <>
      <span className="flex size-12 items-center justify-center rounded-[14px] bg-[color-mix(in_srgb,var(--danger)_12%,transparent)] text-danger">
        <Icon name="lock" size={24} />
      </span>
      <AuthHeading
        title={t('auth.locked.title')}
        subtitle={rich('auth.locked.subtitle', { email })}
      />
      <div className="flex flex-col gap-1 rounded-2xl bg-bg2 px-5 py-4">
        <span className="text-cap font-medium text-fg2">{t('auth.locked.retryIn')}</span>
        <span
          className="font-mono text-[44px] leading-[48px] font-semibold tracking-[-.02em] tn"
          role="timer"
        >
          {mm}:{ss}
        </span>
        <span className="text-xs text-fg2">
          {t('auth.locked.liftsAt', { time: formatTime(new Date(end), locale) })}
        </span>
      </div>
      <Button variant="inv" full asChild>
        <Link to="/forgot-password" search={{ email }}>
          <Icon name="mail" size={18} />
          {t('auth.locked.unlockByEmail')}
        </Link>
      </Button>
      <Notice tone="warn" icon="shield">
        {rich('auth.locked.notYou')}
        {lock.lastFailedAt ? (
          <>
            {' '}
            {lock.lastFailedIp
              ? t('auth.locked.lastAttemptIp', {
                  time: formatTime(lock.lastFailedAt, locale),
                  ip: lock.lastFailedIp,
                })
              : t('auth.locked.lastAttempt', { time: formatTime(lock.lastFailedAt, locale) })}
          </>
        ) : null}
      </Notice>
      {onPasskey ? (
        <button
          type="button"
          onClick={onPasskey}
          className="flex items-center gap-2 text-cap text-fg2 hover:text-fg"
        >
          <Icon name="finger" size={16} />
          {t('auth.locked.passkeyHint')}
        </button>
      ) : null}
    </>
  );
}
