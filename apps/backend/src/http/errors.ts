import { resources, resolveLocale } from '@crewhall/i18n';
import { HTTP_STATUS_BY_CODE, type ApiErrorBody, type ErrorCode } from '@crewhall/shared';
import type { z } from 'zod';

/**
 * The only error type services throw. The handler turns it into
 * `{ code, message, details? }` with the status from HTTP_STATUS_BY_CODE;
 * `message` is the localized `errors.<code>` text unless one is given.
 */
export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly details?: unknown,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'AppError';
  }

  get status(): number {
    return HTTP_STATUS_BY_CODE[this.code];
  }
}

export const fail = (code: ErrorCode, details?: unknown): never => {
  throw new AppError(code, details);
};

export function localizedMessage(code: ErrorCode, acceptLanguage: string | null | undefined) {
  const locale = resolveLocale(acceptLanguage);
  const dict: Record<string, string> = resources[locale].errors;
  return dict[code] ?? code;
}

export function errorBody(err: AppError, acceptLanguage: string | null | undefined): ApiErrorBody {
  const message =
    err.message && err.message !== err.code
      ? err.message
      : localizedMessage(err.code, acceptLanguage);
  return err.details === undefined
    ? { code: err.code, message }
    : { code: err.code, message, details: err.details };
}

export function validationError(error: z.ZodError, where: 'body' | 'query' | 'params') {
  return new AppError('validation_failed', {
    in: where,
    issues: error.issues.map((i) => ({
      path: i.path.map(String),
      code: i.code,
      message: i.message,
    })),
  });
}
