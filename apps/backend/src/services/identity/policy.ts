import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  identityPolicies,
  organizations,
  orgMembers,
  passkeys,
  users,
  type DbOrTx,
} from '@crewhall/db';
import {
  AUTH_LOCK,
  DEFAULT_SECURITY_POLICY,
  OidcProviderSettings,
  SecurityPolicy,
  type SecurityPolicyView,
  type UpdateSecurityPolicy,
} from '@crewhall/shared';
import type { Deps } from '../../deps';
import { AppError } from '../../http/errors';
import type { AuthSession, OrgRow, RequestInfo } from '../../http/types';
import { verifiedUntil } from '../mcp/reauth';
import { identityAudit } from './audit';
import { ipInRanges, validRange } from './ip';
import { invalidateModules } from './modules';

export const DEFAULT_OIDC_SETTINGS: OidcProviderSettings = {
  skipConsentForInternal: true,
  guestsAllowed: false,
};

interface Stored {
  security: SecurityPolicy;
  oidc: OidcProviderSettings;
}

const CACHE_MS = 10_000;
const cache = new Map<string, { at: number; value: Stored }>();

export function invalidatePolicy(orgId?: string) {
  if (orgId) cache.delete(orgId);
  else cache.clear();
  invalidateModules(orgId);
}

function merge(
  row: { security: Record<string, unknown>; oidc: Record<string, unknown> } | undefined,
  requireTwoFactor: boolean,
): Stored {
  const s = (row?.security ?? {}) as Partial<SecurityPolicy>;
  const d = DEFAULT_SECURITY_POLICY;
  const candidate = {
    twoFactor: { ...d.twoFactor, ...s.twoFactor, required: requireTwoFactor },
    password: { ...d.password, ...s.password },
    session: { ...d.session, ...s.session },
    ipAllowlist: { ...d.ipAllowlist, ...s.ipAllowlist },
  };
  const parsed = SecurityPolicy.safeParse(candidate);
  const oidc = OidcProviderSettings.safeParse({ ...DEFAULT_OIDC_SETTINGS, ...(row?.oidc ?? {}) });
  return {
    security: parsed.success
      ? parsed.data
      : { ...d, twoFactor: { ...d.twoFactor, required: requireTwoFactor } },
    oidc: oidc.success ? oidc.data : DEFAULT_OIDC_SETTINGS,
  };
}

/** Security policy and OIDC provider settings, cached 10 s per process (read on every request). */
export async function loadPolicy(db: DbOrTx, orgId: string): Promise<Stored> {
  const hit = cache.get(orgId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const [org] = await db
    .select({ settings: organizations.settings })
    .from(organizations)
    .where(eq(organizations.id, orgId));
  const [row] = await db.select().from(identityPolicies).where(eq(identityPolicies.orgId, orgId));
  const value = merge(row, org?.settings.requireTwoFactor ?? false);
  cache.set(orgId, { at: Date.now(), value });
  return value;
}

export const securityPolicy = async (db: DbOrTx, orgId: string) =>
  (await loadPolicy(db, orgId)).security;
export const oidcSettings = async (db: DbOrTx, orgId: string) => (await loadPolicy(db, orgId)).oidc;

// ---- re-verification (design 9: sensitive admin changes, "son 10 dakika") ----------------

export async function isVerified(deps: Pick<Deps, 'db'>, session: AuthSession) {
  return (await verifiedUntil(deps, session)) > Date.now();
}

export async function requireVerified(deps: Pick<Deps, 'db'>, session: AuthSession) {
  if (!(await isVerified(deps, session))) throw new AppError('identity_reauth_required');
}

// ---- view and update -------------------------------------------------------------------

async function twoFactorStatus(db: DbOrTx, orgId: string) {
  const members = await db
    .select({
      userId: users.id,
      name: users.name,
      email: users.email,
      totp: users.twoFactorEnabled,
    })
    .from(orgMembers)
    .innerJoin(users, eq(users.id, orgMembers.userId))
    .where(and(eq(orgMembers.organizationId, orgId), eq(orgMembers.status, 'active')));
  const ids = members.map((m) => m.userId);
  const withPasskey = ids.length
    ? new Set(
        (
          await db
            .selectDistinct({ userId: passkeys.userId })
            .from(passkeys)
            .where(inArray(passkeys.userId, ids))
        ).map((r) => r.userId),
      )
    : new Set<string>();
  const pending = members.filter((m) => !m.totp && !withPasskey.has(m.userId));
  return {
    enrolled: members.length - pending.length,
    total: members.length,
    pending: pending.map(({ userId, name, email }) => ({ userId, name, email })),
  };
}

export async function policyView(
  deps: Deps,
  org: OrgRow,
  session: AuthSession,
  ip: string | null,
): Promise<SecurityPolicyView> {
  invalidatePolicy(org.id);
  const { security } = await loadPolicy(deps.db, org.id);
  return {
    policy: security,
    status: {
      twoFactor: await twoFactorStatus(deps.db, org.id),
      currentIp: ip,
      lockout: { attempts: AUTH_LOCK.maxFailures, minutes: AUTH_LOCK.lockMinutes[0] },
      needsReauth: !(await isVerified(deps, session)),
    },
  };
}

export async function updatePolicy(
  deps: Deps,
  ctx: { org: OrgRow; userId: string; session: AuthSession },
  patch: UpdateSecurityPolicy,
  req: RequestInfo,
): Promise<SecurityPolicyView> {
  await requireVerified(deps, ctx.session);
  const before = await loadPolicy(deps.db, ctx.org.id);
  const next: SecurityPolicy = {
    twoFactor: { ...before.security.twoFactor, ...patch.twoFactor },
    password: { ...before.security.password, ...patch.password },
    session: { ...before.security.session, ...patch.session },
    ipAllowlist: { ...before.security.ipAllowlist, ...patch.ipAllowlist },
  };
  const parsed = SecurityPolicy.safeParse(next);
  if (!parsed.success)
    throw new AppError('validation_failed', { in: 'body', issues: parsed.error.issues });
  const bad = next.ipAllowlist.ranges.filter((r) => !validRange(r.cidr));
  if (bad.length) {
    throw new AppError('validation_failed', {
      in: 'body',
      issues: bad.map((r) => ({
        path: ['ipAllowlist', 'ranges'],
        code: 'invalid_cidr',
        message: r.cidr,
      })),
    });
  }
  // Do not let the administrator lock themselves out (9.11).
  if (next.ipAllowlist.enabled && !ipInRanges(req.ip, next.ipAllowlist.ranges)) {
    throw new AppError('ip_allowlist_self_lockout', { ip: req.ip });
  }

  const { required, ...twoFactorRest } = next.twoFactor;
  await deps.db.transaction(async (tx) => {
    await tx
      .insert(identityPolicies)
      .values({
        orgId: ctx.org.id,
        security: { ...next, twoFactor: twoFactorRest },
        updatedBy: ctx.userId,
      })
      .onConflictDoUpdate({
        target: identityPolicies.orgId,
        set: { security: { ...next, twoFactor: twoFactorRest }, updatedBy: ctx.userId },
      });
    if (required !== ctx.org.settings.requireTwoFactor) {
      await tx
        .update(organizations)
        .set({
          settings: sql`jsonb_set(${organizations.settings}, '{requireTwoFactor}', ${JSON.stringify(required)}::jsonb)`,
        })
        .where(eq(organizations.id, ctx.org.id));
    }
    await identityAudit(
      tx,
      {
        orgId: ctx.org.id,
        actorId: ctx.userId,
        action: 'identity.policy.update',
        targetType: 'org',
        targetId: ctx.org.id,
        meta: { before: before.security, after: next },
      },
      req,
    );
  });
  invalidatePolicy(ctx.org.id);
  const [org] = await deps.db.select().from(organizations).where(eq(organizations.id, ctx.org.id));
  return policyView(deps, org ?? ctx.org, ctx.session, req.ip);
}

export async function updateOidcSettings(
  deps: Deps,
  ctx: { orgId: string; userId: string },
  patch: Partial<OidcProviderSettings>,
  req: RequestInfo,
) {
  const before = await loadPolicy(deps.db, ctx.orgId);
  const oidc = { ...before.oidc, ...patch };
  await deps.db
    .insert(identityPolicies)
    .values({ orgId: ctx.orgId, oidc, updatedBy: ctx.userId })
    .onConflictDoUpdate({ target: identityPolicies.orgId, set: { oidc, updatedBy: ctx.userId } });
  await identityAudit(
    deps.db,
    {
      orgId: ctx.orgId,
      actorId: ctx.userId,
      action: 'oidc.settings.update',
      targetType: 'org',
      targetId: ctx.orgId,
      meta: { before: before.oidc, after: oidc },
    },
    req,
  );
  invalidatePolicy(ctx.orgId);
}
