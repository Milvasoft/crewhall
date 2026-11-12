import { Notice } from '@/components/auth/AuthLayout';
import { type AuthFailure } from '@/lib/auth/auth';
import { useI18n } from '@/lib/i18n/I18nContext';

/** Maps a failed code check to copy (2FA code, backup code). */
export function CodeError({
  error,
  invalidKey,
}: {
  error: AuthFailure;
  invalidKey: 'auth.twoFactor.invalid' | 'auth.backup.invalid';
}) {
  const { t } = useI18n();
  if (error.kind === 'cancelled') return <Notice tone="info">{t('auth.passkey.failed')}</Notice>;
  if (error.kind === 'invalid') {
    const rest =
      error.remainingAttempts !== undefined
        ? ` ${t('auth.login.remaining', { count: error.remainingAttempts })}`
        : '';
    return <Notice tone="error">{`${t(invalidKey)}${rest}`}</Notice>;
  }
  if (error.kind === 'rate_limited') {
    return <Notice tone="error">{t('errors.rate_limited')}</Notice>;
  }
  if (error.kind === 'network') return <Notice tone="error">{t('auth.errors.network')}</Notice>;
  return <Notice tone="error">{t('errors.internal')}</Notice>;
}
