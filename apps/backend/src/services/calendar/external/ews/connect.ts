import { and, eq } from 'drizzle-orm';
import { calendarAccounts } from '@crewhall/db';
import type { ConnectExchangeAccount } from '@crewhall/shared';
import { z } from 'zod';
import { AppError } from '../../../../http/errors';
import type { AccountRow, ExtDeps } from '../accounts';
import { ProviderError } from '../http';
import { loadIntegration } from '../integrations';
import { openSecret, sealSecret } from '../secrets';
import { EWS_REFUSED, single, type EwsConnection } from './soap';

/**
 * A person connects an on-premises Exchange mailbox with their own sign-in: Exchange has no OAuth
 * on its own. The credentials are sealed in the account's secret column and leave only towards
 * the server the admin configured. A refused sign-in marks the account revoked, so a changed
 * password does not lock the person out through repeated polling.
 */

const Credentials = z.object({ username: z.string(), password: z.string() });

const CHECK =
  '<m:GetFolder><m:FolderShape><t:BaseShape>IdOnly</t:BaseShape></m:FolderShape>' +
  '<m:FolderIds><t:DistinguishedFolderId Id="calendar"/></m:FolderIds></m:GetFolder>';

export async function connectExchange(
  deps: Pick<ExtDeps, 'db' | 'env'>,
  orgId: string,
  userId: string,
  input: ConnectExchangeAccount,
): Promise<AccountRow> {
  const integration = await loadIntegration(deps.db, orgId, 'exchange');
  if (!integration?.enabled || !integration.ewsUrl) throw new AppError('calendar_integration_off');
  const username = input.username?.trim() || input.email;
  try {
    await single(
      {
        url: integration.ewsUrl,
        auth: integration.ewsAuth,
        username,
        password: input.password,
      },
      CHECK,
    );
  } catch (err) {
    if (!(err instanceof ProviderError)) throw err;
    if (err.reason === EWS_REFUSED) throw new AppError('calendar_exchange_auth_failed');
    throw new AppError('calendar_external_failed', { status: err.status, reason: err.reason });
  }
  const email = input.email.toLowerCase();
  const values = {
    refreshTokenEnc: sealSecret(
      deps.env.AUTH_SECRET,
      JSON.stringify({ username, password: input.password }),
    ),
    status: 'active' as const,
    lastError: null,
    contactsGranted: true,
  };
  const [row] = await deps.db
    .insert(calendarAccounts)
    .values({ orgId, userId, provider: 'exchange', email, ...values })
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

/** The account's way in; the integration is read when the first call needs it. */
export function exchangeConnection(
  deps: Pick<ExtDeps, 'db' | 'env'>,
  account: AccountRow,
): () => Promise<EwsConnection> {
  let conn: EwsConnection | null = null;
  return async () => {
    if (conn) return conn;
    if (account.status === 'revoked') throw new AppError('calendar_account_revoked');
    const integration = await loadIntegration(deps.db, account.orgId, 'exchange');
    if (!integration?.enabled || !integration.ewsUrl) {
      throw new AppError('calendar_integration_off');
    }
    const raw = openSecret(deps.env.AUTH_SECRET, account.refreshTokenEnc);
    const creds = Credentials.safeParse(raw ? (JSON.parse(raw) as unknown) : null);
    if (!creds.success) throw new AppError('calendar_account_revoked');
    conn = {
      url: integration.ewsUrl,
      auth: integration.ewsAuth,
      username: creds.data.username,
      password: creds.data.password,
    };
    return conn;
  };
}

/** Marks the account revoked when Exchange refuses its sign-in; other errors pass through. */
export async function revokeOnRefusal<T>(
  deps: Pick<ExtDeps, 'db'>,
  account: Pick<AccountRow, 'id' | 'orgId' | 'status'>,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!(err instanceof ProviderError) || err.reason !== EWS_REFUSED) throw err;
    await deps.db
      .update(calendarAccounts)
      // The refused password is of no use and has no reason to stay.
      .set({
        status: 'revoked',
        lastError: 'calendar_account_revoked',
        refreshTokenEnc: null,
        updatedAt: new Date(),
      })
      .where(and(eq(calendarAccounts.id, account.id), eq(calendarAccounts.orgId, account.orgId)));
    account.status = 'revoked';
    throw new AppError('calendar_account_revoked');
  }
}
