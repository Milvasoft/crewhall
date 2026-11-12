import type { PortalPublicPath } from '@crewhall/shared';
import { escapeXml } from '@/lib/xml';

/**
 * sitemap.xml of one locale (Docusaurus format plus xhtml:link hreflang alternates). Pages that
 * are noindex and everything under /docs/next/ are left out.
 */
export function buildSitemap(options: {
  baseUrl: string;
  locale: string;
  defaultLocale: string;
  paths: PortalPublicPath[];
}): string {
  const { baseUrl, locale, defaultLocale } = options;
  const abs = (p: string) => `${baseUrl}${p}`;
  const isNext = (p: string) => /^(\/[a-z]{2}(-[A-Z]{2})?)?\/docs\/next(\/|$)/.test(p);
  const urls = options.paths
    .filter((p) => p.locale === locale && !p.noindex && !isNext(p.path))
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((p) => {
      const lines = [`<url><loc>${escapeXml(abs(p.path))}</loc>`];
      if (p.updatedAt) lines.push(`<lastmod>${escapeXml(p.updatedAt)}</lastmod>`);
      lines.push('<changefreq>weekly</changefreq><priority>0.5</priority>');
      const alternates = Object.entries(p.alternates).filter(([, path]) => !isNext(path));
      if (alternates.length > 1) {
        for (const [l, path] of alternates) {
          lines.push(
            `<xhtml:link rel="alternate" hreflang="${escapeXml(l)}" href="${escapeXml(abs(path))}"/>`,
          );
        }
        const def = p.alternates[defaultLocale];
        if (def) {
          lines.push(
            `<xhtml:link rel="alternate" hreflang="x-default" href="${escapeXml(abs(def))}"/>`,
          );
        }
      }
      lines.push('</url>');
      return lines.join('');
    });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:news="http://www.google.com/schemas/sitemap-news/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1" xmlns:video="http://www.google.com/schemas/sitemap-video/1.1">',
    ...urls,
    '</urlset>',
  ].join('\n');
}

/** robots.txt: everything but the unreleased `next` docs and the API. */
export function buildRobots(options: {
  baseUrl: string;
  locales: string[];
  defaultLocale: string;
}): string {
  const lines = ['User-agent: *', 'Disallow: /api/', 'Disallow: /docs/next/'];
  for (const l of options.locales) {
    if (l !== options.defaultLocale) lines.push(`Disallow: /${l}/docs/next/`);
  }
  lines.push('');
  if (options.baseUrl) {
    for (const l of options.locales) {
      lines.push(
        `Sitemap: ${options.baseUrl}${l === options.defaultLocale ? '' : `/${l}`}/sitemap.xml`,
      );
    }
  }
  return `${lines.join('\n')}\n`;
}
