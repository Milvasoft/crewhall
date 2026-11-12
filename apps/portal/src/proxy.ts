import { NextResponse, type NextRequest } from 'next/server';
import { env } from '@/env';
import { createHubClient } from '@/lib/hub';
import { resolveRoute } from '@/lib/route';

/**
 * Locale routing with Docusaurus URLs: /docs/... is the default locale (rewritten to
 * /en/docs/...), /tr/docs/... another locale, /en/... redirects to the unprefixed URL.
 * The site's locales are read from the Hub and kept for a minute.
 */

interface LocaleInfo {
  locales: string[] | null;
  defaultLocale: string;
}

const TTL_MS = 60_000;
let cache: { at: number; info: LocaleInfo } | null = null;
let inflight: Promise<LocaleInfo> | null = null;

async function localeInfo(): Promise<LocaleInfo> {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.info;
  inflight ??= (async () => {
    const e = env();
    try {
      const client = createHubClient({
        baseUrl: e.HUB_API_URL,
        token: e.PORTAL_CONTENT_TOKEN,
        fetch: (input, init) =>
          fetch(input, {
            ...init,
            cache: 'no-store',
            next: undefined,
            signal: AbortSignal.timeout(3000),
          }),
      });
      const site = await client.site();
      const info = { locales: site.locales, defaultLocale: site.defaultLocale };
      cache = { at: Date.now(), info };
      return info;
    } catch {
      // Hub down: keep serving with the last known (or a permissive) locale list
      const info = cache?.info ?? { locales: null, defaultLocale: e.PORTAL_DEFAULT_LOCALE };
      cache = { at: Date.now() - TTL_MS + 10_000, info };
      return info;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const { locales, defaultLocale } = await localeInfo();
  const result = resolveRoute(pathname, locales, defaultLocale);
  if (result.action === 'pass') return NextResponse.next();
  if (result.action === 'redirect') {
    const url = request.nextUrl.clone();
    url.pathname = result.location;
    url.search = search;
    return NextResponse.redirect(url, result.status);
  }
  const url = request.nextUrl.clone();
  // prefixed locales already are the internal path
  if (result.internalPath === pathname) return NextResponse.next();
  url.pathname = result.internalPath;
  return NextResponse.rewrite(url);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|api/|media/|img/|favicon\\.ico|robots\\.txt).*)'],
};
