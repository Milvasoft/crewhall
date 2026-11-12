import { hub } from '@/lib/hub-server';

export const dynamic = 'force-dynamic';

const PASS_HEADERS = ['content-type', 'content-length', 'last-modified', 'etag'];

/** Streams Hub media (/media/...; old /img/... URLs are rewritten here). */
export async function GET(_req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  if (
    !path.length ||
    path.some((p) => p === '..' || p === '.' || p.includes(String.fromCharCode(92)))
  ) {
    return new Response('Not found', { status: 404 });
  }
  const client = await hub();
  let res: Response;
  try {
    res = await client.media(path.join('/'));
  } catch {
    return new Response('Media unavailable', { status: 502 });
  }
  if (!res.ok || !res.body) {
    return new Response('Not found', { status: res.status === 404 ? 404 : 502 });
  }
  const headers = new Headers();
  for (const h of PASS_HEADERS) {
    const v = res.headers.get(h);
    if (v) headers.set(h, v);
  }
  headers.set(
    'Cache-Control',
    client.preview ? 'private, no-store' : 'public, max-age=3600, s-maxage=86400',
  );
  headers.set('X-Content-Type-Options', 'nosniff');
  // SVGs may carry scripts: never let them run as a document on this origin
  if ((headers.get('content-type') ?? '').includes('svg')) {
    headers.set(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    );
  }
  return new Response(res.body, { status: 200, headers });
}
