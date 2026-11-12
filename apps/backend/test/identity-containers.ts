import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { Client as LdapClient } from 'ldapts';

/**
 * Real identity systems for the identity tests: OpenLDAP (osixia/openldap, MIT) and
 * Keycloak (Apache-2.0). Both start per test file and are stopped in afterAll.
 */

export const LDAP_BASE = 'dc=crewhall,dc=test';
export const LDAP_ADMIN = `cn=admin,${LDAP_BASE}`;
export const LDAP_ADMIN_PASSWORD = 'ldap-admin-secret';

export interface DirectoryPerson {
  uid: string;
  cn: string;
  sn: string;
  mail: string;
  password: string;
}

export async function startOpenLdap() {
  const container = await new GenericContainer('osixia/openldap:1.5.0')
    .withEnvironment({
      LDAP_ORGANISATION: 'Crewhall Test',
      LDAP_DOMAIN: 'crewhall.test',
      LDAP_ADMIN_PASSWORD,
      LDAP_TLS: 'false',
    })
    .withExposedPorts(389)
    .withWaitStrategy(Wait.forLogMessage(/slapd starting/))
    .withStartupTimeout(120_000)
    .start();
  const url = `ldap://${container.getHost()}:${container.getMappedPort(389)}`;
  // slapd logs "starting" a moment before it accepts binds.
  for (let i = 0; i < 30; i++) {
    try {
      await withAdmin(url, async () => undefined);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return { container, url };
}

export async function withAdmin<T>(url: string, fn: (c: LdapClient) => Promise<T>) {
  const client = new LdapClient({ url, timeout: 5000, connectTimeout: 5000 });
  try {
    await client.bind(LDAP_ADMIN, LDAP_ADMIN_PASSWORD);
    return await fn(client);
  } finally {
    await client.unbind().catch(() => undefined);
  }
}

export async function seedDirectory(
  url: string,
  people: DirectoryPerson[],
  groups: Record<string, string[]>,
) {
  await withAdmin(url, async (c) => {
    for (const ou of ['people', 'groups']) {
      await c.add(`ou=${ou},${LDAP_BASE}`, { objectClass: 'organizationalUnit', ou });
    }
    for (const p of people) {
      await c.add(`uid=${p.uid},ou=people,${LDAP_BASE}`, {
        objectClass: ['inetOrgPerson'],
        uid: p.uid,
        cn: p.cn,
        sn: p.sn,
        displayName: p.cn,
        mail: p.mail,
        userPassword: p.password,
      });
    }
    for (const [cn, members] of Object.entries(groups)) {
      await c.add(`cn=${cn},ou=groups,${LDAP_BASE}`, {
        objectClass: 'groupOfNames',
        cn,
        member: members.map((uid) => `uid=${uid},ou=people,${LDAP_BASE}`),
      });
    }
  });
}

export const KEYCLOAK_REALM = 'crewhall';
export const KEYCLOAK_CLIENT = 'crewhall';
export const KEYCLOAK_SECRET = 'keycloak-client-secret';

export interface KeycloakUser {
  username: string;
  email: string;
  firstName: string;
  lastName: string;
  password: string;
  groups: string[];
}

export async function startKeycloak(redirectBase: string, users: KeycloakUser[]) {
  const realm = {
    realm: KEYCLOAK_REALM,
    enabled: true,
    sslRequired: 'none',
    groups: [...new Set(users.flatMap((u) => u.groups))].map((name) => ({ name })),
    clients: [
      {
        clientId: KEYCLOAK_CLIENT,
        enabled: true,
        protocol: 'openid-connect',
        publicClient: false,
        secret: KEYCLOAK_SECRET,
        standardFlowEnabled: true,
        directAccessGrantsEnabled: false,
        redirectUris: [`${redirectBase}/*`],
        attributes: { 'post.logout.redirect.uris': '+', 'pkce.code.challenge.method': 'S256' },
        protocolMappers: [
          {
            name: 'groups',
            protocol: 'openid-connect',
            protocolMapper: 'oidc-group-membership-mapper',
            config: {
              'full.path': 'false',
              'id.token.claim': 'true',
              'access.token.claim': 'true',
              'userinfo.token.claim': 'true',
              'claim.name': 'groups',
            },
          },
        ],
      },
    ],
    users: users.map((u) => ({
      username: u.username,
      email: u.email,
      emailVerified: true,
      firstName: u.firstName,
      lastName: u.lastName,
      enabled: true,
      requiredActions: [],
      credentials: [{ type: 'password', value: u.password, temporary: false }],
      groups: u.groups.map((g) => `/${g}`),
    })),
  };
  const container = await new GenericContainer('quay.io/keycloak/keycloak:26.0.7')
    .withEnvironment({
      KC_BOOTSTRAP_ADMIN_USERNAME: 'admin',
      KC_BOOTSTRAP_ADMIN_PASSWORD: 'admin',
      KC_HEALTH_ENABLED: 'true',
    })
    .withCopyContentToContainer([
      { content: JSON.stringify(realm), target: '/opt/keycloak/data/import/crewhall-realm.json' },
    ])
    .withCommand(['start-dev', '--import-realm'])
    .withExposedPorts(8080)
    .withWaitStrategy(
      Wait.forHttp(`/realms/${KEYCLOAK_REALM}/.well-known/openid-configuration`, 8080),
    )
    .withStartupTimeout(240_000)
    .start();
  const base = `http://${container.getHost()}:${container.getMappedPort(8080)}`;
  return { container, base, issuer: `${base}/realms/${KEYCLOAK_REALM}` };
}

/** Minimal cookie-keeping browser for the IdP side of a sign-in. */
export class Browser {
  private readonly jar = new Map<string, string>();

  async fetch(url: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    if (this.jar.size) headers.set('Cookie', [...this.jar].map(([k, v]) => `${k}=${v}`).join('; '));
    const res = await fetch(url, { ...init, headers, redirect: 'manual' });
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const i = pair?.indexOf('=') ?? -1;
      if (!pair || i < 0) continue;
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      if (value) this.jar.set(name, value);
      else this.jar.delete(name);
    }
    return res;
  }

  /** Follows redirects on the IdP's own host and stops at the first one leaving it. */
  async follow(url: string, init: RequestInit = {}): Promise<{ res: Response; url: string }> {
    let current = url;
    let res = await this.fetch(current, init);
    for (let i = 0; i < 10 && res.status >= 300 && res.status < 400; i++) {
      const next = new URL(res.headers.get('location')!, current).href;
      if (new URL(next).host !== new URL(url).host) return { res, url: next };
      current = next;
      res = await this.fetch(current);
    }
    return { res, url: current };
  }
}

const decode = (s: string) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x2F;/g, '/')
    .replace(/&#47;/g, '/');

/**
 * Fills Keycloak's login form. Returns the URL the IdP sends the browser to (our callback)
 * or, for SAML, the auto-submitted POST form fields.
 */
export async function keycloakLogin(
  browser: Browser,
  authorizeUrl: string,
  username: string,
  password: string,
) {
  const page = await browser.follow(authorizeUrl);
  const html = await page.res.text();
  const action = /<form[^>]+id="kc-form-login"[^>]+action="([^"]+)"/.exec(html)?.[1];
  if (!action) throw new Error(`no Keycloak login form at ${page.url}: ${html.slice(0, 300)}`);
  const res = await browser.fetch(decode(action), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username, password, credentialId: '' }).toString(),
  });
  if (res.status >= 300 && res.status < 400) {
    return { redirect: res.headers.get('location')!, form: null };
  }
  const body = await res.text();
  const formAction = /<form[^>]+action="([^"]+)"/.exec(body)?.[1];
  const fields = Object.fromEntries(
    [...body.matchAll(/<input[^>]+name="([^"]+)"[^>]+value="([^"]*)"/g)].map((m) => [
      m[1]!,
      decode(m[2]!),
    ]),
  );
  if (!formAction || !fields.SAMLResponse) throw new Error(`login failed: ${body.slice(0, 500)}`);
  return { redirect: null, form: { action: decode(formAction), fields } };
}

export async function stopAll(...containers: (StartedTestContainer | undefined)[]) {
  await Promise.all(containers.map((c) => c?.stop().catch(() => undefined)));
}
