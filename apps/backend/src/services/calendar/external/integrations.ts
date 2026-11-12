import { and, eq, sql } from 'drizzle-orm';
import { calendarAccounts, calendarIntegrations, type DbOrTx } from '@crewhall/db';
import {
  CALENDAR_RAW_PATHS,
  CalendarProvider,
  type CalendarIntegration,
  type UpdateCalendarIntegration,
} from '@crewhall/shared';
import type { Env } from '../../../env';
import { AppError } from '../../../http/errors';
import { openSecret, sealSecret } from './secrets';
import { parseServiceAccountKey, type ServiceAccountKey } from './service-account';

export type IntegrationRow = typeof calendarIntegrations.$inferSelect;
export type Provider = CalendarProvider;

const PROVIDERS = CalendarProvider.options;

export const oauthRedirectUri = (env: Pick<Env, 'API_URL'>) =>
  `${env.API_URL.replace(/\/$/, '')}${CALENDAR_RAW_PATHS.oauthCallback}`;

export function parseProvider(v: string | undefined): Provider {
  const p = CalendarProvider.safeParse(v);
  if (!p.success) throw new AppError('not_found');
  return p.data;
}

export async function loadIntegration(
  db: DbOrTx,
  orgId: string,
  provider: Provider,
): Promise<IntegrationRow | null> {
  const [row] = await db
    .select()
    .from(calendarIntegrations)
    .where(and(eq(calendarIntegrations.orgId, orgId), eq(calendarIntegrations.provider, provider)));
  return row ?? null;
}

/** The OAuth client of a provider the admin switched on; calendar_integration_off otherwise. */
export async function requireClient(
  db: DbOrTx,
  env: Pick<Env, 'AUTH_SECRET'>,
  orgId: string,
  provider: Provider,
) {
  const row = await loadIntegration(db, orgId, provider);
  const secret = openSecret(env.AUTH_SECRET, row?.clientSecretEnc ?? null);
  if (!row?.enabled || !row.clientId || !secret) throw new AppError('calendar_integration_off');
  return { id: row.clientId, secret, tenant: row.tenant, contactsSync: row.contactsSync };
}

/** Providers people of the org can connect (switched on and complete). */
export async function availableProviders(db: DbOrTx, orgId: string): Promise<Provider[]> {
  const rows = await db
    .select()
    .from(calendarIntegrations)
    .where(eq(calendarIntegrations.orgId, orgId));
  return PROVIDERS.filter((p) => {
    const r = rows.find((x) => x.provider === p);
    if (p === 'exchange') return Boolean(r?.enabled && r.ewsUrl);
    return Boolean(r?.enabled && r.clientId && r.clientSecretEnc);
  });
}

async function view(
  db: DbOrTx,
  env: Pick<Env, 'API_URL'> & Partial<Pick<Env, 'AUTH_SECRET'>>,
  orgId: string,
  provider: Provider,
  row: IntegrationRow | null,
): Promise<CalendarIntegration> {
  const [count] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(calendarAccounts)
    .where(and(eq(calendarAccounts.orgId, orgId), eq(calendarAccounts.provider, provider)));
  return {
    provider,
    enabled: row?.enabled ?? false,
    clientId: row?.clientId ?? null,
    hasClientSecret: Boolean(row?.clientSecretEnc),
    tenant: provider === 'microsoft' ? (row?.tenant ?? null) : null,
    redirectUri: oauthRedirectUri(env),
    accountCount: count?.n ?? 0,
    updatedAt: row?.updatedAt.toISOString() ?? null,
    domainWide: row?.domainWide ?? false,
    serviceAccountEmail:
      provider === 'google' ? (serviceAccountOf(env, row)?.clientEmail ?? null) : null,
    delegatedAdmin: provider === 'google' ? (row?.delegatedAdmin ?? null) : null,
    directorySync: provider === 'google' ? (row?.directorySync ?? false) : false,
    directorySyncedAt: row?.directorySyncedAt?.toISOString() ?? null,
    directoryError: row?.directoryError ?? null,
    contactsSync: provider === 'google' ? false : (row?.contactsSync ?? false),
    ...(provider === 'exchange'
      ? { ewsUrl: row?.ewsUrl ?? null, ewsAuth: row?.ewsAuth ?? 'ntlm' }
      : {}),
  };
}

/** Google: the stored service account key, or null. */
export function serviceAccountOf(
  env: Partial<Pick<Env, 'AUTH_SECRET'>>,
  row: Pick<IntegrationRow, 'serviceAccountEnc'> | null,
): ServiceAccountKey | null {
  if (!env.AUTH_SECRET || !row?.serviceAccountEnc) return null;
  const json = openSecret(env.AUTH_SECRET, row.serviceAccountEnc);
  if (!json) return null;
  try {
    return parseServiceAccountKey(json);
  } catch {
    return null;
  }
}

/**
 * Org-wide (application) access of a provider, when the admin switched it on: Google's service
 * account or Microsoft's client credentials for a single tenant.
 */
export function domainWideReady(row: IntegrationRow | null): boolean {
  if (!row?.enabled || !row.domainWide || row.provider === 'exchange') return false;
  if (row.provider === 'google') return Boolean(row.serviceAccountEnc);
  return Boolean(row.clientId && row.clientSecretEnc && singleTenant(row.tenant));
}

/** Application permissions need the org's own tenant, not common / organizations. */
const singleTenant = (tenant: string | null) =>
  Boolean(tenant && !['common', 'organizations', 'consumers'].includes(tenant.toLowerCase()));

export async function listIntegrations(
  db: DbOrTx,
  env: Pick<Env, 'API_URL' | 'AUTH_SECRET'>,
  orgId: string,
) {
  const items: CalendarIntegration[] = [];
  for (const p of PROVIDERS)
    items.push(await view(db, env, orgId, p, await loadIntegration(db, orgId, p)));
  return { items };
}

export async function updateIntegration(
  db: DbOrTx,
  env: Pick<Env, 'API_URL' | 'AUTH_SECRET'>,
  orgId: string,
  userId: string,
  provider: Provider,
  input: UpdateCalendarIntegration,
): Promise<CalendarIntegration> {
  const current = await loadIntegration(db, orgId, provider);
  let secretEnc = current?.clientSecretEnc ?? null;
  if (input.clientSecret === null) secretEnc = null;
  else if (input.clientSecret) secretEnc = sealSecret(env.AUTH_SECRET, input.clientSecret.trim());
  const clientId =
    input.clientId === undefined ? (current?.clientId ?? null) : input.clientId || null;
  const tenant =
    provider !== 'microsoft'
      ? null
      : input.tenant === undefined
        ? (current?.tenant ?? null)
        : input.tenant || null;
  const ewsUrl =
    provider !== 'exchange'
      ? null
      : input.ewsUrl === undefined
        ? (current?.ewsUrl ?? null)
        : input.ewsUrl || null;
  if (provider === 'exchange') {
    if (input.enabled && !ewsUrl) {
      throw new AppError('validation_failed', { field: 'ewsUrl', reason: 'ews_url_required' });
    }
  } else if (input.enabled && (!clientId || !secretEnc)) {
    throw new AppError('validation_failed', { field: 'clientId', reason: 'oauth_client_required' });
  }
  // Google Workspace: the service account (domain-wide delegation) and the admin it acts as.
  let serviceAccountEnc = provider === 'google' ? (current?.serviceAccountEnc ?? null) : null;
  if (provider === 'google' && input.serviceAccountKey === null) serviceAccountEnc = null;
  else if (provider === 'google' && input.serviceAccountKey) {
    parseServiceAccountKey(input.serviceAccountKey);
    serviceAccountEnc = sealSecret(env.AUTH_SECRET, input.serviceAccountKey.trim());
  }
  const delegatedAdmin =
    provider !== 'google'
      ? null
      : input.delegatedAdmin === undefined
        ? (current?.delegatedAdmin ?? null)
        : input.delegatedAdmin || null;
  const directorySync =
    provider === 'google' && (input.directorySync ?? current?.directorySync ?? false);
  const contactsSync =
    provider !== 'google' && (input.contactsSync ?? current?.contactsSync ?? false);
  const domainWide = provider !== 'exchange' && (input.domainWide ?? current?.domainWide ?? false);
  if (directorySync && (!serviceAccountEnc || !delegatedAdmin)) {
    throw new AppError('validation_failed', {
      field: 'serviceAccountKey',
      reason: 'service_account_required',
    });
  }
  if (domainWide && input.enabled) {
    if (provider === 'google' && !serviceAccountEnc) {
      throw new AppError('validation_failed', {
        field: 'serviceAccountKey',
        reason: 'service_account_required',
      });
    }
    if (provider === 'microsoft' && !singleTenant(tenant)) {
      throw new AppError('validation_failed', { field: 'tenant', reason: 'tenant_required' });
    }
  }
  const values = {
    enabled: input.enabled,
    clientId,
    clientSecretEnc: secretEnc,
    tenant,
    domainWide,
    serviceAccountEnc,
    delegatedAdmin,
    directorySync,
    contactsSync,
    ewsUrl,
    ewsAuth: input.ewsAuth ?? current?.ewsAuth ?? ('ntlm' as const),
    updatedBy: userId,
  };
  await db
    .insert(calendarIntegrations)
    .values({ orgId, provider, ...values })
    .onConflictDoUpdate({
      target: [calendarIntegrations.orgId, calendarIntegrations.provider],
      set: { ...values, updatedAt: new Date() },
    });
  return view(db, env, orgId, provider, await loadIntegration(db, orgId, provider));
}
