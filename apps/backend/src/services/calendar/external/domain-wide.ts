import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import {
  calendarAccounts,
  calendarIntegrations,
  orgMembers,
  users,
  type DbOrTx,
} from '@crewhall/db';
import type { Env } from '../../../env';
import { AppError } from '../../../http/errors';
import { calendarEnabled } from '../access';
import { dropMirror } from '../../contacts/external/mirror';
import type { AccountRow, ExtDeps } from './accounts';
import { calendarFetch, ProviderError } from './http';
import { domainWideReady, loadIntegration, serviceAccountOf } from './integrations';
import { openSecret } from './secrets';
import { serviceAccountToken } from './service-account';

/**
 * Org-wide calendar access (sonraki-isler): when a Workspace admin granted domain-wide
 * delegation to the org's service account, or a Microsoft 365 admin consented to the
 * application permission Calendars.ReadWrite, everyone's calendar syncs without each person
 * connecting. Such accounts are `delegated`: no refresh token, tokens come from the org.
 */

export const GOOGLE_CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar';

const appTokens = new Map<string, { token: string; until: number }>();

/** Microsoft client credentials: one application token per tenant, cached. */
async function microsoftAppToken(
  env: Pick<Env, 'AUTH_SECRET'>,
  row: typeof calendarIntegrations.$inferSelect,
): Promise<string> {
  const key = `${row.orgId}:${row.tenant}`;
  const hit = appTokens.get(key);
  if (hit && hit.until > Date.now()) return hit.token;
  const secret = openSecret(env.AUTH_SECRET, row.clientSecretEnc);
  if (!row.clientId || !secret || !row.tenant) throw new AppError('calendar_integration_off');
  let res: Response;
  try {
    res = await calendarFetch(
      `https://login.microsoftonline.com/${encodeURIComponent(row.tenant)}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: row.clientId,
          client_secret: secret,
          scope: 'https://graph.microsoft.com/.default',
        }),
      },
    );
  } catch {
    throw new ProviderError(0, 'unreachable');
  }
  const json = (await res.json().catch(() => null)) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
  } | null;
  if (!res.ok || !json?.access_token) {
    throw new ProviderError(res.status || 400, json?.error ?? `http_${res.status}`);
  }
  appTokens.set(key, {
    token: json.access_token,
    until: Date.now() + Math.max(60, (json.expires_in ?? 3600) - 60) * 1000,
  });
  return json.access_token;
}

/** Tests start from an empty application token cache. */
export function clearAppTokens() {
  appTokens.clear();
}

/** An access token for a delegated account: the org's service account or application access. */
export async function delegatedToken(
  deps: Pick<ExtDeps, 'db' | 'env'>,
  account: AccountRow,
  force = false,
): Promise<string> {
  const row = await loadIntegration(deps.db, account.orgId, account.provider);
  if (!domainWideReady(row)) throw new AppError('calendar_integration_off');
  if (force) appTokens.delete(`${row!.orgId}:${row!.tenant}`);
  if (account.provider === 'google') {
    const key = serviceAccountOf(deps.env, row);
    if (!key) throw new AppError('calendar_integration_off');
    return serviceAccountToken(key, GOOGLE_CALENDAR_SCOPE, account.email);
  }
  return microsoftAppToken(deps.env, row!);
}

/**
 * calendar.domain_wide (hourly, and right after the admin changes the integration): every
 * active member of an org with org-wide access gets a delegated account for that provider;
 * people who left, and everyone when the access is switched off, lose it (their mirrored
 * calendars go with it). Someone who connected the same address themselves keeps theirs.
 */
export async function provisionDomainWide(deps: Pick<ExtDeps, 'db'>, orgId?: string) {
  const rows = await deps.db
    .select()
    .from(calendarIntegrations)
    .where(orgId ? eq(calendarIntegrations.orgId, orgId) : sql`true`);
  let added = 0;
  for (const row of rows) {
    const on = domainWideReady(row) && (await calendarEnabled(deps.db, row.orgId));
    const people = on ? await membersOf(deps.db, row.orgId) : [];
    const keep = new Set(people.map((p) => p.id));
    // Off, or the person left: their delegated account goes.
    const stale = await deps.db
      .select({ id: calendarAccounts.id, userId: calendarAccounts.userId })
      .from(calendarAccounts)
      .where(
        and(
          eq(calendarAccounts.orgId, row.orgId),
          eq(calendarAccounts.provider, row.provider),
          eq(calendarAccounts.delegated, true),
        ),
      );
    const doomed = stale.filter((s) => !keep.has(s.userId)).map((s) => s.id);
    if (doomed.length) {
      await dropMirror(deps.db, doomed);
      await deps.db.delete(calendarAccounts).where(inArray(calendarAccounts.id, doomed));
    }
    if (!people.length) continue;
    const created = await deps.db
      .insert(calendarAccounts)
      .values(
        people.map((p) => ({
          orgId: row.orgId,
          userId: p.id,
          provider: row.provider,
          email: p.email,
          refreshTokenEnc: null,
          delegated: true,
        })),
      )
      .onConflictDoNothing()
      .returning({ id: calendarAccounts.id });
    added += created.length;
  }
  return added;
}

async function membersOf(db: DbOrTx, orgId: string) {
  return db
    .select({ id: users.id, email: users.email })
    .from(orgMembers)
    .innerJoin(users, eq(users.id, orgMembers.userId))
    .where(
      and(
        eq(orgMembers.organizationId, orgId),
        eq(orgMembers.status, 'active'),
        ne(orgMembers.role, 'guest'),
      ),
    );
}
