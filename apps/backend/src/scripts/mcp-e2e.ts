/**
 * End-to-end check of the MCP server against a running api, the way Claude Code connects:
 * the official SDK client discovers the authorization server, registers itself (DCR),
 * opens the authorization URL (here a scripted "browser" signs in and approves on the
 * consent endpoints), exchanges the code with PKCE, then calls tools. It also checks that
 * an out-of-scope call answers 403 and a disconnected client gets 401 within 30 seconds.
 *
 *   pnpm --filter @crewhall/backend exec tsx --env-file=.env src/scripts/mcp-e2e.ts
 *
 * MCP_URL (default API_URL/mcp), MCP_E2E_EMAIL / MCP_E2E_PASSWORD (default the seed member).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  UnauthorizedError,
  type OAuthClientProvider,
} from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { SEED_PASSWORD, SEED_USERS } from './seed-data';
import { paths } from '@crewhall/shared';

const API = (process.env.API_URL ?? 'http://localhost:4301').replace(/\/$/, '');
const HUB = (process.env.HUB_URL ?? 'http://localhost:4311').replace(/\/$/, '');
const MCP_URL = process.env.MCP_URL ?? `${API}/mcp`;
// The first seeded member without TOTP signs in with the password alone.
const SEED_MEMBER = SEED_USERS.find((u) => u.role === 'member' && !u.totp)!;
const EMAIL = process.env.MCP_E2E_EMAIL ?? SEED_MEMBER.email;
const PASSWORD = process.env.MCP_E2E_PASSWORD ?? SEED_PASSWORD;
const REDIRECT = 'http://127.0.0.1:53682/callback';

let failures = 0;
function check(ok: boolean, label: string, extra?: unknown) {
  if (!ok) failures++;
  console.log(
    `${ok ? '✓' : '✗'} ${label}${extra === undefined ? '' : ` ${JSON.stringify(extra)}`}`,
  );
}

/** A tiny browser: keeps cookies, sends the web Origin. */
class Browser {
  cookies = new Map<string, string>();
  async fetch(url: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set('Origin', HUB);
    if (this.cookies.size) {
      headers.set('Cookie', [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '));
    }
    const res = await fetch(url, { ...init, headers, redirect: 'manual' });
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const i = pair!.indexOf('=');
      this.cookies.set(pair!.slice(0, i), pair!.slice(i + 1));
    }
    return res;
  }
}

class ScriptedProvider implements OAuthClientProvider {
  info?: OAuthClientInformationMixed;
  saved?: OAuthTokens;
  verifier = '';
  authorizations: URL[] = [];
  readonly redirectUrl = REDIRECT;
  constructor(private readonly scope: string) {}
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Claude Code (e2e)',
      redirect_uris: [REDIRECT],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: this.scope,
    };
  }
  readonly stateValue = `e2e-${Date.now().toString(36)}`;
  state() {
    return this.stateValue;
  }
  clientInformation() {
    return this.info;
  }
  saveClientInformation(info: OAuthClientInformationMixed) {
    this.info = info;
  }
  tokens() {
    return this.saved;
  }
  saveTokens(tokens: OAuthTokens) {
    this.saved = tokens;
  }
  redirectToAuthorization(url: URL) {
    this.authorizations.push(url);
  }
  saveCodeVerifier(v: string) {
    this.verifier = v;
  }
  codeVerifier() {
    return this.verifier;
  }
}

/** What the person does in the browser: sign in, look at the consent page, allow. */
async function approveInBrowser(browser: Browser, authorizeUrl: URL, scopes: string[]) {
  const first = await browser.fetch(authorizeUrl.href);
  check(first.status === 302, 'authorize hands over to the consent page', first.status);
  const consentPage = new URL(first.headers.get('location')!);
  check(
    consentPage.href.startsWith(`${HUB}${paths.oauthConsent()}`),
    'consent page is on the web app',
    consentPage.origin + consentPage.pathname,
  );
  const query = Object.fromEntries(consentPage.searchParams);
  const info = await browser.fetch(`${API}/api/v1/mcp/consent?${consentPage.searchParams}`);
  const consent = (await info.json()) as {
    consentToken: string;
    client: { name: string; redirectHost: string };
  };
  check(info.status === 200, 'consent describes the request', consent.client);
  const approve = await browser.fetch(`${API}/api/v1/mcp/consent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...query,
      consentToken: consent.consentToken,
      scopes,
      spaceIds: null,
      duration: '30d',
      label: 'e2e',
    }),
  });
  const decision = (await approve.json()) as { redirectTo: string; grantId: string };
  check(approve.status === 200, 'person allows on the consent screen', approve.status);
  const back = new URL(decision.redirectTo);
  check(
    Boolean(query.state) && back.searchParams.get('state') === query.state,
    'state comes back unchanged',
    query.state,
  );
  check(back.searchParams.get('iss') === API, 'iss names the authorization server');
  return { code: back.searchParams.get('code')!, grantId: decision.grantId };
}

async function main() {
  console.log(`MCP server ${MCP_URL}`);
  const browser = new Browser();
  const signIn = await browser.fetch(`${API}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  check(signIn.status === 200, `signed in as ${EMAIL}`, signIn.status);

  // 1. Unauthenticated call → 401 with resource metadata.
  const bare = await fetch(MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  });
  check(
    bare.status === 401 && /resource_metadata=/.test(bare.headers.get('www-authenticate') ?? ''),
    'no token: 401 + WWW-Authenticate resource_metadata',
  );

  // 2. The SDK client runs discovery, DCR and PKCE like Claude Code does.
  const provider = new ScriptedProvider('hub:read quick:write');
  let transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: provider });
  const client = new Client({ name: 'crewhall-e2e', version: '1.0.0' });
  try {
    await client.connect(transport);
    check(false, 'expected an authorization step');
  } catch (err) {
    check(err instanceof UnauthorizedError, 'client is sent to authorize');
  }
  check(
    Boolean(provider.info?.client_id),
    'client registered dynamically',
    provider.info?.client_id,
  );
  const authUrl = provider.authorizations[0]!;
  check(authUrl.searchParams.get('code_challenge_method') === 'S256', 'PKCE S256 requested');
  const { code, grantId } = await approveInBrowser(browser, authUrl, ['hub:read', 'quick:write']);
  await transport.finishAuth(code);
  check(Boolean(provider.saved?.access_token?.startsWith('mha_')), 'opaque access token issued');
  check(
    provider.saved?.expires_in !== undefined && provider.saved.expires_in <= 3600,
    'access token lives at most 1 hour',
    provider.saved?.expires_in,
  );

  transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: provider });
  await client.connect(transport);
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  check(
    names.includes('add_link') && names.includes('search'),
    'tools/list has the granted tools',
    names,
  );
  check(!names.includes('create_folder'), 'tools/list hides out-of-scope tools');
  check(!names.some((n) => /vault|kasa/i.test(n)), 'no vault tool anywhere');

  const spaces = await client.callTool({ name: 'list_spaces', arguments: {} });
  check(
    !spaces.isError,
    'tools/call list_spaces works',
    (spaces.structuredContent as { items: unknown[] })?.items?.length,
  );
  const added = await client.callTool({
    name: 'add_link',
    arguments: { url: 'https://status.example.com/', title: 'Status (e2e)' },
  });
  check(!added.isError, 'tools/call add_link writes as the person', added.structuredContent);

  // 3. Out of scope: HTTP 403 insufficient_scope with the missing scope.
  const access = provider.saved!.access_token;
  const rpc = (name: string, args: object) =>
    fetch(MCP_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${access}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 9,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    });
  const denied = await rpc('create_folder', {
    space_id: '00000000-0000-7000-8000-000000000000',
    name: 'x',
  });
  check(
    denied.status === 403 &&
      /insufficient_scope/.test(denied.headers.get('www-authenticate') ?? ''),
    'out-of-scope call: 403 insufficient_scope',
    denied.headers.get('www-authenticate'),
  );

  // 4. Disconnect in Crewhall → 401 within 30 s.
  const revoked = await browser.fetch(`${API}/api/v1/mcp/grants/${grantId}`, { method: 'DELETE' });
  check(revoked.status === 200, 'person disconnects the client', revoked.status);
  const started = Date.now();
  let status = 0;
  while (Date.now() - started < 31_000) {
    status = (await rpc('list_spaces', {})).status;
    if (status === 401) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  const seconds = Math.round((Date.now() - started) / 1000);
  check(status === 401, `disconnected client gets 401 (after ${seconds} s)`);
  await client.close();

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
