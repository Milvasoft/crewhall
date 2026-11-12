import { env } from '@/env';
import { hub } from '@/lib/hub-server';
import { siteUrl } from '@/lib/site';
import { buildRobots } from '@/lib/sitemap';

export const dynamic = 'force-dynamic';

export async function GET() {
  const site = await (await hub()).site().catch(() => null);
  const body = buildRobots({
    baseUrl: site ? siteUrl(site) : (env().PORTAL_PUBLIC_URL ?? '').replace(/\/+$/, ''),
    locales: site?.locales ?? [env().PORTAL_DEFAULT_LOCALE],
    defaultLocale: site?.defaultLocale ?? env().PORTAL_DEFAULT_LOCALE,
  });
  return new Response(body, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
