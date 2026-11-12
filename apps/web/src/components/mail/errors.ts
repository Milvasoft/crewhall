import { ERROR_CODES, type ErrorCode } from '@crewhall/shared';
import { isApiError } from '@/lib/api';
import { type I18nValue } from '@/lib/i18n/I18nContext';

/** Localized text of a failed mail call (`errors.<code>`), the generic one otherwise. */
export function mailError(t: I18nValue['t'], e: unknown): string {
  return isApiError(e) ? t(`errors.${e.code}`) : t('errors.internal');
}

const isErrorCode = (v: string): v is ErrorCode => (ERROR_CODES as readonly string[]).includes(v);

/** Text of an error code that arrived as a plain string (probe results, redirects). */
export function codeText(t: I18nValue['t'], code: string | null | undefined, fallback: ErrorCode) {
  return t(`errors.${code && isErrorCode(code) ? code : fallback}`);
}
