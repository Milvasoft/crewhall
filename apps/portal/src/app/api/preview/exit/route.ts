import { cookies, draftMode } from 'next/headers';
import { redirect } from 'next/navigation';
import { PREVIEW_COOKIE } from '@/lib/hub-server';

export const dynamic = 'force-dynamic';

/** Leaves preview: back to the page the editor was on (same origin only). */
export async function GET(req: Request) {
  (await draftMode()).disable();
  (await cookies()).delete(PREVIEW_COOKIE);
  const url = new URL(req.url);
  let target = '/';
  const referer = req.headers.get('referer');
  if (referer) {
    try {
      const r = new URL(referer);
      if (r.host === url.host && !r.pathname.startsWith('/api/')) target = r.pathname + r.search;
    } catch {
      // ignore a malformed referer
    }
  }
  redirect(target);
}
