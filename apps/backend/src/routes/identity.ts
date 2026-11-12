import { can, IDENTITY_RAW_PATHS } from '@crewhall/shared';
import type { Context } from 'hono';
import { requestInfo, type Router } from '../http/route';
import { AppError } from '../http/errors';
import type { AppEnv, AuthSession, OrgCtx } from '../http/types';
import { orgContext } from '../services/membership';
import { reauthWithPassword } from '../services/mcp/reauth';
import { take } from '../services/mcp/rate-limit';
import { identityAudit } from '../services/identity/audit';
import { syncDirectory } from '../services/identity/directory';
import { testDirectory } from '../services/identity/ldap';
import * as clients from '../services/identity/oidc-clients';
import { jwks } from '../services/identity/oidc-keys';
import * as op from '../services/identity/oidc-provider';
import {
  policyView,
  requireVerified,
  updateOidcSettings,
  updatePolicy,
} from '../services/identity/policy';
import * as providers from '../services/identity/providers';
import { discover } from '../services/identity/signin';
import * as sso from '../services/identity/sso';
import * as stepup from '../services/identity/stepup';
import { resolveRoles } from '../services/identity/provision';
import { LdapConfig, OidcIdpConfig, SamlIdpConfig, type IdpTestResult } from '@crewhall/shared';
import type { Deps } from '../deps';
import { opsDepsFromAppEnv } from '../ops/deps';
import { createExport, exportDownload, listExports } from '../services/compliance/ediscovery';
import { createHold, listHolds, releaseHold } from '../services/compliance/holds';
import { getCompliancePolicy, updateCompliancePolicy } from '../services/compliance/policy';
import { policyRefusal } from '../services/microsoft/entra';
import {
  backupOverview,
  pgToolsStatus,
  requireInstallAdmin,
  startBackup,
  updateBackupSettings,
} from '../services/backups/service';

function requireAdmin(ctx: Pick<OrgCtx<never>, 'actor' | 'org'>) {
  if (!can(ctx.actor, 'org.update_settings', { type: 'org', org: orgContext(ctx.org) })) {
    throw new AppError('forbidden');
  }
}

const who = (ctx: Pick<OrgCtx<never>, 'org' | 'user'>) => ({
  orgId: ctx.org.id,
  userId: ctx.user.id,
});

/** Standards endpoints may be called from other origins (SPA clients, IdP discovery tools). */
function openCors(c: Context<AppEnv>) {
  c.header('Access-Control-Allow-Origin', '*');
  c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  c.header('Access-Control-Max-Age', '600');
}

async function runTest(
  deps: Deps,
  orgId: string,
  input: { providerId?: string | undefined; draft?: unknown; username?: string | undefined },
): Promise<IdpTestResult> {
  const saved = input.providerId
    ? await providers.getProvider(deps.db, orgId, input.providerId)
    : null;
  const draft = input.draft as
    | { kind: 'oidc'; config: unknown; clientSecret?: string }
    | { kind: 'saml'; config: unknown }
    | { kind: 'ldap'; config: unknown; bindPassword?: string }
    | undefined;
  const kind = draft?.kind ?? saved?.kind;
  if (!kind) throw new AppError('bad_request');
  if (saved && draft && saved.kind !== draft.kind) throw new AppError('idp_kind_mismatch');
  const storedSecret = saved ? providers.secretOf(deps.env, saved) : null;
  let result: IdpTestResult;
  if (kind === 'ldap') {
    const config = LdapConfig.parse(draft?.config ?? saved!.config);
    const secret = (draft && 'bindPassword' in draft && draft.bindPassword) || storedSecret;
    const r = await testDirectory(config, secret, input.username);
    const mappings = saved ? providers.mappingsOf(saved) : [];
    const draftMappings = (input.draft as { roleMappings?: typeof mappings } | undefined)
      ?.roleMappings;
    const roles = r.user ? resolveRoles(draftMappings ?? mappings, r.user.groups) : null;
    result = {
      ok: r.ok,
      steps: r.steps,
      user: r.user
        ? {
            dn: r.user.dn,
            email: r.user.email,
            name: r.user.name,
            uid: r.user.uid,
            groups: r.user.groups,
            disabled: r.user.disabled,
            orgRole: roles?.orgRole ?? null,
            spaces: roles ? [...roles.spaces].map(([spaceId, role]) => ({ spaceId, role })) : [],
          }
        : null,
    };
  } else if (kind === 'oidc') {
    const config = OidcIdpConfig.parse(draft?.config ?? saved!.config);
    const secret = (draft && 'clientSecret' in draft && draft.clientSecret) || storedSecret;
    result = await sso.testOidc(deps.env, config, secret);
  } else {
    result = sso.testSaml(deps.env, SamlIdpConfig.parse(draft?.config ?? saved!.config));
  }
  if (saved) {
    const failed = result.steps.find((s) => !s.ok);
    await providers.recordTest(
      deps.db,
      saved.id,
      result.ok,
      failed ? `${failed.key}: ${failed.detail ?? ''}` : null,
    );
  }
  return result;
}

/** Identity module: external sign-in, security policy, Crewhall as OIDC provider (design 9.11-9.14). */
export function registerIdentity(r: Router): void {
  // ---- login screen --------------------------------------------------------------------
  r.public('discoverSignIn', async ({ deps, body, req }) => {
    if (req.ip) {
      const limit = await take(deps.db, `ip:${req.ip}`, {
        kind: 'identity_discover',
        perMinute: 30,
      });
      if (!limit.allowed) throw new AppError('rate_limited', { retryAfter: limit.retryAfter });
    }
    return discover(deps.db, body.email);
  });

  r.user('getSsoLogoutTarget', async ({ deps, session, query }) => ({
    url: await sso.logoutTarget(deps, session.id, query.postLogoutUrl),
  }));

  // ---- identity providers (Yönetim › Entegrasyonlar) -----------------------------------
  r.org('listIdentityProviders', async (ctx) => {
    requireAdmin(ctx);
    const rows = await providers.listProviders(ctx.deps.db, ctx.org.id);
    return {
      items: await Promise.all(rows.map((row) => providers.toView(ctx.deps.db, ctx.deps.env, row))),
    };
  });

  r.org('getIdentityProvider', async (ctx) => {
    requireAdmin(ctx);
    const row = await providers.getProvider(ctx.deps.db, ctx.org.id, ctx.params.providerId);
    return providers.toView(ctx.deps.db, ctx.deps.env, row);
  });

  r.org(
    'createIdentityProvider',
    async (ctx) => {
      requireAdmin(ctx);
      const row = await providers.createProvider(ctx.deps, who(ctx), ctx.body, ctx.req);
      return providers.toView(ctx.deps.db, ctx.deps.env, row);
    },
    { status: 201 },
  );

  r.org('updateIdentityProvider', async (ctx) => {
    requireAdmin(ctx);
    const row = await providers.updateProvider(
      ctx.deps,
      who(ctx),
      ctx.params.providerId,
      ctx.body,
      ctx.req,
    );
    return providers.toView(ctx.deps.db, ctx.deps.env, row);
  });

  r.org('deleteIdentityProvider', async (ctx) => {
    requireAdmin(ctx);
    await providers.deleteProvider(ctx.deps, who(ctx), ctx.params.providerId, ctx.req);
    return {};
  });

  r.org('testIdentityProvider', async (ctx) => {
    requireAdmin(ctx);
    return runTest(ctx.deps, ctx.org.id, ctx.body);
  });

  r.org('syncIdentityProvider', async (ctx) => {
    requireAdmin(ctx);
    const row = await providers.getProvider(ctx.deps.db, ctx.org.id, ctx.params.providerId);
    if (row.kind !== 'ldap') throw new AppError('idp_kind_mismatch');
    return syncDirectory(ctx.deps, row as typeof row & { kind: 'ldap' }, ctx.user.id);
  });

  r.org('listLinkedIdentities', async (ctx) => {
    requireAdmin(ctx);
    return providers.listLinked(ctx.deps.db, ctx.org.id, ctx.params.providerId, ctx.query);
  });

  // ---- security policy (9.11) ----------------------------------------------------------
  r.org('getSecurityPolicy', async (ctx) => {
    requireAdmin(ctx);
    return policyView(ctx.deps, ctx.org, ctx.session, ctx.req.ip);
  });

  r.org('updateSecurityPolicy', async (ctx) => {
    requireAdmin(ctx);
    return updatePolicy(
      ctx.deps,
      { org: ctx.org, userId: ctx.user.id, session: ctx.session },
      ctx.body,
      ctx.req,
    );
  });

  // ---- backups (roadmap 3): the install admin only ------------------------------------
  const overview = (deps: Deps) => {
    const ops = opsDepsFromAppEnv(deps.env);
    return backupOverview(deps.db, ops.repo, new Date(), () =>
      pgToolsStatus(ops.pg, ops.databaseUrl),
    );
  };
  r.org('getBackups', async (ctx) => {
    await requireInstallAdmin(ctx.deps.db, ctx.org.id, ctx.member.role);
    return overview(ctx.deps);
  });

  r.org('updateBackupSettings', async (ctx) => {
    await requireInstallAdmin(ctx.deps.db, ctx.org.id, ctx.member.role);
    await updateBackupSettings(ctx.deps.db, who(ctx), ctx.body, requestInfo(ctx.c));
    return overview(ctx.deps);
  });

  r.org('startBackup', async (ctx) => {
    await requireInstallAdmin(ctx.deps.db, ctx.org.id, ctx.member.role);
    return startBackup(ctx.deps, who(ctx), requestInfo(ctx.c));
  });

  // ---- compliance (roadmap 25): org owners and admins ---------------------------------
  const complianceView = async (deps: Deps, orgId: string) => ({
    policy: await getCompliancePolicy(deps.db, orgId),
    holds: await listHolds(deps.db, orgId),
    exports: await listExports(deps.db, orgId),
  });
  r.org('getCompliance', async (ctx) => {
    requireAdmin(ctx);
    return complianceView(ctx.deps, ctx.org.id);
  });

  r.org('updateCompliancePolicy', async (ctx) => {
    requireAdmin(ctx);
    await updateCompliancePolicy(ctx.deps.db, who(ctx), ctx.body, requestInfo(ctx.c));
    return complianceView(ctx.deps, ctx.org.id);
  });

  r.org('createLegalHold', async (ctx) => {
    requireAdmin(ctx);
    return createHold(ctx.deps.db, who(ctx), ctx.body, requestInfo(ctx.c));
  });

  r.org('releaseLegalHold', async (ctx) => {
    requireAdmin(ctx);
    return releaseHold(ctx.deps.db, who(ctx), ctx.params.holdId, requestInfo(ctx.c));
  });

  r.org('createEdiscoveryExport', async (ctx) => {
    requireAdmin(ctx);
    return createExport(ctx.deps, who(ctx), ctx.body, requestInfo(ctx.c));
  });

  r.org('getEdiscoveryDownload', async (ctx) => {
    requireAdmin(ctx);
    return exportDownload(ctx.deps, who(ctx), ctx.params.exportId, requestInfo(ctx.c));
  });

  // ---- step-up without a password: passkey and trusted device key ---------------------
  const stepUp = (ctx: { org: { id: string }; user: { id: string }; session: AuthSession }) => ({
    orgId: ctx.org.id,
    userId: ctx.user.id,
    session: ctx.session,
  });
  r.org('getReauthMethods', (ctx) => stepup.reauthMethods(ctx.deps.db, stepUp(ctx)));
  r.org('reauthPasskeyOptions', (ctx) => stepup.passkeyOptions(ctx.deps, stepUp(ctx)));
  r.org('reauthPasskeyVerify', (ctx) =>
    stepup.passkeyVerify(ctx.deps, stepUp(ctx), ctx.body, ctx.req),
  );
  r.org('registerDeviceKey', (ctx) =>
    stepup.registerDeviceKey(ctx.deps.db, stepUp(ctx), ctx.body, ctx.req),
  );
  r.org('listDeviceKeys', (ctx) => stepup.listDeviceKeys(ctx.deps.db, stepUp(ctx)));
  r.org('deleteDeviceKey', async (ctx) => {
    await stepup.deleteDeviceKey(ctx.deps.db, stepUp(ctx), ctx.params.keyId, ctx.req);
    return {};
  });
  r.org('reauthDeviceOptions', (ctx) =>
    stepup.deviceOptions(ctx.deps.db, stepUp(ctx), ctx.body.keyId),
  );
  r.org('reauthDeviceVerify', (ctx) =>
    stepup.deviceVerify(ctx.deps.db, stepUp(ctx), ctx.body, ctx.req),
  );

  r.org('identityReauth', async (ctx) => {
    try {
      const until = await reauthWithPassword(
        ctx.deps,
        { orgId: ctx.org.id, userId: ctx.user.id, session: ctx.session },
        ctx.body.password,
      );
      await identityAudit(
        ctx.deps.db,
        {
          orgId: ctx.org.id,
          actorId: ctx.user.id,
          action: 'identity.reauth',
          targetType: 'session',
          targetId: ctx.session.id,
        },
        ctx.req,
      );
      return { verifiedUntil: until.toISOString() };
    } catch (err) {
      if (err instanceof AppError && err.code === 'mcp_password_invalid') {
        throw new AppError('identity_password_invalid');
      }
      throw err;
    }
  });

  // ---- OIDC provider admin (9.12, 9.13) ------------------------------------------------
  r.org('getOidcProvider', async (ctx) => {
    requireAdmin(ctx);
    return clients.providerInfo(ctx.deps, ctx.org.id);
  });

  r.org('updateOidcProviderSettings', async (ctx) => {
    requireAdmin(ctx);
    await updateOidcSettings(ctx.deps, who(ctx), ctx.body, ctx.req);
    return clients.providerInfo(ctx.deps, ctx.org.id);
  });

  r.org('rotateOidcSigningKey', async (ctx) => {
    requireAdmin(ctx);
    await requireVerified(ctx.deps, ctx.session);
    await clients.rotateSigningKey(ctx.deps, who(ctx), ctx.req);
    return clients.providerInfo(ctx.deps, ctx.org.id);
  });

  r.org(
    'createOidcClient',
    async (ctx) => {
      requireAdmin(ctx);
      return clients.createClient(ctx.deps, who(ctx), ctx.body, ctx.req);
    },
    { status: 201 },
  );

  r.org('updateOidcClient', async (ctx) => {
    requireAdmin(ctx);
    return clients.updateClient(ctx.deps, who(ctx), ctx.params.oidcClientId, ctx.body, ctx.req);
  });

  r.org('deleteOidcClient', async (ctx) => {
    requireAdmin(ctx);
    await clients.deleteClient(ctx.deps, who(ctx), ctx.params.oidcClientId, ctx.req);
    return {};
  });

  r.org('rotateOidcClientSecret', async (ctx) => {
    requireAdmin(ctx);
    await requireVerified(ctx.deps, ctx.session);
    return clients.rotateClientSecret(ctx.deps, who(ctx), ctx.params.oidcClientId, ctx.req);
  });

  // ---- consent page (/sso/consent) --------------------------------------------------------
  const consentCtx = (ctx: OrgCtx<never>) => ({
    deps: ctx.deps,
    org: ctx.org,
    member: ctx.member,
    user: ctx.user,
    session: ctx.session,
  });

  r.org('getOidcConsent', async (ctx) =>
    op.getConsent(consentCtx(ctx as OrgCtx<never>), ctx.query),
  );
  r.org('approveOidcConsent', async (ctx) =>
    op.approveConsent(
      consentCtx(ctx as OrgCtx<never>),
      ctx.body,
      ctx.c.req.header('origin'),
      ctx.c,
    ),
  );
  r.org('denyOidcConsent', async (ctx) =>
    op.denyConsent(consentCtx(ctx as OrgCtx<never>), ctx.body, ctx.c.req.header('origin')),
  );

  // ---- inbound SSO browser routes ------------------------------------------------------
  r.rawPublic('GET', IDENTITY_RAW_PATHS.ssoStart(':providerId'), async ({ c, deps }) => {
    const errorTarget = sso.safeWebTarget(deps.env, c.req.query('errorCallbackURL'), '/login');
    const callback = sso.safeWebTarget(deps.env, c.req.query('callbackURL'), '/');
    const row = await providers
      .findProvider(deps.db, c.req.param('providerId') ?? '')
      .catch(() => null);
    if (!row || !row.enabled || row.kind === 'ldap')
      return c.redirect(sso.withError(errorTarget, 'sso_login_failed'), 302);
    try {
      const url =
        row.kind === 'oidc'
          ? await sso.startOidc(deps, row as typeof row & { kind: 'oidc' }, {
              callbackUrl: callback,
              errorCallbackUrl: errorTarget,
              loginHint: c.req.query('loginHint'),
            })
          : await sso.startSaml(deps, row as typeof row & { kind: 'saml' }, {
              callbackUrl: callback,
              errorCallbackUrl: errorTarget,
            });
      return c.redirect(url, 302);
    } catch (err) {
      const code = err instanceof AppError ? err.code : 'idp_unavailable';
      if (!(err instanceof AppError))
        deps.logger.warn({ err, provider: row.id }, 'SSO start failed');
      return c.redirect(sso.withError(errorTarget, code), 302);
    }
  });

  r.rawPublic('GET', IDENTITY_RAW_PATHS.ssoCallback(':providerId'), async ({ c, deps }) => {
    const req = requestInfo(c);
    const row = await providers
      .findProvider(deps.db, c.req.param('providerId') ?? '')
      .catch(() => null);
    const state = row ? await sso.stateForCallback(deps.db, row.id, c.req.query('state')) : null;
    const errorTarget = state?.errorCallbackUrl ?? sso.safeWebTarget(deps.env, undefined, '/login');
    if (!row || row.kind !== 'oidc' || !row.enabled || !state) {
      await sso.auditFailure(deps, row, 'invalid_state', req);
      return c.redirect(sso.withError(errorTarget, 'sso_login_failed'), 302);
    }
    if (c.req.query('error')) {
      await sso.auditFailure(deps, row, `idp:${c.req.query('error')}`, req);
      // Entra conditional access and app assignment refusals get their own message.
      const blocked = policyRefusal(c.req.query('error'), c.req.query('error_description'));
      return c.redirect(
        sso.withError(errorTarget, blocked ? 'sso_blocked_by_policy' : 'sso_login_failed'),
        302,
      );
    }
    try {
      const target = await sso.completeOidc(
        deps,
        c,
        row as typeof row & { kind: 'oidc' },
        state,
        req,
      );
      return c.redirect(target, 302);
    } catch (err) {
      const code = err instanceof AppError ? err.code : 'sso_login_failed';
      if (!(err instanceof AppError))
        deps.logger.error({ err, provider: row.id }, 'SSO callback failed');
      await sso.auditFailure(deps, row, code, req);
      return c.redirect(sso.withError(errorTarget, code), 302);
    }
  });

  r.rawPublic('POST', IDENTITY_RAW_PATHS.samlAcs(':providerId'), async ({ c, deps }) => {
    const req = requestInfo(c);
    const form = Object.fromEntries(
      Object.entries(await c.req.parseBody()).filter(
        (e): e is [string, string] => typeof e[1] === 'string',
      ),
    );
    const row = await providers
      .findProvider(deps.db, c.req.param('providerId') ?? '')
      .catch(() => null);
    const state = row ? await sso.stateForCallback(deps.db, row.id, form.RelayState) : null;
    const errorTarget = state?.errorCallbackUrl ?? sso.safeWebTarget(deps.env, undefined, '/login');
    if (!row || row.kind !== 'saml' || !row.enabled || !state) {
      await sso.auditFailure(deps, row, 'invalid_state', req);
      return c.redirect(sso.withError(errorTarget, 'sso_login_failed'), 302);
    }
    try {
      const target = await sso.completeSaml(
        deps,
        c,
        row as typeof row & { kind: 'saml' },
        state,
        form,
        req,
      );
      return c.redirect(target, 302);
    } catch (err) {
      const code = err instanceof AppError ? err.code : 'sso_login_failed';
      if (!(err instanceof AppError))
        deps.logger.error({ err, provider: row.id }, 'SAML callback failed');
      await sso.auditFailure(deps, row, code, req);
      return c.redirect(sso.withError(errorTarget, code), 302);
    }
  });

  r.rawPublic('GET', IDENTITY_RAW_PATHS.samlMetadata(':providerId'), async ({ c, deps }) => {
    const row = await providers
      .findProvider(deps.db, c.req.param('providerId') ?? '')
      .catch(() => null);
    if (!row || row.kind !== 'saml') throw new AppError('not_found');
    c.header('Content-Type', 'application/samlmetadata+xml; charset=utf-8');
    return c.body(sso.samlMetadata(deps.env, row as typeof row & { kind: 'saml' }));
  });

  // ---- Crewhall as OpenID Connect provider ---------------------------------------------
  const cached = (seconds: number) => (c: Context<AppEnv>) => {
    openCors(c);
    c.header('Cache-Control', `public, max-age=${seconds}`);
  };
  for (const method of ['OPTIONS'] as const) {
    for (const path of [
      IDENTITY_RAW_PATHS.oidcDiscovery,
      IDENTITY_RAW_PATHS.oidcJwks,
      IDENTITY_RAW_PATHS.oidcToken,
      IDENTITY_RAW_PATHS.oidcUserinfo,
      IDENTITY_RAW_PATHS.oidcRevoke,
    ]) {
      r.rawPublic(method, path, async ({ c }) => {
        openCors(c);
        return c.body(null, 204);
      });
    }
  }
  r.rawPublic('GET', IDENTITY_RAW_PATHS.oidcDiscovery, async ({ c, deps }) => {
    cached(300)(c);
    return c.json(op.discoveryDocument(deps.env));
  });
  r.rawPublic('GET', IDENTITY_RAW_PATHS.oidcJwks, async ({ c, deps }) => {
    cached(300)(c);
    return c.json(await jwks(deps.db));
  });
  r.rawPublic('GET', IDENTITY_RAW_PATHS.oidcAuthorize, ({ c, deps }) =>
    op.handleAuthorize(c, deps),
  );
  r.rawPublic('POST', IDENTITY_RAW_PATHS.oidcToken, async ({ c, deps }) => {
    openCors(c);
    return op.handleToken(c, deps);
  });
  for (const method of ['GET', 'POST'] as const) {
    r.rawPublic(method, IDENTITY_RAW_PATHS.oidcUserinfo, async ({ c, deps }) => {
      openCors(c);
      return op.handleUserinfo(c, deps);
    });
    r.rawPublic(method, IDENTITY_RAW_PATHS.oidcEndSession, ({ c, deps }) =>
      op.handleEndSession(c, deps),
    );
  }
  r.rawPublic('POST', IDENTITY_RAW_PATHS.oidcRevoke, async ({ c, deps }) => {
    openCors(c);
    return op.handleRevoke(c, deps);
  });
}
