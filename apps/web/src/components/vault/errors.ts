import { CryptoError } from '@crewhall/crypto';
import { type ErrorCode } from '@crewhall/shared';
import { isApiError } from '@/lib/api';
import { type I18nValue } from '@/lib/i18n/I18nContext';

/** One message for API errors (errors.<code>) and local crypto failures. */
export function errorMessage(e: unknown, t: I18nValue['t']): string {
  if (isApiError(e)) return t(`errors.${e.code as ErrorCode}`);
  if (e instanceof CryptoError) {
    if (e.code === 'invalid_recovery_key') return t('vault.error.recoveryTypo');
    if (e.code === 'weak_kdf') return t('vault.error.weakKdf');
    return t('vault.error.decrypt');
  }
  return t('vault.error.generic');
}
