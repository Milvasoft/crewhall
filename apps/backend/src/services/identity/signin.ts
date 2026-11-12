import { createHash } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import { identityProviders, orgMembers, users, type DbOrTx } from '@crewhall/db';
import type { PublicBootstrap, SecurityPolicy, SignInDiscovery } from '@crewhall/shared';
import type { Logger } from '../../logger';
import { primaryOrg } from '../brand';
import { securityPolicy } from './policy';
import { domainOf, providersForDomain } from './providers';

/** What the login screen offers (PublicBootstrap.auth additions). */
export async function signInOptions(
  db: DbOrTx,
  orgId: string,
): Promise<Pick<PublicBootstrap['auth'], 'password' | 'ldap' | 'sso' | 'passkey'>> {
  const policy = await securityPolicy(db, orgId);
  const rows = await db
    .select({
      id: identityProviders.id,
      name: identityProviders.name,
      kind: identityProviders.kind,
    })
    .from(identityProviders)
    .where(and(eq(identityProviders.orgId, orgId), eq(identityProviders.enabled, true)))
    .orderBy(asc(identityProviders.position), asc(identityProviders.createdAt));
  const ldap = rows.find((r) => r.kind === 'ldap');
  return {
    passkey: policy.twoFactor.passkeyEnabled,
    password: policy.password.localLogin,
    ldap: ldap ? { label: ldap.name } : null,
    sso: rows
      .filter((r): r is typeof r & { kind: 'oidc' | 'saml' } => r.kind !== 'ldap')
      .map((r) => ({ id: r.id, name: r.name, kind: r.kind })),
  };
}

/** Login screen discovery: depends on the e-mail domain only, never on whether an account exists. */
export async function discover(db: DbOrTx, email: string): Promise<SignInDiscovery> {
  const domain = domainOf(email);
  const rows = domain ? await providersForDomain(db, domain) : [];
  const sso = rows.find((r) => r.kind !== 'ldap');
  const enforced = rows.find((r) => r.kind !== 'ldap' && r.enforceSso);
  const provider = enforced ?? sso;
  return {
    method: enforced ? 'sso' : 'password',
    provider: provider
      ? { id: provider.id, name: provider.name, kind: provider.kind as 'oidc' | 'saml' }
      : null,
    ldap: rows.some((r) => r.kind === 'ldap'),
  };
}

/** Orgs a sign-in by this e-mail is judged against: its memberships, else the installation's org. */
export async function orgsForEmail(db: DbOrTx, email: string) {
  const rows = await db
    .select({ orgId: orgMembers.organizationId, role: orgMembers.role, status: orgMembers.status })
    .from(orgMembers)
    .innerJoin(users, eq(users.id, orgMembers.userId))
    .where(sql`${users.email} = ${email}`);
  if (rows.length) return rows;
  const org = await primaryOrg(db);
  return org ? [{ orgId: org.id, role: null, status: null }] : [];
}

export async function orgsForUser(db: DbOrTx, userId: string) {
  const rows = await db
    .select({ orgId: orgMembers.organizationId, role: orgMembers.role, status: orgMembers.status })
    .from(orgMembers)
    .where(eq(orgMembers.userId, userId));
  if (rows.length) return rows;
  const org = await primaryOrg(db);
  return org ? [{ orgId: org.id, role: null, status: null }] : [];
}

/**
 * Local password sign-in check (design: SSO-enforced domains, "şifreyle giriş kapalı").
 * Owners always keep the local password as the break-glass login.
 */
export async function passwordSignInBlock(
  db: DbOrTx,
  email: string,
): Promise<
  { code: 'SSO_REQUIRED'; providerId: string } | { code: 'PASSWORD_LOGIN_DISABLED' } | null
> {
  const orgs = await orgsForEmail(db, email);
  if (orgs.some((o) => o.role === 'owner')) return null;
  const domain = domainOf(email);
  if (domain) {
    const enforced = (await providersForDomain(db, domain)).find(
      (p) => p.kind !== 'ldap' && p.enforceSso && orgs.some((o) => o.orgId === p.orgId),
    );
    if (enforced) return { code: 'SSO_REQUIRED', providerId: enforced.id };
  }
  if (!orgs.length) return null;
  const policies = await Promise.all(orgs.map((o) => securityPolicy(db, o.orgId)));
  if (policies.every((p) => !p.password.localLogin)) return { code: 'PASSWORD_LOGIN_DISABLED' };
  return null;
}

/** The strictest of several org policies (a person may belong to more than one org). */
export async function strictestPolicy(
  db: DbOrTx,
  orgIds: string[],
): Promise<SecurityPolicy | null> {
  if (!orgIds.length) return null;
  const list = await Promise.all(orgIds.map((id) => securityPolicy(db, id)));
  return list.reduce((a, b) => ({
    twoFactor: {
      required: a.twoFactor.required || b.twoFactor.required,
      passkeyEnabled: a.twoFactor.passkeyEnabled && b.twoFactor.passkeyEnabled,
      rememberDevice: a.twoFactor.rememberDevice && b.twoFactor.rememberDevice,
    },
    password: {
      localLogin: a.password.localLogin && b.password.localLogin,
      minLength: Math.max(a.password.minLength, b.password.minLength),
      breachCheck: a.password.breachCheck || b.password.breachCheck,
    },
    session: {
      hours: Math.min(a.session.hours, b.session.hours),
      rememberDays: Math.min(a.session.rememberDays, b.session.rememberDays),
    },
    ipAllowlist: a.ipAllowlist,
  }));
}

/**
 * Have I Been Pwned range query (k-anonymity: only the first 5 hex characters of the SHA-1
 * leave the server). Fails open: an unreachable service never blocks a password change.
 */
export async function isBreached(password: string, logger?: Logger): Promise<boolean> {
  const sha1 = createHash('sha1').update(password).digest('hex').toUpperCase();
  const prefix = sha1.slice(0, 5);
  const suffix = sha1.slice(5);
  try {
    const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
      headers: { 'Add-Padding': 'true', 'User-Agent': 'Crewhall' },
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) return false;
    const text = await res.text();
    return text.split('\n').some((line) => {
      const [hash, count] = line.trim().split(':');
      return hash === suffix && Number(count) > 0;
    });
  } catch (err) {
    logger?.warn({ err }, 'password breach check unavailable');
    return false;
  }
}

/** The installation's org (single-tenant); checks that run before the person is known use it. */
export async function installationOrgIds(db: DbOrTx) {
  const org = await primaryOrg(db);
  return org ? [org.id] : [];
}
