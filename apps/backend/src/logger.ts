import pino, { type Logger } from 'pino';

export type { Logger };

/** JSON logs to stdout (design doc 17 §11); `pino-pretty` only when asked for in dev. */
export function createLogger(level: string, pretty = false): Logger {
  return pino({
    level,
    base: { service: process.env.OTEL_SERVICE_NAME ?? 'crewhall-backend' },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        '*.password',
        '*.newPassword',
        '*.token',
        '*.setupToken',
      ],
      censor: '[redacted]',
    },
    ...(pretty ? { transport: { target: 'pino-pretty', options: { colorize: true } } } : {}),
  });
}
