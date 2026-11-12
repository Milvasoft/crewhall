/** `https://x.com/a/` → `/a`; `/` stays; `/tr/` → `/tr`. */
export function normalizeUrl(url: string): string {
  let p = url.trim();
  const m = /^[a-z][a-z0-9+.-]*:\/\/[^/]+(\/.*)?$/i.exec(p);
  if (m) p = m[1] ?? '/';
  p = p.replace(/[?#].*$/, '');
  if (!p.startsWith('/')) p = `/${p}`;
  if (p.length > 1) p = p.replace(/\/+$/, '') || '/';
  return p;
}

/**
 * Generated site paths against the old site's (sitemap) paths: `missing` are old URLs the new
 * site will not serve (they need redirects), `extra` are new ones. Domains, query strings and
 * trailing slashes are ignored.
 */
export function compareUrls(
  bundleUrls: string[],
  oldUrls: string[],
): { matched: number; missing: string[]; extra: string[] } {
  const generated = new Set(bundleUrls.map(normalizeUrl));
  const old = new Set(oldUrls.filter((u) => u.trim() !== '').map(normalizeUrl));
  const missing = [...old].filter((u) => !generated.has(u)).sort();
  const extra = [...generated].filter((u) => !old.has(u)).sort();
  return { matched: old.size - missing.length, missing, extra };
}

/** `/` for the default locale, `/<locale>` otherwise. */
export const localePrefix = (locale: string, defaultLocale: string) =>
  locale === defaultLocale ? '' : `/${locale}`;

/** Joins path parts into a site path without empty segments or trailing slash. */
export function sitePath(...parts: string[]): string {
  const joined = parts
    .flatMap((p) => p.split('/'))
    .filter((p) => p !== '')
    .join('/');
  return `/${joined}`;
}
