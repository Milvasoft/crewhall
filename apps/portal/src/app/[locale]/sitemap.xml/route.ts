import { hub } from '@/lib/hub-server';
import { siteUrl } from '@/lib/site';
import { buildSitemap } from '@/lib/sitemap';

export const dynamic = 'force-dynamic';

/** /sitemap.xml (default locale) and /<locale>/sitemap.xml, with hreflang alternates. */
export async function GET(_req: Request, { params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const client = await hub();
  const site = await client.site();
  if (!site.locales.includes(locale)) return new Response('Not found', { status: 404 });
  const paths = await client.paths();
  const body = buildSitemap({
    baseUrl: siteUrl(site),
    locale,
    defaultLocale: site.defaultLocale,
    paths: paths.items,
  });
  return new Response(body, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=300, s-maxage=600',
    },
  });
}
