import { AppError } from '../../http/errors';

/**
 * The only outbound HTTP of the Microsoft integrations (Entra token endpoint and Microsoft
 * Graph). Swappable so tests can play Microsoft without a tenant.
 */
export const LOGIN_URL = 'https://login.microsoftonline.com';
export const GRAPH_URL = 'https://graph.microsoft.com/v1.0';

let fetcher: typeof fetch = (...args) => fetch(...args);

export function setMicrosoftFetch(f: typeof fetch | null) {
  fetcher = f ?? ((...args) => fetch(...args));
  tokenCache.clear();
}

export function msFetch(input: string, init: RequestInit = {}): Promise<Response> {
  return fetcher(input, { ...init, signal: init.signal ?? AbortSignal.timeout(30_000) });
}

export interface AppCredentials {
  tenantId: string;
  clientId: string;
  clientSecret: string;
}

/** Graph or Entra answered with an error; `code` is Graph's `error.code` or the OAuth error. */
export class GraphError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function errorOf(res: Response): Promise<GraphError> {
  const body = (await res.json().catch(() => null)) as {
    error?: { code?: string; message?: string } | string;
    error_description?: string;
  } | null;
  if (body && typeof body.error === 'string') {
    return new GraphError(res.status, body.error, body.error_description ?? body.error);
  }
  const err = body?.error;
  return new GraphError(
    res.status,
    (typeof err === 'object' && err?.code) || `http_${res.status}`,
    (typeof err === 'object' && err?.message) || res.statusText || `HTTP ${res.status}`,
  );
}

const tokenCache = new Map<string, { token: string; until: number; roles: string[] }>();

/** Roles (application permissions) in an app token's payload; the signature is not ours to check. */
function rolesOf(token: string): string[] {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString());
    return Array.isArray(payload.roles) ? payload.roles.filter((r: unknown) => typeof r === 'string') : [];
  } catch {
    return [];
  }
}

/** App-only Graph token (client credentials), cached until five minutes before it expires. */
export async function appToken(creds: AppCredentials): Promise<{ token: string; roles: string[] }> {
  const key = `${creds.tenantId}\n${creds.clientId}\n${creds.clientSecret}`;
  const hit = tokenCache.get(key);
  if (hit && hit.until > Date.now()) return hit;
  let res: Response;
  try {
    res = await msFetch(`${LOGIN_URL}/${encodeURIComponent(creds.tenantId)}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        scope: 'https://graph.microsoft.com/.default',
      }),
    });
  } catch (err) {
    throw new GraphError(0, 'unreachable', err instanceof Error ? err.message : String(err));
  }
  if (!res.ok) throw await errorOf(res);
  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) throw new GraphError(502, 'no_token', 'no access_token');
  const entry = {
    token: json.access_token,
    until: Date.now() + Math.max(60, (json.expires_in ?? 3600) - 300) * 1000,
    roles: rolesOf(json.access_token),
  };
  tokenCache.set(key, entry);
  return entry;
}

export interface GraphRequest {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  headers?: Record<string, string>;
}

/** A Graph call with the app token; `path` is relative to v1.0 or an absolute nextLink. */
export async function graph<T = unknown>(
  creds: AppCredentials,
  path: string,
  req: GraphRequest = {},
): Promise<T> {
  const res = await graphRaw(creds, path, req);
  if (res.status === 204) return null as T;
  return (await res.json()) as T;
}

export async function graphRaw(
  creds: AppCredentials,
  path: string,
  req: GraphRequest & { raw?: RequestInit['body'] } = {},
): Promise<Response> {
  const { token } = await appToken(creds);
  const url = path.startsWith('https://') || path.startsWith('http://') ? path : `${GRAPH_URL}${path}`;
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, ...req.headers };
  let body: RequestInit['body'] | undefined = req.raw;
  if (req.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(req.body);
  }
  let res: Response;
  try {
    res = await msFetch(url, { method: req.method ?? 'GET', headers, body });
  } catch (err) {
    throw new GraphError(0, 'unreachable', err instanceof Error ? err.message : String(err));
  }
  if (!res.ok) throw await errorOf(res);
  return res;
}

/** Every page of a Graph collection (`value` + `@odata.nextLink`), up to `max` items. */
export async function graphAll<T>(creds: AppCredentials, path: string, max = 10_000): Promise<T[]> {
  const out: T[] = [];
  let next: string | undefined = path;
  while (next && out.length < max) {
    const page: { value?: T[]; '@odata.nextLink'?: string } = await graph(creds, next);
    out.push(...(page.value ?? []));
    next = page['@odata.nextLink'];
  }
  return out;
}

/** Maps a Graph failure to the API error the caller sees. */
export function graphAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof GraphError) {
    if (err.status === 401 || err.status === 403 || err.code === 'Authorization_RequestDenied') {
      return new AppError('microsoft_permission_missing', { reason: err.code });
    }
    if (err.status === 404) return new AppError('mount_item_not_found');
    return new AppError('microsoft_graph_failed', { reason: err.code, status: err.status });
  }
  return new AppError('microsoft_graph_failed');
}
