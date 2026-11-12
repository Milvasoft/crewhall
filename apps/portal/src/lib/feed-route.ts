import { fill, strings } from '@/i18n';
import { hub } from '@/lib/hub-server';
import { localePath } from '@/lib/route';
import { absoluteUrl, siteUrl } from '@/lib/site';
import { buildAtom, buildRss, type FeedInput } from '@/lib/feeds';

/** RSS / Atom response for a locale (all published posts of that locale). */
export async function feedResponse(locale: string, kind: 'rss' | 'atom'): Promise<Response> {
  const client = await hub();
  const site = await client.site();
  if (!site.locales.includes(locale)) return new Response('Not found', { status: 404 });
  const posts = await client.posts({ locale, page: 1, pageSize: 0 });
  const input: FeedInput = {
    baseUrl: siteUrl(site),
    blogUrl: absoluteUrl(site, localePath(locale, site.defaultLocale, '/blog')),
    title: fill(strings(locale).feedTitle, { site: site.settings.title }),
    language: locale,
    favicon: site.settings.favicon ? absoluteUrl(site, '/favicon.ico') : null,
    posts: posts.items,
  };
  const body = kind === 'rss' ? buildRss(input) : buildAtom(input);
  return new Response(body, {
    headers: {
      'Content-Type':
        kind === 'rss'
          ? 'application/rss+xml; charset=utf-8'
          : 'application/atom+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=300, s-maxage=600',
    },
  });
}
