import { and, asc, eq, inArray } from 'drizzle-orm';
import { calendarAccounts, calendars, type Db, type DbOrTx } from '@crewhall/db';
import type { CalendarAccount, CalendarAccounts } from '@crewhall/shared';
import type { Env } from '../../../env';
import { AppError } from '../../../http/errors';
import type { Logger } from '../../../logger';
import { googleClient } from './google';
import { apiCall, calendarFetch, ProviderError } from './http';
import { availableProviders, type Provider } from './integrations';
import { GRAPH, microsoftClient } from './microsoft';
import { dropMirror } from '../../contacts/external/mirror';
import { delegatedToken } from './domain-wide';
import { exchangeClient } from './ews/calendar';
import { exchangeConnection } from './ews/connect';
import { OauthGrantError, refreshTokens, type Tokens } from './oauth';
import { openSecret, sealSecret } from './secrets';
import type { Api, ProviderClient } from './types';

export type AccountRow = typeof calendarAccounts.$inferSelect;
export interface ExtDeps {
  db: Db;
  env: Env;
  logger: Logger;
}

async function markRevoked(db: DbOrTx, account: AccountRow) {
  await db
    .update(calendarAccounts)
    .set({ status: 'revoked', lastError: 'calendar_account_revoked', updatedAt: new Date() })
    .where(eq(calendarAccounts.id, account.id));
  account.status = 'revoked';
}

/** A valid access token, refreshed when it expires within a minute (or when forced after a 401). */
export async function accessToken(
  deps: Pick<ExtDeps, 'db' | 'env'>,
  account: AccountRow,
  force = false,
): Promise<string> {
  const { db, env } = deps;
  if (account.status === 'revoked') throw new AppError('calendar_account_revoked');
  if (account.delegated) return delegatedToken(deps, account, force);
  const cached = openSecret(env.AUTH_SECRET, account.accessTokenEnc);
  if (
    !force &&
    cached &&
    account.accessExpiresAt &&
    account.accessExpiresAt.getTime() - Date.now() > 60_000
  ) {
    return cached;
  }
  const refresh = openSecret(env.AUTH_SECRET, account.refreshTokenEnc);
  if (!refresh) {
    await markRevoked(db, account);
    throw new AppError('calendar_account_revoked');
  }
  let tokens: Tokens;
  try {
    tokens = await refreshTokens(
      db,
      env,
      account.orgId,
      account.provider,
      refresh,
      account.contactsGranted,
    );
  } catch (err) {
    if (err instanceof OauthGrantError) {
      await markRevoked(db, account);
      throw new AppError('calendar_account_revoked');
    }
    throw err;
  }
  const values = {
    accessTokenEnc: sealSecret(env.AUTH_SECRET, tokens.accessToken),
    accessExpiresAt: tokens.expiresAt,
    ...(tokens.refreshToken
      ? { refreshTokenEnc: sealSecret(env.AUTH_SECRET, tokens.refreshToken) }
      : {}),
  };
  await db
    .update(calendarAccounts)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(calendarAccounts.id, account.id));
  Object.assign(account, values);
  return tokens.accessToken;
}

/** Calls with the account's token; they retry once after a 401. */
export function apiFor(deps: Pick<ExtDeps, 'db' | 'env'>, account: AccountRow): Api {
  return async (url, req = {}) => {
    const token = await accessToken(deps, account);
    try {
      return await apiCall(url, { ...req, token });
    } catch (err) {
      if (!(err instanceof ProviderError) || err.status !== 401) throw err;
      return apiCall(url, { ...req, token: await accessToken(deps, account, true) });
    }
  };
}

/** Application access has no "me": the person's mailbox by address. */
export const graphRoot = (account: Pick<AccountRow, 'delegated' | 'email'>) =>
  account.delegated ? `${GRAPH}/users/${encodeURIComponent(account.email)}` : `${GRAPH}/me`;

/** The provider adapter for an account. */
export function clientFor(deps: Pick<ExtDeps, 'db' | 'env'>, account: AccountRow): ProviderClient {
  if (account.provider === 'exchange') {
    return exchangeClient(exchangeConnection(deps, account), account.email);
  }
  const api = apiFor(deps, account);
  return account.provider === 'google'
    ? googleClient(api, account.email)
    : microsoftClient(api, account.email, graphRoot(account));
}

/** Saves (or renews) an account after the OAuth callback. */
export async function connectAccount(
  deps: Pick<ExtDeps, 'db' | 'env'>,
  orgId: string,
  userId: string,
  provider: Provider,
  tokens: Tokens,
): Promise<AccountRow> {
  const { db, env } = deps;
  if (!tokens.email) throw new AppError('calendar_oauth_failed', { reason: 'no_email' });
  const [existing] = await db
    .select()
    .from(calendarAccounts)
    .where(
      and(
        eq(calendarAccounts.orgId, orgId),
        eq(calendarAccounts.userId, userId),
        eq(calendarAccounts.provider, provider),
        eq(calendarAccounts.email, tokens.email),
      ),
    );
  const refreshEnc = tokens.refreshToken
    ? sealSecret(env.AUTH_SECRET, tokens.refreshToken)
    : (existing?.refreshTokenEnc ?? null);
  if (!refreshEnc) throw new AppError('calendar_oauth_failed', { reason: 'no_refresh_token' });
  const values = {
    refreshTokenEnc: refreshEnc,
    accessTokenEnc: sealSecret(env.AUTH_SECRET, tokens.accessToken),
    accessExpiresAt: tokens.expiresAt,
    status: 'active' as const,
    lastError: null,
    contactsGranted: tokens.contactsGranted ?? false,
  };
  const [row] = await db
    .insert(calendarAccounts)
    .values({ orgId, userId, provider, email: tokens.email, ...values })
    .onConflictDoUpdate({
      target: [
        calendarAccounts.orgId,
        calendarAccounts.userId,
        calendarAccounts.provider,
        calendarAccounts.email,
      ],
      set: { ...values, updatedAt: new Date() },
    })
    .returning();
  return row!;
}

export async function loadOwnAccount(db: DbOrTx, orgId: string, userId: string, accountId: string) {
  const [row] = await db
    .select()
    .from(calendarAccounts)
    .where(
      and(
        eq(calendarAccounts.id, accountId),
        eq(calendarAccounts.orgId, orgId),
        eq(calendarAccounts.userId, userId),
      ),
    );
  if (!row) throw new AppError('not_found');
  return row;
}

type CalendarRow = typeof calendars.$inferSelect;

export function accountView(row: AccountRow, cals: CalendarRow[]): CalendarAccount {
  return {
    id: row.id,
    provider: row.provider,
    email: row.email,
    status: row.status,
    lastError: row.lastError,
    lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
    calendars: cals
      .filter((c) => c.accountId === row.id && !c.deletedAt)
      .sort((a, b) => a.name.localeCompare(b.name, 'tr'))
      .map((c) => ({ id: c.id, name: c.name, writable: Boolean(c.externalWritable) })),
    createdAt: row.createdAt.toISOString(),
    delegated: row.delegated,
    busyOnly: row.busyOnly,
    contacts: row.contactsState
      ? {
          status: row.contactsState.status,
          lastError: row.contactsState.lastError,
          lastSyncedAt: row.contactsState.lastSyncedAt,
          count: row.contactsState.count,
        }
      : null,
  };
}

export async function accountWithCalendars(db: DbOrTx, row: AccountRow): Promise<CalendarAccount> {
  const cals = await db.select().from(calendars).where(eq(calendars.accountId, row.id));
  return accountView(row, cals);
}

export async function listAccounts(
  db: DbOrTx,
  orgId: string,
  userId: string,
): Promise<CalendarAccounts> {
  const rows = await db
    .select()
    .from(calendarAccounts)
    .where(and(eq(calendarAccounts.orgId, orgId), eq(calendarAccounts.userId, userId)))
    .orderBy(asc(calendarAccounts.createdAt));
  const cals = rows.length
    ? await db
        .select()
        .from(calendars)
        .where(
          inArray(
            calendars.accountId,
            rows.map((r) => r.id),
          ),
        )
    : [];
  return {
    items: rows.map((r) => accountView(r, cals)),
    providers: await availableProviders(db, orgId),
  };
}

/**
 * "Yalnız meşgul/boş": the next sync is a full one, so details go (or come back); nothing is
 * written to a busy-only account's calendars.
 */
export async function setBusyOnly(
  db: DbOrTx,
  orgId: string,
  userId: string,
  accountId: string,
  busyOnly: boolean,
) {
  const row = await loadOwnAccount(db, orgId, userId, accountId);
  const [updated] = await db
    .update(calendarAccounts)
    .set({ busyOnly, updatedAt: new Date() })
    .where(eq(calendarAccounts.id, row.id))
    .returning();
  const cals = await db.select().from(calendars).where(eq(calendars.accountId, row.id));
  for (const c of cals) {
    await db
      .update(calendars)
      .set({
        syncState: c.syncState ? { ...c.syncState, cursor: null } : null,
        ...(busyOnly ? { externalWritable: false } : {}),
        updatedAt: new Date(),
      })
      .where(eq(calendars.id, c.id));
  }
  return updated!;
}

/** Disconnects: the account's calendars and events leave Crewhall (cascade). */
export async function deleteAccount(
  deps: Pick<ExtDeps, 'db' | 'env' | 'logger'>,
  orgId: string,
  userId: string,
  accountId: string,
) {
  const row = await loadOwnAccount(deps.db, orgId, userId, accountId);
  // The org added it: it goes when the admin switches org-wide access off.
  if (row.delegated) throw new AppError('forbidden');
  await dropMirror(deps.db, [row.id]);
  await deps.db.delete(calendarAccounts).where(eq(calendarAccounts.id, row.id));
  // Google lets us withdraw the grant; Microsoft has no such endpoint (the person removes the
  // app in their account). Best effort either way.
  if (row.provider === 'google') {
    const token = openSecret(deps.env.AUTH_SECRET, row.refreshTokenEnc);
    if (token) {
      await calendarFetch('https://oauth2.googleapis.com/revoke', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token }).toString(),
        signal: AbortSignal.timeout(5_000),
      }).catch((err: unknown) => deps.logger.warn({ err }, 'calendar google revoke failed'));
    }
  }
  return row;
}
