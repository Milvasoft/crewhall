import { permanentRedirect } from 'next/navigation';
import { missing, pageContext } from '@/lib/page';
import { currentVersion, docPath, firstSidebarSlug } from '@/lib/site';

/** /docs → first doc of the current version (308). */
export default async function DocsRoot({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const ctx = await pageContext(locale);
  const version = currentVersion(ctx.site);
  if (!version) return missing(ctx, '/docs');
  const sidebar = await ctx.client.sidebar(version.name, locale);
  const first = sidebar ? firstSidebarSlug(sidebar.items) : null;
  if (!first) return missing(ctx, '/docs');
  permanentRedirect(docPath(ctx.site, locale, version.name, first));
}
