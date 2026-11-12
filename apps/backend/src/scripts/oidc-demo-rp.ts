/**
 * A tiny "internal app" that signs in with Crewhall (design 9.12, e.g. Milvaion):
 *   DEMO_CLIENT_SECRET=mhs_… pnpm --filter @crewhall/backend exec tsx src/scripts/oidc-demo-rp.ts
 * Env: CREWHALL_ISSUER (default http://localhost:4911), DEMO_CLIENT_ID (default demo-app),
 * DEMO_RP_PORT (default 4950). Open http://localhost:4950 and press "Crewhall ile giriş yap".
 * Development tool only: tokens live in process memory.
 */
import { randomUUID } from 'node:crypto';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import * as oidc from 'openid-client';

const issuer = process.env.CREWHALL_ISSUER ?? 'http://localhost:4911';
const clientId = process.env.DEMO_CLIENT_ID ?? 'demo-app';
const secret = process.env.DEMO_CLIENT_SECRET;
const port = Number(process.env.DEMO_RP_PORT ?? 4950);
const base = `http://localhost:${port}`;
if (!secret) throw new Error('DEMO_CLIENT_SECRET is required (printed by identity-dev-seed.ts)');

const config = await oidc.discovery(
  new URL(issuer),
  clientId,
  secret,
  oidc.ClientSecretBasic(secret),
  {
    execute: issuer.startsWith('http://') ? [oidc.allowInsecureRequests] : [],
  },
);

const pending = new Map<string, { verifier: string; state: string; nonce: string }>();
const sessions = new Map<
  string,
  { claims: Record<string, unknown>; userinfo: unknown; idToken: string; refresh?: string }
>();

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const page = (body: string) =>
  `<!doctype html><meta charset="utf-8"><title>Demo uygulama</title><body style="font-family:system-ui;max-width:760px;margin:40px auto;padding:0 16px">${body}</body>`;

const app = new Hono();

app.get('/', (c) => {
  const s = sessions.get(getCookie(c, 'demo_sid') ?? '');
  if (!s) {
    return c.html(
      page(
        `<h1>Demo uygulama</h1><p>Issuer: <code>${esc(issuer)}</code></p><p><a href="/login">Crewhall ile giriş yap</a></p>`,
      ),
    );
  }
  return c.html(
    page(`<h1>Merhaba ${esc(String(s.claims.name ?? s.claims.sub))}</h1>
<h2>id_token</h2><pre>${esc(JSON.stringify(s.claims, null, 2))}</pre>
<h2>userinfo</h2><pre>${esc(JSON.stringify(s.userinfo, null, 2))}</pre>
<p><a href="/refresh">Token yenile</a> · <a href="/logout">Çıkış</a></p>`),
  );
});

app.get('/login', async (c) => {
  const key = randomUUID();
  const verifier = oidc.randomPKCECodeVerifier();
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  pending.set(key, { verifier, state, nonce });
  setCookie(c, 'demo_tx', key, { httpOnly: true, path: '/', sameSite: 'Lax' });
  const url = oidc.buildAuthorizationUrl(config, {
    redirect_uri: `${base}/signin-oidc`,
    scope: 'openid profile email groups offline_access',
    code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
    code_challenge_method: 'S256',
    state,
    nonce,
  });
  return c.redirect(url.href);
});

app.get('/signin-oidc', async (c) => {
  const tx = pending.get(getCookie(c, 'demo_tx') ?? '');
  if (!tx)
    return c.html(page('<p>Oturum isteği bulunamadı. <a href="/">Baştan başla</a></p>'), 400);
  try {
    const tokens = await oidc.authorizationCodeGrant(config, new URL(c.req.url, base), {
      pkceCodeVerifier: tx.verifier,
      expectedState: tx.state,
      expectedNonce: tx.nonce,
      idTokenExpected: true,
    });
    const claims = (tokens.claims() ?? {}) as Record<string, unknown>;
    const userinfo = await oidc.fetchUserInfo(config, tokens.access_token, String(claims.sub));
    const sid = randomUUID();
    sessions.set(sid, {
      claims,
      userinfo,
      idToken: tokens.id_token!,
      ...(tokens.refresh_token ? { refresh: tokens.refresh_token } : {}),
    });
    setCookie(c, 'demo_sid', sid, { httpOnly: true, path: '/', sameSite: 'Lax' });
    return c.redirect('/');
  } catch (err) {
    return c.html(
      page(`<h1>Giriş başarısız</h1><pre>${esc(String(err))}</pre><p><a href="/">Geri</a></p>`),
      400,
    );
  }
});

app.get('/refresh', async (c) => {
  const s = sessions.get(getCookie(c, 'demo_sid') ?? '');
  if (!s?.refresh) return c.redirect('/');
  try {
    const tokens = await oidc.refreshTokenGrant(config, s.refresh);
    s.refresh = tokens.refresh_token ?? s.refresh;
    s.claims = (tokens.claims() ?? s.claims) as Record<string, unknown>;
    return c.redirect('/');
  } catch (err) {
    sessions.delete(getCookie(c, 'demo_sid') ?? '');
    return c.html(
      page(`<h1>Yenileme reddedildi</h1><pre>${esc(String(err))}</pre><p><a href="/">Geri</a></p>`),
      400,
    );
  }
});

app.get('/logout', (c) => {
  const sid = getCookie(c, 'demo_sid') ?? '';
  const s = sessions.get(sid);
  sessions.delete(sid);
  if (!s) return c.redirect('/');
  return c.redirect(
    oidc.buildEndSessionUrl(config, {
      id_token_hint: s.idToken,
      post_logout_redirect_uri: `${base}/`,
    }).href,
  );
});

serve({ fetch: app.fetch, port, hostname: 'localhost' }, () => {
  console.log(`demo app on ${base} (issuer ${issuer}, client ${clientId})`);
});
