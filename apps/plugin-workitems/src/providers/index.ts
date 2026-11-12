import { createHash, randomBytes } from 'node:crypto';
import type { Sealer, Store } from '../store';
import { ProviderError, type AuthSecret, type Connection, type Provider } from '../types';
import { AzureProvider } from './azure';
import { Http, toBasic, type FetchLike } from './http';
import { isJiraCloud, JiraProvider } from './jira';

/** Azure DevOps as an Entra resource; never changes. */
const AZURE_DEVOPS_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798';
const ENTRA_SCOPE = `${AZURE_DEVOPS_RESOURCE}/.default offline_access`;
const LOGIN = 'https://login.microsoftonline.com';
const REFRESH_MARGIN_MS = 120_000;

export function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export function entraAuthorizeUrl(input: {
  tenant: string;
  clientId: string;
  redirectUri: string;
  state: string;
  challenge: string;
}) {
  const u = new URL(`${LOGIN}/${encodeURIComponent(input.tenant)}/oauth2/v2.0/authorize`);
  u.search = new URLSearchParams({
    client_id: input.clientId,
    response_type: 'code',
    redirect_uri: input.redirectUri,
    response_mode: 'query',
    scope: ENTRA_SCOPE,
    state: input.state,
    code_challenge: input.challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  }).toString();
  return u.toString();
}

interface TokenAnswer {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

export async function entraToken(
  doFetch: FetchLike,
  input: { tenant: string; clientId: string; clientSecret?: string; form: Record<string, string> },
): Promise<Required<Pick<TokenAnswer, 'access_token'>> & TokenAnswer> {
  const res = await doFetch(`${LOGIN}/${encodeURIComponent(input.tenant)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: input.clientId,
      scope: ENTRA_SCOPE,
      ...(input.clientSecret ? { client_secret: input.clientSecret } : {}),
      ...input.form,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const json = (await res.json().catch(() => ({}))) as TokenAnswer;
  if (!res.ok || !json.access_token) throw new ProviderError('auth_failed', res.status);
  return json as Required<Pick<TokenAnswer, 'access_token'>> & TokenAnswer;
}

/** A provider for a connection; an Entra token is refreshed and saved as it rotates. */
export function providerFor(
  conn: Pick<Connection, 'id' | 'provider' | 'baseUrl' | 'auth' | 'installationId'>,
  deps: { sealer: Sealer; fetch: FetchLike; store: Store },
): Provider {
  let secret = JSON.parse(deps.sealer.open(conn.auth)) as AuthSecret;
  let refreshing: Promise<string> | null = null;

  const authorization = async (): Promise<string> => {
    if (secret.kind === 'pat') {
      if (conn.provider === 'azure') return toBasic('', secret.token);
      if (isJiraCloud(conn.baseUrl)) return toBasic(secret.email ?? '', secret.token);
      return `Bearer ${secret.token}`;
    }
    if (secret.accessToken && (secret.expiresAt ?? 0) - Date.now() > REFRESH_MARGIN_MS) {
      return `Bearer ${secret.accessToken}`;
    }
    refreshing ??= refresh().finally(() => {
      refreshing = null;
    });
    return `Bearer ${await refreshing}`;
  };

  const refresh = async () => {
    if (secret.kind !== 'entra') throw new ProviderError('auth_failed');
    const r = await entraToken(deps.fetch, {
      tenant: secret.tenant,
      clientId: secret.clientId,
      clientSecret: secret.clientSecret,
      form: { grant_type: 'refresh_token', refresh_token: secret.refreshToken },
    });
    secret = {
      ...secret,
      accessToken: r.access_token,
      refreshToken: r.refresh_token ?? secret.refreshToken,
      expiresAt: Date.now() + (r.expires_in ?? 3600) * 1000,
    };
    const row = await deps.store.get<Connection>('connection', conn.id);
    if (row) {
      await deps.store.put('connection', conn.id, conn.installationId, {
        ...row,
        auth: deps.sealer.seal(JSON.stringify(secret)),
      });
    }
    return r.access_token;
  };

  const http = new Http(conn.baseUrl, authorization, deps.fetch);
  return conn.provider === 'azure'
    ? new AzureProvider(http, conn.baseUrl)
    : new JiraProvider(http, conn.baseUrl);
}
