import { ApiError, createApiClient } from '@crewhall/api-client';
import { type ErrorCode } from '@crewhall/shared';
import { config } from '@/config';
import { newId } from '@/lib/ids';

let currentLocale = 'tr';

/** Called by the i18n provider so requests carry Accept-Language. */
export function setApiLocale(locale: string): void {
  currentLocale = locale;
}

/** Typed client for /api/v1; the session is the httpOnly better-auth cookie. */
export const api = createApiClient({
  baseUrl: config.apiUrl,
  credentials: 'include',
  // Resolve fetch per call so test interceptors (MSW node) installed later still apply.
  fetch: (input, init) => fetch(input, init),
  validateResponses: config.dev,
  locale: () => currentLocale,
});

export { ApiError };

export function isApiError(e: unknown, code?: ErrorCode): e is ApiError {
  return e instanceof ApiError && (code === undefined || e.code === code);
}

/** Fresh key for writes that accept Idempotency-Key. */
export function idempotencyKey(): string {
  return newId();
}
