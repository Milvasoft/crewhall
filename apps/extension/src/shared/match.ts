/**
 * Which saved logins belong to a page. Deliberately narrow: the same host and port (www aside), so
 * a login for example.com is not offered on user-content.example.com, and an https login is never
 * offered on an http page. A wrong miss costs a copy; a wrong match can hand a password to whoever
 * controls a subdomain.
 */

function parse(url: string): URL | null {
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u : null;
  } catch {
    return null;
  }
}

const bare = (host: string) => host.toLowerCase().replace(/^www\./, '');

export function uriMatches(itemUri: string, pageUrl: string): boolean {
  const item = parse(itemUri);
  const page = parse(pageUrl);
  if (!item || !page) return false;
  if (item.protocol === 'https:' && page.protocol !== 'https:') return false;
  if (item.port !== page.port) return false;
  return bare(item.hostname) === bare(page.hostname);
}

export const matchesAny = (uris: readonly string[], pageUrl: string) =>
  uris.some((u) => uriMatches(u, pageUrl));

/** Plain http is only fine on this machine: a password must not cross the network in the clear. */
export function isSafeForFilling(pageUrl: string): boolean {
  const page = parse(pageUrl);
  if (!page) return false;
  return (
    page.protocol === 'https:' ||
    page.hostname === 'localhost' ||
    page.hostname === '127.0.0.1' ||
    page.hostname.endsWith('.localhost')
  );
}

export function hostOf(url: string): string {
  const u = parse(url);
  return u ? bare(u.hostname) : '';
}
