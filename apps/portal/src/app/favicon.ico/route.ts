import { hub } from '@/lib/hub-server';

export const dynamic = 'force-dynamic';

/** The site favicon from the Hub settings (Docusaurus served /img/favicon.ico). */
export async function GET() {
  const client = await hub();
  const site = await client.site().catch(() => null);
  const favicon = site?.settings.favicon;
  if (!favicon) return new Response(null, { status: 404 });
  const path = favicon.replace(/^\/?media\//, '').replace(/^\/+/, '');
  const res = await client.media(path).catch(() => null);
  if (!res?.ok || !res.body) return new Response(null, { status: 404 });
  return new Response(res.body, {
    headers: {
      'Content-Type': res.headers.get('content-type') ?? 'image/x-icon',
      'Cache-Control': 'public, max-age=3600, s-maxage=86400',
    },
  });
}
