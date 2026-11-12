import type { Metadata } from 'next';
import { fill, strings } from '@/i18n';
import type { PortalSiteData } from '@/lib/hub';
import { localePath } from '@/lib/route';
import { absoluteUrl, mediaSrc, siteUrl } from '@/lib/site';

/** `{page} | {site}`; the site title alone for the home page (Docusaurus behaviour). */
export function formatTitle(site: PortalSiteData, page: string | null | undefined): string {
  const siteTitle = site.settings.title;
  if (!page || page === siteTitle) return siteTitle;
  const template = site.settings.titleTemplate || '{page} | {site}';
  return template.replace('{page}', page).replace('{site}', siteTitle);
}

export interface PageSeo {
  site: PortalSiteData;
  locale: string;
  /** Page title before the template; null = site title. */
  title: string | null;
  description?: string | null;
  /** Locale-less path, e.g. /docs/1.0.1/welcome. */
  path: string;
  /** Locale → public path of the same page; default: every site locale at the same path. */
  languages?: Record<string, string>;
  /** Public path of the canonical page (e.g. the source language of an untranslated doc). */
  canonical?: string | null;
  noindex?: boolean;
  image?: string | null;
  type?: 'website' | 'article';
  article?: { publishedTime?: string; authors?: string[]; tags?: string[] };
}

export function buildMetadata(p: PageSeo): Metadata {
  const { site, locale } = p;
  const base = siteUrl(site);
  const own = localePath(locale, site.defaultLocale, p.path);
  const languages: Record<string, string> = {};
  const map =
    p.languages ??
    Object.fromEntries(site.locales.map((l) => [l, localePath(l, site.defaultLocale, p.path)]));
  for (const [l, path] of Object.entries(map)) languages[l] = absoluteUrl(site, path);
  const xDefault = map[site.defaultLocale];
  if (xDefault) languages['x-default'] = absoluteUrl(site, xDefault);
  const s = strings(locale);
  const image = mediaSrc(p.image) ?? mediaSrc(site.settings.socialImage);
  const title = formatTitle(site, p.title);
  const description = p.description?.trim() || undefined;
  const noindex = p.noindex || site.preview;
  const canonical = absoluteUrl(site, p.canonical ?? own);

  return {
    ...(base ? { metadataBase: new URL(base) } : {}),
    title: { absolute: title },
    ...(description ? { description } : {}),
    alternates: {
      canonical,
      languages,
      types: {
        'application/rss+xml': [
          {
            url: localePath(locale, site.defaultLocale, '/blog/rss.xml'),
            title: fill(s.feedRss, { site: site.settings.title }),
          },
        ],
        'application/atom+xml': [
          {
            url: localePath(locale, site.defaultLocale, '/blog/atom.xml'),
            title: fill(s.feedAtom, { site: site.settings.title }),
          },
        ],
      },
    },
    icons: { icon: '/favicon.ico' },
    openGraph: {
      title,
      ...(description ? { description } : {}),
      url: absoluteUrl(site, own),
      locale,
      alternateLocale: site.locales.filter((l) => l !== locale),
      type: p.type ?? 'website',
      ...(image ? { images: [absoluteUrl(site, image)] } : {}),
      ...(p.type === 'article' && p.article
        ? {
            publishedTime: p.article.publishedTime,
            authors: p.article.authors,
            tags: p.article.tags,
          }
        : {}),
    },
    twitter: {
      card: 'summary_large_image',
      ...(image ? { images: [absoluteUrl(site, image)] } : {}),
    },
    robots: noindex ? { index: false, follow: true } : { index: true, follow: true },
  };
}

/** JSON for a <script type="application/ld+json">, safe to inline. */
export function jsonLd(data: unknown): string {
  const ls = String.fromCharCode(0x2028);
  const ps = String.fromCharCode(0x2029);
  const bs = String.fromCharCode(92);
  return JSON.stringify(data)
    .split('<')
    .join(`${bs}u003c`)
    .split(ls)
    .join(`${bs}u2028`)
    .split(ps)
    .join(`${bs}u2029`);
}
