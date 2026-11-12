/**
 * URL → route mapping shared by the request proxy and the tests. Public URLs equal the old
 * Docusaurus site: the default locale has no prefix, other locales are prefixed (/tr/...).
 * Internally every page lives below /[locale]/..., so the proxy rewrites unprefixed URLs.
 */

export const LOCALE_PATTERN = /^[a-z]{2}(-[A-Z]{2})?$/;
export const VERSION_PATTERN = /^(next|\d+(\.\d+){0,3}([-.][0-9A-Za-z.]+)?)$/;
// Permissive: imported Docusaurus slugs may contain characters such as "," (the Hub decides what exists).
const SLUG_SEGMENT = /^[^\s/?#]+$/;
const PAGE_NUMBER = /^[1-9]\d{0,4}$/;

export type Route =
  | { kind: 'home' }
  | { kind: 'docsRoot' }
  | { kind: 'docsVersionRoot'; version: string }
  | { kind: 'doc'; version: string; slug: string }
  | { kind: 'category'; version: string; category: string }
  | { kind: 'blog'; page: number }
  | { kind: 'blogPost'; slug: string }
  | { kind: 'blogTags' }
  | { kind: 'blogTag'; tag: string; page: number }
  | { kind: 'blogArchive' }
  | { kind: 'blogAuthors' }
  | { kind: 'blogAuthor'; key: string; page: number }
  | { kind: 'rss' }
  | { kind: 'atom' }
  | { kind: 'sitemap' }
  | { kind: 'search' }
  /** Unknown path: Hub-managed redirect, else a real 404. */
  | { kind: 'other'; path: string };

export type Resolution =
  /** Not a page: API, media, Next.js assets. */
  | { action: 'pass' }
  | { action: 'redirect'; location: string; status: 301 | 308 }
  | { action: 'rewrite'; locale: string; internalPath: string; route: Route };

/** First path segments that never belong to the locale route tree. */
const PASS_PREFIXES = ['_next', 'api', 'media', 'img', '__nextjs'];
const PASS_FILES = new Set(['favicon.ico', 'robots.txt']);

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Route of a locale-less path below the locale (segments already split). */
export function matchRoute(segments: string[]): Route {
  const [a, b, c, d, e, ...more] = segments;
  const path = '/' + segments.join('/');
  const other: Route = { kind: 'other', path };
  if (a === undefined) return { kind: 'home' };
  if (a === 'docs') {
    if (b === undefined) return { kind: 'docsRoot' };
    if (!VERSION_PATTERN.test(b)) return other;
    if (c === undefined) return { kind: 'docsVersionRoot', version: b };
    const slugParts = segments.slice(2).map(decode);
    if (!slugParts.every((p) => SLUG_SEGMENT.test(p))) return other;
    if (c === 'category' && slugParts.length === 2) {
      return { kind: 'category', version: b, category: slugParts[1] ?? '' };
    }
    return { kind: 'doc', version: b, slug: slugParts.join('/') };
  }
  if (a === 'blog') {
    if (b === undefined) return { kind: 'blog', page: 1 };
    if (b === 'page' && c !== undefined && PAGE_NUMBER.test(c) && d === undefined) {
      return { kind: 'blog', page: Number(c) };
    }
    if (c === undefined) {
      if (b === 'rss.xml') return { kind: 'rss' };
      if (b === 'atom.xml') return { kind: 'atom' };
      if (b === 'tags') return { kind: 'blogTags' };
      if (b === 'archive') return { kind: 'blogArchive' };
      if (b === 'authors') return { kind: 'blogAuthors' };
      const slug = decode(b);
      return SLUG_SEGMENT.test(slug) ? { kind: 'blogPost', slug } : other;
    }
    if (b === 'tags' && c !== undefined) {
      const tag = decode(c);
      if (d === undefined) return { kind: 'blogTag', tag, page: 1 };
      if (d === 'page' && e !== undefined && PAGE_NUMBER.test(e) && more.length === 0) {
        return { kind: 'blogTag', tag, page: Number(e) };
      }
      return other;
    }
    if (b === 'authors' && c !== undefined) {
      const key = decode(c);
      if (d === undefined) return { kind: 'blogAuthor', key, page: 1 };
      if (d === 'page' && e !== undefined && PAGE_NUMBER.test(e) && more.length === 0) {
        return { kind: 'blogAuthor', key, page: Number(e) };
      }
      return other;
    }
    return other;
  }
  if (a === 'search' && b === undefined) return { kind: 'search' };
  if (a === 'sitemap.xml' && b === undefined) return { kind: 'sitemap' };
  return other;
}

/**
 * Maps a public pathname to the internal route.
 *
 * @param locales Site locales; null when unknown (Hub unreachable): then any segment that looks
 *   like a locale code is taken as one, so prefixed pages keep working from the cache.
 */
export function resolveRoute(
  pathname: string,
  locales: readonly string[] | null,
  defaultLocale: string,
): Resolution {
  const segments = pathname.split('/').filter(Boolean);
  const first = segments[0];
  if (
    first !== undefined &&
    (PASS_PREFIXES.includes(first) || (segments.length === 1 && PASS_FILES.has(first)))
  ) {
    return { action: 'pass' };
  }

  let locale = defaultLocale;
  let rest = segments;
  if (first !== undefined && LOCALE_PATTERN.test(first)) {
    const isLocale = locales ? locales.includes(first) : true;
    if (isLocale) {
      if (first === defaultLocale) {
        // /en/docs/... → /docs/... (the default locale has no prefix)
        const location = '/' + segments.slice(1).join('/');
        return { action: 'redirect', location, status: 301 };
      }
      locale = first;
      rest = segments.slice(1);
    }
  }

  // /blog/page/1 is /blog (Docusaurus never links page 1)
  if (rest[0] === 'blog' && rest[1] === 'page' && rest[2] === '1' && rest.length === 3) {
    return {
      action: 'redirect',
      location: localePath(locale, defaultLocale, '/blog'),
      status: 301,
    };
  }

  const route = matchRoute(rest);
  const internalPath = '/' + [locale, ...rest].join('/');
  return { action: 'rewrite', locale, internalPath, route };
}

/** Public path of a locale-less site path, e.g. ('tr', 'en', '/blog') → '/tr/blog'. */
export function localePath(locale: string, defaultLocale: string, path: string): string {
  const clean = path.startsWith('/') ? path : `/${path}`;
  if (locale === defaultLocale) return clean;
  return clean === '/' ? `/${locale}` : `/${locale}${clean}`;
}

/** Internal (rewritten) path of a public path, used for revalidatePath. */
export function internalPathOf(
  publicPath: string,
  locales: readonly string[] | null,
  defaultLocale: string,
): string | null {
  const r = resolveRoute(publicPath.split(/[?#]/)[0] ?? publicPath, locales, defaultLocale);
  return r.action === 'rewrite' ? r.internalPath : null;
}
