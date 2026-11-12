import { isApiError } from '@/lib/api';
import { type MessageKey } from '@/lib/i18n/I18nContext';

/** i18n key for any thrown error: the contract code when there is one. */
export function errorKey(e: unknown): MessageKey {
  return isApiError(e) ? `errors.${e.code}` : 'errors.internal';
}
