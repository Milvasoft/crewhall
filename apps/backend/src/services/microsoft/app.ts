import { and, count, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  driveMounts,
  identityProviders,
  microsoftApps,
  oidcClients,
  organizations,
  scimTokens,
  scimUsers,
  teamsLinks,
  type DbOrTx,
} from '@crewhall/db';
import {
  INTEGRATION_KEYS,
  MICROSOFT_RAW_PATHS,
  type IntegrationKey,
  type MicrosoftApp,
  type MicrosoftAppTest,
  type MicrosoftIntegrations,
  type OrgSettings,
  type ScimToken,
  type UpdateMicrosoftApp,
} from '@crewhall/shared';
import type { Deps } from '../../deps';
import type { Env } from '../../env';
import { AppError } from '../../http/errors';
import type { OrgRow, RequestInfo } from '../../http/types';
import { identityAudit } from '../identity/audit';
import { decryptSecret, encryptSecret, randomBase62 } from '../identity/crypto';
import { invalidateModules } from '../identity/modules';
import { appToken, GraphError, type AppCredentials } from './graph';

/**
 * Yönetim › Entegrasyonlar › Microsoft: the org's Entra app registration (Graph), the
 * integration switches (off until an admin turns them on) and the built-in OIDC clients the
 * Outlook add-in and the Teams app sign in with.
 */

export type AppRow = typeof microsoftApps.$inferSelect;
type Settings = Pick<OrgSettings, 'integrations'> | null | undefined;

export const integrationOn = (settings: Settings, key: IntegrationKey) =>
  settings?.integrations?.[key] === true;

export function requireIntegration(org: Pick<OrgRow, 'settings'>, key: IntegrationKey) {
  if (!integrationOn(org.settings, key)) throw new AppError('integration_disabled', { integration: key });
}

/** For raw routes (SCIM, Teams bot): the org row's switch, read fresh. */
export async function integrationEnabled(db: DbOrTx, orgId: string, key: IntegrationKey) {
  const [row] = await db
    .select({ settings: organizations.settings })
    .from(organizations)
    .where(eq(organizations.id, orgId));
  return row ? integrationOn(row.settings as OrgSettings, key) : false;
}

export async function loadApp(db: DbOrTx, orgId: string): Promise<AppRow | null> {
  const [row] = await db.select().from(microsoftApps).where(eq(microsoftApps.orgId, orgId));
  return row ?? null;
}

export function credentialsOf(env: Env, row: AppRow | null): AppCredentials {
  if (!row?.tenantId || !row.clientId || !row.secretEnc) throw new AppError('microsoft_app_missing');
  return {
    tenantId: row.tenantId,
    clientId: row.clientId,
    clientSecret: decryptSecret(env.AUTH_SECRET, row.secretEnc),
  };
}

export async function appCredentials(deps: Pick<Deps, 'db' | 'env'>, orgId: string) {
  return credentialsOf(deps.env, await loadApp(deps.db, orgId));
}

export function appView(row: AppRow | null): MicrosoftApp {
  return {
    tenantId: row?.tenantId ?? null,
    clientId: row?.clientId ?? null,
    secretSet: Boolean(row?.secretEnc),
    secretHint: row?.secretHint ?? null,
    lastTestAt: row?.lastTestAt?.toISOString() ?? null,
    lastTestOk: row?.lastTestOk ?? null,
    lastError: row?.lastError ?? null,
  };
}

export async function updateApp(
  deps: Pick<Deps, 'db' | 'env'>,
  ctx: { orgId: string; userId: string },
  input: UpdateMicrosoftApp,
  req: RequestInfo,
) {
  const existing = await loadApp(deps.db, ctx.orgId);
  if (!input.clientSecret && !existing?.secretEnc) {
    throw new AppError('validation_failed', {
      in: 'body',
      issues: [{ path: ['clientSecret'], code: 'required', message: 'clientSecret' }],
    });
  }
  const secret = input.clientSecret
    ? {
        secretEnc: encryptSecret(deps.env.AUTH_SECRET, input.clientSecret),
        secretHint: input.clientSecret.slice(-4),
      }
    : {};
  const values = {
    tenantId: input.tenantId,
    clientId: input.clientId,
    ...secret,
    // A new registration has not been tested yet.
    lastTestAt: null,
    lastTestOk: null,
    lastError: null,
    updatedBy: ctx.userId,
    updatedAt: new Date(),
  };
  const [row] = await deps.db
    .insert(microsoftApps)
    .values({ orgId: ctx.orgId, ...values })
    .onConflictDoUpdate({ target: microsoftApps.orgId, set: values })
    .returning();
  await identityAudit(
    deps.db,
    {
      orgId: ctx.orgId,
      actorId: ctx.userId,
      action: 'microsoft.app.update',
      targetType: 'org',
      targetId: ctx.orgId,
      meta: { tenantId: input.tenantId, clientId: input.clientId, secretChanged: !!input.clientSecret },
    },
    req,
  );
  return appView(row!);
}

/** Gets an app token; the roles in it are the Graph application permissions an admin granted. */
export async function testApp(deps: Pick<Deps, 'db' | 'env'>, orgId: string): Promise<MicrosoftAppTest> {
  const creds = await appCredentials(deps, orgId);
  let result: MicrosoftAppTest;
  try {
    const { roles } = await appToken(creds);
    result = { ok: true, roles, error: null };
  } catch (err) {
    const message =
      err instanceof GraphError ? `${err.code}: ${err.message}` : err instanceof Error ? err.message : String(err);
    result = { ok: false, roles: [], error: message.slice(0, 500) };
  }
  await deps.db
    .update(microsoftApps)
    .set({ lastTestAt: new Date(), lastTestOk: result.ok, lastError: result.error })
    .where(eq(microsoftApps.orgId, orgId));
  return result;
}

// ---- built-in OIDC clients of the add-in and the Teams app ------------------------------------

export const INTEGRATION_CLIENT_SCOPES = ['openid', 'profile', 'email', 'offline_access'];

export const officeCallbackUrl = (env: Env) => `${env.HUB_URL.replace(/\/+$/, '')}/office/callback`;

export async function integrationClient(db: DbOrTx, orgId: string, integration: 'outlook' | 'teams') {
  const [row] = await db
    .select()
    .from(oidcClients)
    .where(and(eq(oidcClients.orgId, orgId), eq(oidcClients.integration, integration)));
  return row ?? null;
}

/**
 * A public (PKCE) client per org and integration, redirecting to the web app's callback page.
 * Created the first time the integration is switched on; switching off disables it.
 */
export async function ensureIntegrationClient(
  db: DbOrTx,
  env: Env,
  ctx: { orgId: string; userId: string },
  integration: 'outlook' | 'teams',
  enabled: boolean,
) {
  const existing = await integrationClient(db, ctx.orgId, integration);
  const redirect = officeCallbackUrl(env);
  if (existing) {
    const [row] = await db
      .update(oidcClients)
      .set({
        enabled,
        redirectUris: [redirect],
        scopes: INTEGRATION_CLIENT_SCOPES,
        updatedAt: new Date(),
      })
      .where(eq(oidcClients.id, existing.id))
      .returning();
    return row!;
  }
  const [row] = await db
    .insert(oidcClients)
    .values({
      orgId: ctx.orgId,
      clientId: `crewhall-${integration}-${randomBase62(12).toLowerCase()}`,
      name: integration === 'outlook' ? 'Outlook' : 'Microsoft Teams',
      type: 'spa',
      homepageUrl: env.HUB_URL,
      redirectUris: [redirect],
      postLogoutRedirectUris: [],
      scopes: INTEGRATION_CLIENT_SCOPES,
      skipConsent: true,
      guestsAllowed: false,
      enabled,
      integration,
      createdBy: ctx.userId,
    })
    .returning();
  return row!;
}

// ---- switches and the overview ----------------------------------------------------------------

export async function setIntegration(
  deps: Pick<Deps, 'db' | 'env'>,
  ctx: { org: OrgRow; userId: string },
  key: IntegrationKey,
  input: { enabled: boolean; botAppId?: string | undefined },
  req: RequestInfo,
) {
  const orgId = ctx.org.id;
  await deps.db.transaction(async (tx) => {
    if (key === 'teams' && input.botAppId) {
      await tx
        .insert(microsoftApps)
        .values({ orgId, teamsBotAppId: input.botAppId, teamsAppId: crypto.randomUUID() })
        .onConflictDoUpdate({
          target: microsoftApps.orgId,
          set: {
            teamsBotAppId: input.botAppId,
            teamsAppId: sql`coalesce(${microsoftApps.teamsAppId}, gen_random_uuid())`,
            updatedAt: new Date(),
          },
        });
    }
    if (key === 'teams' && input.enabled) {
      const app = await loadApp(tx, orgId);
      if (!app?.teamsBotAppId) {
        throw new AppError('validation_failed', {
          in: 'body',
          issues: [{ path: ['botAppId'], code: 'required', message: 'botAppId' }],
        });
      }
    }
    if (key === 'outlook' || key === 'teams') {
      const has = await integrationClient(tx, orgId, key);
      if (input.enabled || has) {
        await ensureIntegrationClient(tx, deps.env, { orgId, userId: ctx.userId }, key, input.enabled);
      }
    }
    // Merge into the stored settings (another switch may have changed since the org was read).
    await tx
      .update(organizations)
      .set({
        settings: sql`jsonb_set(coalesce(${organizations.settings}, '{}'::jsonb), '{integrations}', coalesce(${organizations.settings}->'integrations', '{}'::jsonb) || ${JSON.stringify({ [key]: input.enabled })}::jsonb)`,
      })
      .where(eq(organizations.id, orgId));
    await identityAudit(
      tx,
      {
        orgId,
        actorId: ctx.userId,
        action: 'microsoft.integration.update',
        targetType: 'org',
        targetId: orgId,
        meta: { integration: key, enabled: input.enabled },
      },
      req,
    );
  });
  invalidateModules(orgId);
}

export async function scimTokenViews(db: DbOrTx, orgId: string): Promise<ScimToken[]> {
  const rows = await db
    .select({ token: scimTokens, providerName: identityProviders.name })
    .from(scimTokens)
    .innerJoin(identityProviders, eq(identityProviders.id, scimTokens.providerId))
    .where(and(eq(scimTokens.orgId, orgId), isNull(scimTokens.revokedAt)))
    .orderBy(scimTokens.createdAt);
  return rows.map(({ token, providerName }) => ({
    id: token.id,
    name: token.name,
    providerId: token.providerId,
    providerName,
    hint: token.hint,
    createdAt: token.createdAt.toISOString(),
    lastUsedAt: token.lastUsedAt?.toISOString() ?? null,
  }));
}

export async function overview(
  deps: Pick<Deps, 'db' | 'env'>,
  org: OrgRow,
): Promise<MicrosoftIntegrations> {
  const { db, env } = deps;
  const app = await loadApp(db, org.id);
  const providers = await db
    .select({
      id: identityProviders.id,
      name: identityProviders.name,
      preset: identityProviders.preset,
      enabled: identityProviders.enabled,
    })
    .from(identityProviders)
    .where(and(eq(identityProviders.orgId, org.id), inArray(identityProviders.kind, ['oidc', 'saml'])))
    .orderBy(sql`${identityProviders.preset} <> 'entra'`, identityProviders.name);
  const [provisioned] = await db
    .select({
      all: count(),
      off: sql<number>`count(*) filter (where not ${scimUsers.active} or ${scimUsers.deletedAt} is not null)`,
    })
    .from(scimUsers)
    .where(eq(scimUsers.orgId, org.id));
  const outlook = await integrationClient(db, org.id, 'outlook');
  const teams = await integrationClient(db, org.id, 'teams');
  const [linked] = await db.select({ n: count() }).from(teamsLinks).where(eq(teamsLinks.orgId, org.id));
  const [mounts] = await db.select({ n: count() }).from(driveMounts).where(eq(driveMounts.orgId, org.id));
  const api = env.API_URL.replace(/\/+$/, '');
  return {
    switches: Object.fromEntries(
      INTEGRATION_KEYS.map((k) => [k, integrationOn(org.settings, k)]),
    ) as Record<IntegrationKey, boolean>,
    app: appView(app),
    entra: {
      providers,
      scimUrl: `${api}${MICROSOFT_RAW_PATHS.scimBase}`,
      tokens: await scimTokenViews(db, org.id),
      provisioned: Number(provisioned?.all ?? 0),
      deactivated: Number(provisioned?.off ?? 0),
    },
    outlook: { clientId: outlook?.clientId ?? null },
    teams: {
      clientId: teams?.clientId ?? null,
      botAppId: app?.teamsBotAppId ?? null,
      messagingEndpoint: `${api}${MICROSOFT_RAW_PATHS.teamsMessages}`,
      linkedPeople: Number(linked?.n ?? 0),
    },
    storage: { mounts: Number(mounts?.n ?? 0) },
  };
}
