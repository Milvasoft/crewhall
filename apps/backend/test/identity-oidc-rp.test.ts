import { createServer } from 'node:net';
import { serve, type ServerType } from '@hono/node-server';
import * as oidc from 'openid-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, createTestApp, setupWithOwner, type TestApp } from './helpers';

/**
 * "Milvaion signs in with Crewhall": a standard relying party (openid-client) talks to
 * Crewhall over real HTTP — discovery, code + PKCE, id_token validation, userinfo,
 * refresh and the end-session URL — exactly as an internal app would.
 */

async function freePort() {
  return new Promise<number>((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const address = s.address();
      s.close(() =>
        typeof address === 'object' && address
          ? resolve(address.port)
          : reject(new Error('no port')),
      );
    });
  });
}

describe('OIDC relying party (openid-client) against Crewhall', () => {
  let app: TestApp;
  let server: ServerType;
  let owner: Client;
  let issuer: string;
  const redirectUri = 'http://localhost:5050/signin-oidc';

  beforeAll(async () => {
    const port = await freePort();
    issuer = `http://127.0.0.1:${port}`;
    app = await createTestApp({ API_URL: issuer });
    server = serve({ fetch: app.app.fetch, port, hostname: '127.0.0.1' });
    ({ owner } = await setupWithOwner(app));
  });
  afterAll(async () => {
    server?.close();
    await app?.close();
  });

  it('signs a user in to an internal app', async () => {
    const created = await owner.api.call('createOidcClient', {
      body: {
        name: 'Milvaion',
        redirectUris: [redirectUri],
        postLogoutRedirectUris: ['http://localhost:5050/'],
        scopes: ['openid', 'profile', 'email', 'groups', 'offline_access'],
        skipConsent: true,
      },
    });
    const config = await oidc.discovery(
      new URL(issuer),
      created.client.clientId,
      created.clientSecret!,
      oidc.ClientSecretBasic(created.clientSecret!),
      { execute: [oidc.allowInsecureRequests] },
    );
    expect(config.serverMetadata().issuer).toBe(issuer);

    const verifier = oidc.randomPKCECodeVerifier();
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const url = oidc.buildAuthorizationUrl(config, {
      redirect_uri: redirectUri,
      scope: 'openid profile email groups offline_access',
      code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
      state,
      nonce,
    });
    // The person's browser, already signed in to Crewhall: an internal app skips consent.
    const res = await owner.fetch(url.href, { redirect: 'manual' });
    expect(res.status).toBe(302);
    const callback = new URL(res.headers.get('location')!);
    expect(callback.origin + callback.pathname).toBe(redirectUri);

    const tokens = await oidc.authorizationCodeGrant(config, callback, {
      pkceCodeVerifier: verifier,
      expectedState: state,
      expectedNonce: nonce,
      idTokenExpected: true,
    });
    const claims = tokens.claims()!;
    expect(claims).toMatchObject({
      iss: issuer,
      aud: created.client.clientId,
      email: 'bugra@milvasoft.com',
    });
    expect(claims.groups).toEqual(expect.arrayContaining(['milvasoft']));

    const info = await oidc.fetchUserInfo(config, tokens.access_token, claims.sub);
    expect(info).toMatchObject({
      sub: claims.sub,
      name: 'Ahmet Buğra Kösen',
      org: 'milvasoft',
      roles: ['owner'],
    });

    const refreshed = await oidc.refreshTokenGrant(config, tokens.refresh_token!);
    expect(refreshed.access_token).not.toBe(tokens.access_token);
    expect(refreshed.claims()?.sub).toBe(claims.sub);

    const logout = oidc.buildEndSessionUrl(config, {
      id_token_hint: tokens.id_token!,
      post_logout_redirect_uri: 'http://localhost:5050/',
    });
    expect(logout.href.startsWith(`${issuer}/api/oidc/logout`)).toBe(true);
  });
});
