import { randomBytes, timingSafeEqual } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { calendars, type CalendarSyncState, type DbOrTx } from '@crewhall/db';
import type { Env } from '../../../env';
import type { AccountRow, ExtDeps } from './accounts';
import { ProviderError } from './http';
import { openSecret, sealSecret } from './secrets';
import type { ProviderClient } from './types';

/**
 * Change notifications (sonraki-isler): a Google push channel (events.watch) or a Graph
 * subscription per mirrored calendar, so a change at the provider syncs within seconds. Only
 * when the API is reachable from the internet (https, not localhost); the five-minute polling
 * stays as the safety net either way. Channels are renewed by the sync before they expire.
 */

export const PUSH_PATHS = {
  google: '/api/calendar/push/google',
  microsoft: '/api/calendar/push/microsoft',
} as const;

/** Renew this long before expiry (Graph lives three days, Google a week). */
const RENEW_BEFORE_MS = 24 * 3_600_000;

/** The public base the providers can call, or null for internal installs. */
export function pushBase(env: Pick<Env, 'API_URL'>): string | null {
  let url: URL;
  try {
    url = new URL(env.API_URL);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (/^(localhost|127\.|10\.|192\.168\.|\[::1\])/.test(url.hostname)) return null;
  if (url.hostname.endsWith('.local') || url.hostname.endsWith('.localhost')) return null;
  return url.origin;
}

type CalendarRow = typeof calendars.$inferSelect;

/** Keeps the calendar's channel alive (best effort: a failure only means polling). */
export async function ensurePush(
  deps: Pick<ExtDeps, 'db' | 'env' | 'logger'>,
  client: ProviderClient,
  account: AccountRow,
  cal: CalendarRow,
  now = Date.now(),
) {
  const base = pushBase(deps.env);
  const push = cal.syncState?.push;
  // Exchange has only the poll.
  if (!base || account.provider === 'exchange') return;
  const path = PUSH_PATHS[account.provider];
  if (push && Date.parse(push.expiresAt) - now > RENEW_BEFORE_MS) return;
  try {
    if (push) {
      const renewed = await client.renew(push).catch(() => null);
      if (renewed) {
        await save(deps.db, cal.id, { ...push, ...renewed });
        return;
      }
      await client.unwatch(push).catch(() => undefined);
    }
    const token = randomBytes(24).toString('base64url');
    const channel = await client.watch(cal.externalId!, `${base}${path}`, token);
    await save(deps.db, cal.id, {
      ...channel,
      tokenEnc: sealSecret(deps.env.AUTH_SECRET, token),
    });
  } catch (err) {
    deps.logger.warn(
      { err: err instanceof ProviderError ? err.reason : err, calendar: cal.id },
      'calendar push channel failed',
    );
  }
}

async function save(db: DbOrTx, calendarId: string, push: NonNullable<CalendarSyncState['push']>) {
  await db
    .update(calendars)
    .set({
      syncState: sql`coalesce(${calendars.syncState}, '{"cursor":null}'::jsonb) || ${JSON.stringify({ push })}::jsonb`,
    })
    .where(eq(calendars.id, calendarId));
}

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * The account to sync for a notification: the calendar whose channel id matches and whose
 * token the provider sent back. Unknown or forged notifications find nothing.
 */
export async function accountForNotification(
  db: DbOrTx,
  env: Pick<Env, 'AUTH_SECRET'>,
  channelId: string,
  token: string,
): Promise<string | null> {
  if (!channelId || !token) return null;
  const rows = await db
    .select({ accountId: calendars.accountId, syncState: calendars.syncState })
    .from(calendars)
    .where(sql`${calendars.syncState} -> 'push' ->> 'id' = ${channelId}`)
    .limit(1);
  const row = rows[0];
  const expected = openSecret(env.AUTH_SECRET, row?.syncState?.push?.tokenEnc ?? null);
  if (!row?.accountId || !expected || !same(expected, token)) return null;
  return row.accountId;
}
