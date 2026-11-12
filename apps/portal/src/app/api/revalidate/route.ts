import { revalidatePath, revalidateTag } from 'next/cache';
import { env } from '@/env';
import { createHubClient } from '@/lib/hub';
import { internalPathOf } from '@/lib/route';
import { SIGNATURE_HEADER, verifyRevalidate } from '@/lib/signature';

export const dynamic = 'force-dynamic';

/**
 * Called by the Hub worker after a publish: HMAC-signed `{ site, publish, paths, tags, ts }`.
 * Tags expire immediately (the next request renders fresh data); paths are revalidated both
 * as public URLs and as their internal /[locale]/... routes.
 */
export async function POST(req: Request) {
  const e = env();
  if (!e.PORTAL_REVALIDATE_SECRET) {
    return Response.json(
      { ok: false, error: 'revalidate secret is not configured' },
      { status: 500 },
    );
  }
  const raw = await req.text();
  const result = verifyRevalidate(
    e.PORTAL_REVALIDATE_SECRET,
    raw,
    req.headers.get(SIGNATURE_HEADER),
  );
  if (!result.ok) {
    return Response.json({ ok: false, error: result.reason }, { status: result.status });
  }
  const { payload } = result;

  // Locale list for mapping public paths to routes (cached site data; read before expiring it).
  let locales: string[] | null = null;
  let defaultLocale = e.PORTAL_DEFAULT_LOCALE;
  try {
    const site = await createHubClient({
      baseUrl: e.HUB_API_URL,
      token: e.PORTAL_CONTENT_TOKEN,
    }).site();
    locales = site.locales;
    defaultLocale = site.defaultLocale;
  } catch {
    // Hub unreachable: fall back to locale-looking prefixes
  }

  const tags = [...new Set(payload.tags.filter((t) => t.length > 0 && t.length <= 256))];
  for (const tag of tags) revalidateTag(tag, { expire: 0 });

  const paths = new Set<string>();
  for (const p of payload.paths) {
    if (!p.startsWith('/') || p.startsWith('//')) continue;
    paths.add(p);
    const internal = internalPathOf(p, locales, defaultLocale);
    if (internal) paths.add(internal);
  }
  for (const p of paths) revalidatePath(p);

  return Response.json({ ok: true, tags: tags.length, paths: payload.paths.length });
}
