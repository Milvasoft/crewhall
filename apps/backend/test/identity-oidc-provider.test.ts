import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLocalJWKSet, jwtVerify } from 'jose';
import { and, eq } from 'drizzle-orm';
import { auditLogs } from '@crewhall/db';
import { Client, createTestApp, join, setupWithOwner, type TestApp } from './helpers';

const API = 'http://localhost:3000';
const REDIRECT = 'https://milvaion.example.com/signin-oidc';

const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

function authorizeUrl(clientId: string, extra: Record<string, string> = {}) {
  const url = new URL(`${API}/api/oidc/authorize`);
  const params = {
    client_id: clientId,
    redirect_uri: REDIRECT,
    response_type: 'code',
    scope: 'openid profile email groups offline_access',
    state: 'st-1',
    nonce: 'n-1',
    ...extra,
  };
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url;
}

async function form(
  app: TestApp,
  path: string,
  body: Record<string, string>,
  basic?: [string, string],
) {
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (basic)
    headers.Authorization = `Basic ${Buffer.from(`${basic[0]}:${basic[1]}`).toString('base64')}`;
  const res = await app.app.request(`${API}${path}`, {
    method: 'POST',
    headers,
    body: new URLSearchParams(body).toString(),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('Crewhall as OpenID Connect provider', () => {
  let app: TestApp;
  let owner: Client;
  let orgId: string;
  let clientId: string;
  let clientRowId: string;
  let secret: string;

  beforeAll(async () => {
    app = await createTestApp();
    ({ owner, orgId } = await setupWithOwner(app));
  });
  afterAll(() => app.close());

  it('publishes discovery and JWKS', async () => {
    const res = await app.app.request(`${API}/.well-known/openid-configuration`);
    const doc = (await res.json()) as Record<string, unknown>;
    expect(doc).toMatchObject({
      issuer: API,
      authorization_endpoint: `${API}/api/oidc/authorize`,
      token_endpoint: `${API}/api/oidc/token`,
      jwks_uri: `${API}/api/oidc/jwks`,
      code_challenge_methods_supported: ['S256'],
    });
    // MCP keeps its own authorization server metadata.
    const mcp = await app.app.request(`${API}/.well-known/oauth-authorization-server`);
    expect(mcp.status).toBe(200);
  });

  it('validates redirect URIs and shows the secret once', async () => {
    await expect(
      owner.api.call('createOidcClient', {
        body: { name: 'Evil', redirectUris: ['http://evil.example.com/cb'] },
      }),
    ).rejects.toMatchObject({ code: 'oidc_redirect_uri_invalid' });
    await expect(
      owner.api.call('createOidcClient', {
        body: { name: 'Wild', redirectUris: ['https://*.example.com/cb'] },
      }),
    ).rejects.toMatchObject({ code: 'oidc_redirect_uri_invalid' });

    const created = await owner.api.call('createOidcClient', {
      body: {
        name: 'Milvaion',
        type: 'web',
        redirectUris: [REDIRECT, 'http://localhost:5000/signin-oidc'],
        postLogoutRedirectUris: ['https://milvaion.example.com/'],
        scopes: ['openid', 'profile', 'email', 'groups', 'offline_access'],
        skipConsent: false,
      },
    });
    expect(created.client.clientId).toBe('milvaion');
    expect(created.clientSecret).toMatch(/^mhs_/);
    expect(created.client.secretHint).toBe(created.clientSecret!.slice(-4));
    clientId = created.client.clientId;
    clientRowId = created.client.id;
    secret = created.clientSecret!;

    const info = await owner.api.call('getOidcProvider');
    expect(info.clients.map((c) => c.clientId)).toContain('milvaion');
    expect(info.signingKey?.alg).toBe('RS256');
    expect(JSON.stringify(info)).not.toContain(secret);
  });

  it('runs code + PKCE through consent, issues verifiable tokens and userinfo', async () => {
    const { verifier, challenge } = pkce();
    const url = authorizeUrl(clientId, {
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    const first = await owner.fetch(url.href, { redirect: 'manual' });
    expect(first.status).toBe(302);
    const consentPage = new URL(first.headers.get('location')!);
    expect(consentPage.pathname).toBe('/sso/consent');

    const query = Object.fromEntries(consentPage.searchParams) as Record<string, string>;
    const consent = await owner.api.call('getOidcConsent', {
      query: query as never,
    });
    expect(consent.autoApprove).toBe(false);
    expect(consent.client.name).toBe('Milvaion');
    expect(consent.scopes.map((s) => s.scope)).toEqual([
      'openid',
      'profile',
      'email',
      'groups',
      'offline_access',
    ]);
    const { redirectTo } = await owner.api.call('approveOidcConsent', {
      body: { ...query, consentToken: consent.consentToken } as never,
    });
    const back = new URL(redirectTo);
    expect(back.origin + back.pathname).toBe(REDIRECT);
    expect(back.searchParams.get('state')).toBe('st-1');
    expect(back.searchParams.get('iss')).toBe(API);
    const code = back.searchParams.get('code')!;

    const wrong = await form(
      app,
      '/api/oidc/token',
      {
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT,
        code_verifier: 'x'.repeat(43),
      },
      [clientId, secret],
    );
    expect(wrong.body.error).toBe('invalid_grant');

    // The failed attempt consumed the code: a fresh one is needed.
    const again = await owner.fetch(
      authorizeUrl(clientId, { code_challenge: challenge, code_challenge_method: 'S256' }).href,
      { redirect: 'manual' },
    );
    // Consent is remembered now: straight back to the app.
    const silent = new URL(again.headers.get('location')!);
    expect(silent.origin + silent.pathname).toBe(REDIRECT);
    const code2 = silent.searchParams.get('code')!;

    const token = await form(
      app,
      '/api/oidc/token',
      {
        grant_type: 'authorization_code',
        code: code2,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
      },
      [clientId, secret],
    );
    expect(token.status).toBe(200);
    expect(token.body).toMatchObject({ token_type: 'Bearer', expires_in: 900 });
    expect(String(token.body.refresh_token)).toMatch(/^mhor_/);

    const keys = (await (await app.app.request(`${API}/api/oidc/jwks`)).json()) as {
      keys: never[];
    };
    const jwks = createLocalJWKSet(keys);
    const { payload } = await jwtVerify(String(token.body.id_token), jwks, {
      issuer: API,
      audience: clientId,
    });
    expect(payload).toMatchObject({
      email: 'bugra@milvasoft.com',
      // Setup does not verify the owner's address; the claim reports what Crewhall knows.
      email_verified: false,
      name: 'Ahmet Buğra Kösen',
      org: 'milvasoft',
      roles: ['owner'],
      nonce: 'n-1',
    });
    expect(payload.groups).toEqual(expect.arrayContaining(['milvasoft', 'altyapi']));
    expect(payload.amr).toContain('mfa');

    // APIs such as Milvaion only receive the access token, so it has to identify the person.
    const { payload: accessPayload, protectedHeader } = await jwtVerify(
      String(token.body.access_token),
      jwks,
      { issuer: API, audience: clientId },
    );
    expect(protectedHeader.typ).toBe('at+jwt');
    expect(accessPayload).toMatchObject({
      email: 'bugra@milvasoft.com',
      name: 'Ahmet Buğra Kösen',
      preferred_username: 'bugra@milvasoft.com',
      roles: ['owner'],
    });
    expect(accessPayload.groups).toBeUndefined();

    const replay = await form(
      app,
      '/api/oidc/token',
      {
        grant_type: 'authorization_code',
        code: code2,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
      },
      [clientId, secret],
    );
    expect(replay.body.error).toBe('invalid_grant');
    // A replayed code revokes the refresh token it produced.
    const afterReplay = await form(
      app,
      '/api/oidc/token',
      {
        grant_type: 'refresh_token',
        refresh_token: String(token.body.refresh_token),
      },
      [clientId, secret],
    );
    expect(afterReplay.body.error).toBe('invalid_grant');

    const info = await app.app.request(`${API}/api/oidc/userinfo`, {
      headers: { Authorization: `Bearer ${String(token.body.access_token)}` },
    });
    expect(info.status).toBe(200);
    expect(await info.json()).toMatchObject({ email: 'bugra@milvasoft.com', org: 'milvasoft' });

    const rows = await app.deps.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.orgId, orgId), eq(auditLogs.action, 'oidc.login')));
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const listed = await owner.api.call('getOidcProvider');
    expect(listed.clients.find((c) => c.clientId === clientId)?.logins7d).toBeGreaterThanOrEqual(2);
  });

  async function freshTokens() {
    const { verifier, challenge } = pkce();
    const res = await owner.fetch(
      authorizeUrl(clientId, { code_challenge: challenge, code_challenge_method: 'S256' }).href,
      { redirect: 'manual' },
    );
    const code = new URL(res.headers.get('location')!).searchParams.get('code')!;
    const token = await form(
      app,
      '/api/oidc/token',
      {
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
      },
      [clientId, secret],
    );
    expect(token.status).toBe(200);
    return token.body;
  }

  it('rotates refresh tokens and revokes the chain on reuse', async () => {
    const t = await freshTokens();
    const r1 = await form(
      app,
      '/api/oidc/token',
      {
        grant_type: 'refresh_token',
        refresh_token: String(t.refresh_token),
      },
      [clientId, secret],
    );
    expect(r1.status).toBe(200);
    expect(r1.body.refresh_token).not.toBe(t.refresh_token);

    const reuse = await form(
      app,
      '/api/oidc/token',
      {
        grant_type: 'refresh_token',
        refresh_token: String(t.refresh_token),
      },
      [clientId, secret],
    );
    expect(reuse.body.error).toBe('invalid_grant');
    const next = await form(
      app,
      '/api/oidc/token',
      {
        grant_type: 'refresh_token',
        refresh_token: String(r1.body.refresh_token),
      },
      [clientId, secret],
    );
    expect(next.body.error).toBe('invalid_grant');
  });

  it('refuses a wrong secret and drops sessions of a disabled client at refresh', async () => {
    const bad = await form(
      app,
      '/api/oidc/token',
      { grant_type: 'refresh_token', refresh_token: 'x' },
      [clientId, 'mhs_wrong'],
    );
    expect(bad.status).toBe(401);

    const t = await freshTokens();
    await owner.api.call('updateOidcClient', {
      params: { oidcClientId: clientRowId },
      body: { enabled: false },
    });
    const refresh = await form(
      app,
      '/api/oidc/token',
      {
        grant_type: 'refresh_token',
        refresh_token: String(t.refresh_token),
      },
      [clientId, secret],
    );
    expect(refresh.status).toBe(400);
    const res = await owner.fetch(authorizeUrl(clientId).href, { redirect: 'manual' });
    expect(new URL(res.headers.get('location')!).searchParams.get('error')).toBe(
      'unauthorized_client',
    );
    await owner.api.call('updateOidcClient', {
      params: { oidcClientId: clientRowId },
      body: { enabled: true },
    });
  });

  it('requires PKCE from public clients', async () => {
    const spa = await owner.api.call('createOidcClient', {
      body: { name: 'Dashboard SPA', type: 'spa', redirectUris: [REDIRECT], skipConsent: true },
    });
    expect(spa.clientSecret).toBeNull();
    const res = await owner.fetch(authorizeUrl(spa.client.clientId, { scope: 'openid' }).href, {
      redirect: 'manual',
    });
    expect(new URL(res.headers.get('location')!).searchParams.get('error')).toBe('invalid_request');

    const { verifier, challenge } = pkce();
    const ok = await owner.fetch(
      authorizeUrl(spa.client.clientId, {
        scope: 'openid',
        code_challenge: challenge,
        code_challenge_method: 'S256',
      }).href,
      { redirect: 'manual' },
    );
    const code = new URL(ok.headers.get('location')!).searchParams.get('code')!;
    expect(code).toBeTruthy();
    const token = await form(app, '/api/oidc/token', {
      grant_type: 'authorization_code',
      client_id: spa.client.clientId,
      code,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
    });
    expect(token.status).toBe(200);
    expect(token.body.refresh_token).toBeUndefined();
  });

  it('applies the org 2FA policy and the access restriction', async () => {
    const { person: elif } = await join(app, owner, 'elif@milvasoft.com', 'member');
    const restricted = await owner.api.call('createOidcClient', {
      body: { name: 'Altyapı Paneli', redirectUris: [REDIRECT], skipConsent: true },
    });
    // Elif has no 2FA and the org requires it: no silent code, the consent page asks for enrolment.
    await owner.api.call('updateOrg', { body: { settings: { requireTwoFactor: true } } });
    const res = await elif.fetch(
      authorizeUrl(restricted.client.clientId, { scope: 'openid' }).href,
      {
        redirect: 'manual',
      },
    );
    // Web client without PKCE is allowed; it goes to the consent page instead of the app.
    expect(new URL(res.headers.get('location')!).pathname).toBe('/sso/consent');
    const query = Object.fromEntries(new URL(res.headers.get('location')!).searchParams);
    await expect(elif.api.call('getOidcConsent', { query: query as never })).rejects.toMatchObject({
      code: 'two_factor_required',
    });
    await owner.api.call('updateOrg', { body: { settings: { requireTwoFactor: false } } });

    const spaces = await owner.api.call('listOrgSpaces', { query: {} as never });
    const altyapi = spaces.items.find((s) => s.name === 'Altyapı')!;
    await owner.api.call('updateOidcClient', {
      params: { oidcClientId: restricted.client.id },
      body: { access: { kind: 'space', spaceId: altyapi.id } },
    });
    await expect(elif.api.call('getOidcConsent', { query: query as never })).rejects.toMatchObject({
      code: 'oidc_access_denied',
    });
    const none = await elif.fetch(
      authorizeUrl(restricted.client.clientId, { scope: 'openid', prompt: 'none' }).href,
      { redirect: 'manual' },
    );
    expect(new URL(none.headers.get('location')!).searchParams.get('error')).toBe('access_denied');
  });

  it('ends the Crewhall session on RP-initiated logout', async () => {
    const t = await freshTokens();
    const url = new URL(`${API}/api/oidc/logout`);
    url.searchParams.set('id_token_hint', String(t.id_token));
    url.searchParams.set('post_logout_redirect_uri', 'https://milvaion.example.com/');
    url.searchParams.set('state', 'bye');
    const res = await owner.fetch(url.href, { redirect: 'manual' });
    expect(res.headers.get('location')).toBe('https://milvaion.example.com/?state=bye');
    await expect(owner.api.call('me')).rejects.toMatchObject({ status: 401 });
  });
});
