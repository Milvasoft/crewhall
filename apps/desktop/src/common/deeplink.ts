export const PROTOCOL = 'crewhall';

export type DeepLink =
  /** A page of the configured server: crewhall://chat/abc → /chat/abc. */
  | { kind: 'open'; path: string }
  /** Set up a server: crewhall://connect?server=calisma.kurum.com (asks before switching). */
  | { kind: 'connect'; server: string };

/**
 * Parses crewhall:// links. `crewhall://open/<path>`, `crewhall:///<path>` and
 * `crewhall://<path>` all open <path> on the server; a link can never point elsewhere.
 */
export function parseDeepLink(raw: string): DeepLink | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== `${PROTOCOL}:`) return null;
  const host = url.hostname.toLowerCase();
  if (host === 'connect') {
    const server = url.searchParams.get('server');
    return server ? { kind: 'connect', server } : null;
  }
  const rest = host === 'open' || host === '' ? url.pathname : `/${url.hostname}${url.pathname}`;
  // Collapse "//evil.example" (protocol-relative) and backslashes into plain paths.
  const path = `/${rest.replace(/\\/g, '/').replace(/^\/+/, '')}`;
  return { kind: 'open', path: `${path}${url.search}${url.hash}` };
}

/** The server address a link opens, or null if it would leave the server. */
export function deepLinkTarget(path: string, origin: string): string | null {
  try {
    const url = new URL(path, origin);
    return url.origin === origin ? url.href : null;
  } catch {
    return null;
  }
}

/** Windows and Linux hand the link over as a command line argument. */
export function findDeepLinkArg(argv: readonly string[]): string | undefined {
  return argv.find((a) => a.toLowerCase().startsWith(`${PROTOCOL}://`));
}
