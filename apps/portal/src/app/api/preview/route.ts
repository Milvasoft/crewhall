import { cookies, draftMode } from 'next/headers';
import { redirect } from 'next/navigation';
import { env } from '@/env';
import { createHubClient } from '@/lib/hub';
import { PREVIEW_COOKIE } from '@/lib/hub-server';
import { safeRedirectPath } from '@/lib/redirect-path';

export const dynamic = 'force-dynamic';

/**
 * Hub "Önizle": /api/preview?token=<signed 1 h token>&path=/docs/next/...
 * The Hub validates the token (site settings answer `preview: true`); then draft mode is on and
 * the token is kept in an httpOnly cookie for the Hub calls of the following requests.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get('token');
  const path = safeRedirectPath(url.searchParams.get('path'));
  if (!token || token.length > 4096) return new Response('Missing preview token', { status: 401 });

  const e = env();
  const client = createHubClient({
    baseUrl: e.HUB_API_URL,
    token: e.PORTAL_CONTENT_TOKEN,
    previewToken: token,
  });
  const site = await client.site().catch(() => null);
  if (!site?.preview) return new Response('Invalid or expired preview token', { status: 401 });

  (await draftMode()).enable();
  (await cookies()).set(PREVIEW_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60,
  });
  redirect(path);
}
