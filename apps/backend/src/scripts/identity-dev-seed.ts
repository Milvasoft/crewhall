/**
 * Connects a local Crewhall to the test identity systems of docker/compose.identity.yml
 * (docs/contracts/kimlik-entegrasyonu.md):
 *   pnpm --filter @crewhall/backend exec tsx --env-file=.env src/scripts/identity-dev-seed.ts
 * Adds a Keycloak (OIDC) provider, an OpenLDAP directory and a demo OIDC client for
 * src/scripts/oidc-demo-rp.ts. Runs after `pnpm seed`; existing entries are left alone.
 * Env: KEYCLOAK_ISSUER (default http://localhost:4980/realms/crewhall), LDAP_URL
 * (default ldap://localhost:4989), DEMO_RP_URL (default http://localhost:4950).
 */
import { and, eq } from 'drizzle-orm';
import { identityProviders, oidcClients, orgMembers, spaces } from '@crewhall/db';
import { loadEnv } from '../env';
import { build } from '../server';
import { primaryOrg } from '../services/brand';
import { createClient } from '../services/identity/oidc-clients';
import { createProvider } from '../services/identity/providers';

const req = { ip: null, userAgent: 'crewhall-identity-seed', locale: 'tr' };

const env = loadEnv();
const { deps, close } = await build(env);
try {
  const org = await primaryOrg(deps.db);
  if (!org) throw new Error('No org yet: run `pnpm --filter @crewhall/backend seed` first.');
  const [owner] = await deps.db
    .select()
    .from(orgMembers)
    .where(and(eq(orgMembers.organizationId, org.id), eq(orgMembers.role, 'owner')));
  if (!owner) throw new Error('org has no owner');
  const ctx = { orgId: org.id, userId: owner.userId };
  const shared = await deps.db
    .select()
    .from(spaces)
    .where(and(eq(spaces.orgId, org.id), eq(spaces.kind, 'shared')));
  const infra = shared.find((s) => s.slug === 'altyapi') ?? shared[0];
  const mappings = [
    { group: 'it-admins', orgRole: 'admin' as const },
    ...(infra ? [{ group: 'developers', spaceId: infra.id, spaceRole: 'editor' as const }] : []),
  ];
  const existing = await deps.db
    .select({ name: identityProviders.name })
    .from(identityProviders)
    .where(eq(identityProviders.orgId, org.id));
  const has = (name: string) => existing.some((p) => p.name === name);

  if (!has('Keycloak (test)')) {
    await createProvider(
      deps,
      ctx,
      {
        kind: 'oidc',
        preset: 'keycloak',
        name: 'Keycloak (test)',
        enabled: true,
        domains: ['kc.test'],
        enforceSso: true,
        jitProvisioning: true,
        defaultRole: 'member',
        linkExistingByEmail: true,
        trustIdpMfa: false,
        syncRoles: true,
        roleMappings: mappings,
        config: {
          issuer: process.env.KEYCLOAK_ISSUER ?? 'http://localhost:4980/realms/crewhall',
          clientId: 'crewhall',
          scopes: 'openid email profile',
          groupsClaim: 'groups',
          prompt: null,
          endSessionOnLogout: true,
        },
        clientSecret: 'keycloak-client-secret',
      },
      req,
    );
    console.log('+ Keycloak (test) OIDC provider');
  }
  if (!has('Şirket dizini (test)')) {
    await createProvider(
      deps,
      ctx,
      {
        kind: 'ldap',
        preset: 'openldap',
        name: 'Şirket dizini (test)',
        enabled: true,
        domains: ['crewhall.test'],
        enforceSso: false,
        jitProvisioning: true,
        defaultRole: 'member',
        linkExistingByEmail: true,
        trustIdpMfa: false,
        syncRoles: true,
        syncEnabled: true,
        roleMappings: mappings,
        config: {
          url: process.env.LDAP_URL ?? 'ldap://localhost:4989',
          startTls: false,
          caCert: null,
          tlsVerify: true,
          bindDn: 'cn=admin,dc=crewhall,dc=test',
          baseDn: 'ou=people,dc=crewhall,dc=test',
          userFilter: '(&(objectClass=inetOrgPerson)(|(uid={username})(mail={username})))',
          emailAttribute: 'mail',
          nameAttribute: 'displayName',
          uidAttribute: 'entryUUID',
          useMemberOf: false,
          groupBaseDn: 'ou=groups,dc=crewhall,dc=test',
          groupFilter: '(&(objectClass=groupOfNames)(member={dn}))',
          groupNameAttribute: 'cn',
          activeDirectory: false,
          timeoutMs: 8000,
        },
        bindPassword: 'ldap-admin-secret',
      },
      req,
    );
    console.log('+ Şirket dizini (test) LDAP directory');
  }
  const [demo] = await deps.db
    .select()
    .from(oidcClients)
    .where(eq(oidcClients.clientId, 'demo-app'));
  if (!demo) {
    const rp = (process.env.DEMO_RP_URL ?? 'http://localhost:4950').replace(/\/+$/, '');
    const created = await createClient(
      deps,
      ctx,
      {
        name: 'Demo uygulama',
        clientId: 'demo-app',
        type: 'web',
        homepageUrl: rp,
        logoUrl: null,
        redirectUris: [`${rp}/signin-oidc`],
        postLogoutRedirectUris: [`${rp}/`],
        scopes: ['openid', 'profile', 'email', 'groups', 'offline_access'],
        skipConsent: false,
        access: { kind: 'all' },
        guestsAllowed: false,
        secretMonths: 12,
      },
      req,
    );
    console.log('+ OIDC client demo-app');
    console.log(`  DEMO_CLIENT_SECRET=${created.clientSecret}`);
  } else {
    console.log('= OIDC client demo-app exists (rotate its secret in Yönetim › SSO uygulamaları)');
  }
} finally {
  await close();
}
