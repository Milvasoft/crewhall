import { createHash, randomBytes } from 'node:crypto';
import type { McpScope } from '@crewhall/shared';
import type { Client, TestApp } from './helpers';

export const API = 'http://localhost:3000';
export const RESOURCE = `${API}/mcp`;
export const REDIRECT = 'http://127.0.0.1:53682/callback';

export function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/** A non-browser HTTP call (no cookies, no Origin), like an MCP client process. */
export async function http(
  app: TestApp,
  method: string,
  path: string,
  opts: { headers?: Record<string, string>; body?: string; form?: Record<string, string> } = {},
) {
  const headers: Record<string, string> = { ...opts.headers };
  let body = opts.body;
  if (opts.form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(opts.form).toString();
  }
  const res = await app.app.request(`${API}${path}`, { method, headers, body });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, headers: res.headers, json: json as Record<string, unknown> };
}

let rpcId = 0;

/** One JSON-RPC request to /mcp with a bearer. */
export async function mcp(
  app: TestApp,
  token: string | null,
  method: string,
  params: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) {
  return http(app, 'POST', '/mcp', {
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
}

/** tools/call; returns the parsed structured content and isError. */
export async function callTool(
  app: TestApp,
  token: string,
  name: string,
  args: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) {
  const res = await mcp(app, token, 'tools/call', { name, arguments: args }, headers);
  const result = (res.json?.result ?? null) as {
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  } | null;
  return {
    status: res.status,
    headers: res.headers,
    body: res.json,
    data: (result?.structuredContent ?? {}) as Record<string, unknown> & {
      error?: string;
      message?: string;
    },
    isError: result?.isError ?? false,
  };
}

export async function register(app: TestApp, redirectUris = [REDIRECT], name = 'Claude Code') {
  const res = await http(app, 'POST', '/oauth/register', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: name,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }),
  });
  return res;
}

export interface Connected {
  clientId: string;
  access: string;
  refresh: string;
  grantId: string;
  verifier: string;
}

/**
 * The whole OAuth 2.1 flow a client like Claude Code runs: DCR, authorize (→ consent
 * page), the person's decision through the web endpoints, then the code exchange.
 */
export async function connect(
  app: TestApp,
  person: Client,
  opts: {
    scopes: McpScope[];
    spaceIds?: string[] | null;
    clientId?: string;
    redirectUri?: string;
    state?: string;
  },
): Promise<Connected> {
  const redirectUri = opts.redirectUri ?? REDIRECT;
  let clientId = opts.clientId;
  if (!clientId) {
    const reg = await register(app, [redirectUri]);
    if (reg.status !== 201) throw new Error(`register failed ${JSON.stringify(reg.json)}`);
    clientId = reg.json.client_id as string;
  }
  const { verifier, challenge } = pkce();
  const query = {
    response_type: 'code' as const,
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256' as const,
    scope: opts.scopes.join(' '),
    state: opts.state ?? 'xyz-state',
    resource: RESOURCE,
  };
  const authorize = await http(app, 'GET', `/oauth/authorize?${new URLSearchParams(query)}`);
  if (authorize.status !== 302) throw new Error(`authorize ${authorize.status}`);
  const consent = await person.api.call('getMcpConsent', { query });
  const decision = await person.api.call('approveMcpConsent', {
    body: {
      ...query,
      consentToken: consent.consentToken,
      scopes: opts.scopes,
      spaceIds: opts.spaceIds ?? null,
      duration: '30d',
      label: 'Test laptop',
    },
  });
  const back = new URL(decision.redirectTo);
  const code = back.searchParams.get('code')!;
  const token = await http(app, 'POST', '/oauth/token', {
    form: {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
      resource: RESOURCE,
    },
  });
  if (token.status !== 200) throw new Error(`token ${token.status} ${JSON.stringify(token.json)}`);
  return {
    clientId,
    access: token.json.access_token as string,
    refresh: token.json.refresh_token as string,
    grantId: decision.grantId!,
    verifier,
  };
}
