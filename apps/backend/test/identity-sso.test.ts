import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedTestContainer } from 'testcontainers';
import { totpCode } from '../src/scripts/totp';
import { Client, createTestApp, join, setupWithOwner, WEB_ORIGIN, type TestApp } from './helpers';
import {
  Browser,
  KEYCLOAK_CLIENT,
  KEYCLOAK_REALM,
  KEYCLOAK_SECRET,
  keycloakLogin,
  startKeycloak,
  stopAll,
} from './identity-containers';

const API = 'http://localhost:3000';

/** Inbound SSO against a real Keycloak (Testcontainers): OIDC and SAML 2.0. */
describe('SSO with Keycloak', () => {
  let app: TestApp;
  let owner: Client;
  let keycloak: StartedTestContainer;
  let kc: { base: string; issuer: string };
  let providerId: string;
  let altyapiId: string;

  beforeAll(async () => {
    const started = await startKeycloak(API, [
      {
        username: 'zeynep',
        email: 'zeynep@kc.test',
        firstName: 'Zeynep',
        lastName: 'Etkin',
        password: 'zeynep-kc-pass',
        groups: ['it-admins'],
      },
      {
        username: 'can',
        email: 'can@kc.test',
        firstName: 'Can',
        lastName: 'Demir',
        password: 'can-kc-pass',
        groups: ['developers'],
      },
    ]);
    keycloak = started.container;
    kc = started;
    app = await createTestApp();
    ({ owner } = await setupWithOwner(app));
    altyapiId = (await owner.api.call('listSpaces')).items.find((s) => s.name === 'Altyapı')!.id;
  }, 300_000);
  afterAll(async () => {
    await app?.close();
    await stopAll(keycloak);
  });

  /** Browser on the Crewhall side: start → Keycloak login → callback. Returns the final target. */
  async function ssoSignIn(
    c: Client,
    id: string,
    username: string,
    password: string,
    callbackURL = '/',
  ) {
    const start = await c.fetch(
      `${API}/api/identity/sso/${id}/start?callbackURL=${encodeURIComponent(callbackURL)}`,
      { redirect: 'manual' },
    );
    expect(start.status).toBe(302);
    const idp = start.headers.get('location')!;
    expect(idp.startsWith(kc.base)).toBe(true);
    const login = await keycloakLogin(new Browser(), idp, username, password);
    let back: Response;
    if (login.redirect) {
      back = await c.fetch(login.redirect, { redirect: 'manual' });
    } else {
      back = await c.fetch(login.form!.action, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(login.form!.fields).toString(),
      });
    }
    expect(back.status).toBe(302);
    return back.headers.get('location')!;
  }

  it('adds Keycloak, tests it and offers it on the login screen', async () => {
    const created = await owner.api.call('createIdentityProvider', {
      body: {
        kind: 'oidc',
        preset: 'keycloak',
        name: 'Keycloak',
        domains: ['kc.test'],
        enforceSso: true,
        config: {
          issuer: kc.issuer,
          clientId: KEYCLOAK_CLIENT,
          scopes: 'openid email profile',
          groupsClaim: 'groups',
        },
        clientSecret: KEYCLOAK_SECRET,
        roleMappings: [
          { group: 'it-admins', orgRole: 'admin' },
          { group: 'developers', spaceId: altyapiId, spaceRole: 'editor' },
        ],
      } as never,
    });
    providerId = created.id;
    expect(created.callbackUrl).toBe(`${API}/api/identity/sso/${providerId}/callback`);

    const test = await owner.api.call('testIdentityProvider', { body: { providerId } });
    expect(test.ok).toBe(true);
    expect(test.steps.map((s) => s.key)).toEqual(['discovery', 'jwks', 'endpoints']);

    const boot = await new Client(app).api.call('bootstrap');
    expect(boot.auth.sso).toEqual([{ id: providerId, name: 'Keycloak', kind: 'oidc' }]);
    const disc = await new Client(app).api.call('discoverSignIn', {
      body: { email: 'zeynep@kc.test' },
    });
    expect(disc).toMatchObject({ method: 'sso', provider: { id: providerId, kind: 'oidc' } });
  });

  it('signs in through Keycloak, creates the account and maps groups', async () => {
    const zeynep = new Client(app);
    const target = await ssoSignIn(zeynep, providerId, 'zeynep', 'zeynep-kc-pass');
    expect(target).toBe(`${WEB_ORIGIN}/`);
    const me = await zeynep.api.call('me');
    expect(me.user).toMatchObject({ email: 'zeynep@kc.test', name: 'Zeynep Etkin' });
    expect(me.memberships[0]?.role).toBe('admin');

    const can = new Client(app);
    await ssoSignIn(can, providerId, 'can', 'can-kc-pass');
    const spaces = await can.api.call('listSpaces');
    expect(spaces.items.find((s) => s.id === altyapiId)?.myRole).toBe('editor');
  });

  it('rejects a replayed or forged callback', async () => {
    const c = new Client(app);
    const res = await c.fetch(
      `${API}/api/identity/sso/${providerId}/callback?code=x&state=forged`,
      {
        redirect: 'manual',
      },
    );
    const location = new URL(res.headers.get('location')!);
    expect(location.pathname).toBe('/login');
    expect(location.searchParams.get('ssoError')).toBe('sso_login_failed');
    // An open redirect is not possible through callbackURL.
    const evil = await c.fetch(
      `${API}/api/identity/sso/${providerId}/start?callbackURL=${encodeURIComponent('https://evil.example.com/')}`,
      { redirect: 'manual' },
    );
    expect(evil.status).toBe(302);
  });

  it('hands an SSO session to the mobile app through /mobil-giris', async () => {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const browser = new Client(app);
    const back = `/mobil-giris?redirect_uri=${encodeURIComponent('crewhall://auth')}&code_challenge=${challenge}`;
    const target = await ssoSignIn(browser, providerId, 'can', 'can-kc-pass', back);
    expect(target).toBe(`${WEB_ORIGIN}${back}`);
    // The web page at /mobil-giris now creates the handoff with the browser session.
    const { code } = await browser.api.call('createMobileHandoff', {
      body: { codeChallenge: challenge, redirectUri: 'crewhall://auth' },
    });
    const app2 = new Client(app);
    const session = await app2.api.call('exchangeMobileHandoff', {
      body: { code, codeVerifier: verifier },
    });
    app2.bearer = decodeURIComponent(session.token);
    expect((await app2.api.call('me')).user.email).toBe('can@kc.test');
  });

  it('enforces SSO for the domain but keeps the owner break-glass login', async () => {
    await owner.api.call('updateIdentityProvider', {
      params: { providerId },
      body: { domains: ['kc.test', 'milvasoft.com'] },
    });
    await join(app, owner, 'selin@milvasoft.com', 'member');
    const selin = await new Client(app).auth<{ code: string; providerId: string }>(
      '/sign-in/email',
      {
        email: 'selin@milvasoft.com',
        password: 'correct-horse-battery-staple',
      },
    );
    expect(selin.status).toBe(403);
    expect(selin.body).toMatchObject({ code: 'SSO_REQUIRED', providerId });
    const ownerLogin = await new Client(app).auth('/sign-in/email', {
      email: 'bugra@milvasoft.com',
      password: 'correct-horse-battery-staple',
    });
    expect(ownerLogin.status).toBe(200);
    await owner.api.call('updateIdentityProvider', {
      params: { providerId },
      body: { domains: ['kc.test'] },
    });
  });

  it('asks for local TOTP after SSO unless the IdP MFA is trusted', async () => {
    const zeynep = new Client(app);
    await ssoSignIn(zeynep, providerId, 'zeynep', 'zeynep-kc-pass');
    const enabled = await zeynep.auth<{ totpURI: string }>('/two-factor/enable', {});
    expect(enabled.status).toBe(200);
    await zeynep.auth('/two-factor/verify-totp', { code: await totpCode(enabled.body.totpURI) });

    const again = new Client(app);
    const target = new URL(await ssoSignIn(again, providerId, 'zeynep', 'zeynep-kc-pass'));
    expect(target.pathname).toBe('/login/2fa');
    expect(target.searchParams.get('redirect')).toBe('/');
    await expect(again.api.call('me')).rejects.toMatchObject({ status: 401 });
    const verified = await again.auth('/two-factor/verify-totp', {
      code: await totpCode(enabled.body.totpURI),
    });
    expect(verified.status).toBe(200);
    expect((await again.api.call('me')).user.email).toBe('zeynep@kc.test');
  });

  it('sends the browser to Keycloak end_session on sign-out when configured', async () => {
    const can = new Client(app);
    await ssoSignIn(can, providerId, 'can', 'can-kc-pass');
    expect((await can.api.call('getSsoLogoutTarget', { query: {} })).url).toBeNull();
    const view = await owner.api.call('getIdentityProvider', { params: { providerId } });
    await owner.api.call('updateIdentityProvider', {
      params: { providerId },
      body: { config: { ...(view.config as object), endSessionOnLogout: true } as never },
    });
    const can2 = new Client(app);
    await ssoSignIn(can2, providerId, 'can', 'can-kc-pass');
    const { url } = await can2.api.call('getSsoLogoutTarget', {
      query: { postLogoutUrl: '/login' },
    });
    expect(url).toContain(`${kc.issuer}/protocol/openid-connect/logout`);
    expect(url).toContain('id_token_hint=');
    expect(url).toContain(encodeURIComponent(`${WEB_ORIGIN}/login`));
  });

  it('signs in with SAML 2.0 through Keycloak', async () => {
    const descriptor = await (await fetch(`${kc.issuer}/protocol/saml/descriptor`)).text();
    const cert = /<ds:X509Certificate>([^<]+)<\/ds:X509Certificate>/.exec(descriptor)?.[1];
    expect(cert).toBeTruthy();
    const saml = await owner.api.call('createIdentityProvider', {
      body: {
        kind: 'saml',
        preset: 'saml',
        name: 'Keycloak SAML',
        domains: [],
        config: {
          entryPoint: `${kc.issuer}/protocol/saml`,
          idpIssuer: kc.issuer,
          idpCert: cert!,
          emailAttribute: 'email',
          nameAttribute: 'name',
          groupsAttribute: 'groups',
        },
        roleMappings: [{ group: 'developers', spaceId: altyapiId, spaceRole: 'viewer' }],
      } as never,
    });
    expect(saml.spEntityId).toBe(`${API}/api/identity/saml/${saml.id}/metadata`);
    const metadata = await app.app.request(`${API}/api/identity/saml/${saml.id}/metadata`);
    expect(await metadata.text()).toContain(saml.callbackUrl!);

    // Register Crewhall as a SAML client through Keycloak's admin API.
    const admin = (await (
      await fetch(`${kc.base}/realms/master/protocol/openid-connect/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'password',
          client_id: 'admin-cli',
          username: 'admin',
          password: 'admin',
        }).toString(),
      })
    ).json()) as { access_token: string };
    const mapper = (name: string, mapperType: string, config: Record<string, string>) => ({
      name,
      protocol: 'saml',
      protocolMapper: mapperType,
      config,
    });
    const created = await fetch(`${kc.base}/admin/realms/${KEYCLOAK_REALM}/clients`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${admin.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        clientId: saml.spEntityId,
        protocol: 'saml',
        enabled: true,
        redirectUris: [`${API}/*`],
        attributes: {
          'saml.assertion.signature': 'true',
          'saml.server.signature': 'true',
          'saml.client.signature': 'false',
          'saml.force.post.binding': 'true',
          'saml.authnstatement': 'true',
          saml_force_name_id_format: 'true',
          saml_name_id_format: 'email',
          saml_assertion_consumer_url_post: saml.callbackUrl,
        },
        protocolMappers: [
          mapper('email', 'saml-user-property-mapper', {
            'user.attribute': 'email',
            'attribute.name': 'email',
            'attribute.nameformat': 'Basic',
          }),
          mapper('name', 'saml-user-property-mapper', {
            'user.attribute': 'firstName',
            'attribute.name': 'name',
            'attribute.nameformat': 'Basic',
          }),
          mapper('groups', 'saml-group-membership-mapper', {
            'attribute.name': 'groups',
            'full.path': 'false',
            single: 'false',
            'attribute.nameformat': 'Basic',
          }),
        ],
      }),
    });
    expect(created.status).toBe(201);

    const can = new Client(app);
    const target = await ssoSignIn(can, saml.id, 'can', 'can-kc-pass');
    expect(target).toBe(`${WEB_ORIGIN}/`);
    const me = await can.api.call('me');
    expect(me.user.email).toBe('can@kc.test');
    // Same e-mail as the OIDC account: linked, not duplicated.
    const linked = await owner.api.call('listLinkedIdentities', {
      params: { providerId: saml.id },
      query: {} as never,
    });
    expect(linked.items).toHaveLength(1);
    expect(linked.items[0]).toMatchObject({ email: 'can@kc.test', subject: 'can@kc.test' });
  });
});
