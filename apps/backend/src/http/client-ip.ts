import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context } from 'hono';

/**
 * Client IP: the first X-Forwarded-For hop when a proxy (Caddy) set one, otherwise the
 * socket address. Behind Caddy the header is always present.
 */
export function clientIp(c: Context): string | null {
  const forwarded = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
  if (forwarded) return forwarded;
  const real = c.req.header('x-real-ip');
  if (real) return real;
  try {
    return getConnInfo(c).remote.address ?? null;
  } catch {
    // app.request() in tests has no socket.
    return null;
  }
}
