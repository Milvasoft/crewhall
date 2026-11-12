import { notFound, permanentRedirect } from 'next/navigation';
import type { HubClient, PortalSiteData } from '@/lib/hub';
import { hub } from '@/lib/hub-server';
import { localePath } from '@/lib/route';

export interface PageContext {
  client: HubClient;
  site: PortalSiteData;
  locale: string;
}

/** Hub client + site settings for a page; unknown locales are a 404. */
export async function pageContext(locale: string): Promise<PageContext> {
  const client = await hub();
  const site = await client.site();
  if (!site.locales.includes(locale)) notFound();
  return { client, site, locale };
}

/** Same as pageContext for generateMetadata: never throws for unknown locales. */
export async function metaContext(locale: string): Promise<PageContext | null> {
  try {
    const client = await hub();
    const site = await client.site();
    return site.locales.includes(locale) ? { client, site, locale } : null;
  } catch {
    return null;
  }
}

export function decodeSegment(s: string): string {
  if (!s.includes('%')) return s;
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * A page that does not exist: a Hub-managed redirect (old slugs, removed pages) if there is one,
 * otherwise a real 404.
 */
export async function missing(ctx: PageContext, path: string): Promise<never> {
  const publicPath = localePath(ctx.locale, ctx.site.defaultLocale, path);
  const target = await ctx.client.redirect(publicPath).catch(() => null);
  if (target && target.to !== publicPath) permanentRedirect(target.to);
  notFound();
}
