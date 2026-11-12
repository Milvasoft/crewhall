import { PublicBootstrap } from '@crewhall/shared';

/**
 * "calisma.kurum.com", "https://calisma.kurum.com/drive" → "https://calisma.kurum.com".
 * Without a scheme https is assumed; http works only when typed (local test servers).
 */
export function normalizeServerUrl(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (!url.hostname || url.username || url.password) return null;
  return url.origin;
}

export type ServerCheck =
  | { ok: true; origin: string; bootstrap: PublicBootstrap }
  | { ok: false; error: 'invalid' | 'unreachable' | 'notCrewhall' | 'needsSetup' };

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Reads the public bootstrap of a server: is it a Crewhall that is set up, and whose brand. */
export async function checkServer(
  input: string,
  fetchFn: Fetch,
  timeoutMs = 10_000,
): Promise<ServerCheck> {
  const origin = normalizeServerUrl(input);
  if (!origin) return { ok: false, error: 'invalid' };
  let res: Response;
  try {
    res = await fetchFn(`${origin}/api/v1/bootstrap`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { ok: false, error: 'unreachable' };
  }
  if (!res.ok) return { ok: false, error: 'notCrewhall' };
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return { ok: false, error: 'notCrewhall' };
  }
  const parsed = PublicBootstrap.safeParse(json);
  if (!parsed.success) return { ok: false, error: 'notCrewhall' };
  if (parsed.data.needsSetup) return { ok: false, error: 'needsSetup' };
  return { ok: true, origin, bootstrap: parsed.data };
}

/** True when `url` is a page of the configured server. */
export function isServerUrl(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}
