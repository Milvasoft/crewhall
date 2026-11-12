/**
 * The only outbound HTTP of calendar sync (provider token endpoints and APIs). Swappable so
 * tests can play Google and Microsoft.
 */
let fetcher: typeof fetch = (...args) => fetch(...args);

export function setCalendarFetch(f: typeof fetch | null) {
  fetcher = f ?? ((...args) => fetch(...args));
}

export function calendarFetch(input: string, init: RequestInit): Promise<Response> {
  return fetcher(input, { ...init, signal: init.signal ?? AbortSignal.timeout(20_000) });
}

/** A provider API answered with an error (or could not be reached: status 0). */
export class ProviderError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
  ) {
    super(`provider ${status}: ${reason}`);
  }

  /** The sync cursor is no longer valid; start over with a full sync. */
  get gone() {
    return (
      this.status === 410 ||
      this.reason === 'fullSyncRequired' ||
      this.reason === 'syncStateNotFound' ||
      this.reason === 'resyncRequired'
    );
  }
}

/** Error code of a Google or Graph error body (`error.code` / `error.errors[0].reason`). */
function reasonOf(json: unknown, status: number): string {
  const err = (json as { error?: unknown } | null)?.error;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') {
    const e = err as { code?: unknown; status?: unknown; errors?: { reason?: unknown }[] };
    const first = e.errors?.[0]?.reason;
    if (typeof first === 'string') return first;
    if (typeof e.code === 'string') return e.code;
    if (typeof e.status === 'string') return e.status;
  }
  return `http_${status}`;
}

export interface ApiRequest {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  token: string;
  body?: unknown;
  headers?: Record<string, string>;
}

/** JSON call with a bearer token; null for 204. Throws ProviderError. */
export async function apiCall(url: string, req: ApiRequest): Promise<unknown> {
  let res: Response;
  try {
    res = await calendarFetch(url, {
      method: req.method ?? 'GET',
      headers: {
        authorization: `Bearer ${req.token}`,
        accept: 'application/json',
        ...(req.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...req.headers,
      },
      body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
    });
  } catch {
    throw new ProviderError(0, 'unreachable');
  }
  if (res.status === 204) return null;
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) throw new ProviderError(res.status, reasonOf(json, res.status));
  return json;
}
