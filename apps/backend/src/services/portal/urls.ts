/**
 * Site URLs and cache tags (doc 17 §9 URL table). URLs are the Docusaurus ones: the default
 * locale has no prefix, the others are `/<locale>/...`. The Next.js site tags every Hub
 * fetch with these names; a publish revalidates exactly the tags it touched.
 */

export const localePrefix = (locale: string, defaultLocale: string) =>
  locale === defaultLocale ? '' : `/${locale}`;

export const homePath = (locale: string, defaultLocale: string) =>
  localePrefix(locale, defaultLocale) || '/';

/** Doc and category pages: `slug` is the doc slug or `category/<x>`. */
export const docPath = (locale: string, defaultLocale: string, version: string, slug: string) =>
  `${localePrefix(locale, defaultLocale)}/docs/${version}/${slug}`;

export const blogPath = (locale: string, defaultLocale: string, rest = '') =>
  `${localePrefix(locale, defaultLocale)}/blog${rest ? `/${rest}` : ''}`;

export const postPath = (locale: string, defaultLocale: string, slug: string) =>
  blogPath(locale, defaultLocale, slug);

/** Docusaurus blog tag URLs use the tag lower-cased with spaces as dashes. */
export const tagSlug = (tag: string) =>
  tag
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}_-]/gu, '');

export const POSTS_PER_PAGE = 10;

export const TAGS = {
  all: 'portal:all',
  site: 'portal:site',
  paths: 'portal:paths',
  blog: 'portal:blog',
  redirects: 'portal:redirects',
  media: 'portal:media',
  sidebar: (version: string, locale: string) => `portal:sidebar:${version}:${locale}`,
  page: (version: string, locale: string, slug: string) =>
    `portal:page:${version}:${locale}:${slug}`,
  post: (locale: string, slug: string) => `portal:post:${locale}:${slug}`,
};

const SEGMENT_MAP: Record<string, string> = {
  ç: 'c',
  ğ: 'g',
  ı: 'i',
  İ: 'i',
  ö: 'o',
  ş: 's',
  ü: 'u',
};

/** Kebab-case URL segment from a title ("Hızlı Başlangıç" → `hizli-baslangic`). */
export function slugSegment(title: string): string {
  const out = title
    .replace(/[çğıİöşüÇĞÖŞÜ]/g, (ch) => SEGMENT_MAP[ch.toLowerCase()] ?? SEGMENT_MAP[ch] ?? ch)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
  return out || 'page';
}

export const joinSlug = (parent: string | null | undefined, segment: string) =>
  parent ? `${parent}/${segment}` : segment;

/** Numeric compare of release names (1.10.0 > 1.9.2); `next` sorts above every release. */
export function compareVersions(a: string, b: string) {
  if (a === b) return 0;
  if (a === 'next') return 1;
  if (b === 'next') return -1;
  const pa = a.split(/[.-]/).map((p) => (/^\d+$/.test(p) ? Number(p) : p));
  const pb = b.split(/[.-]/).map((p) => (/^\d+$/.test(p) ? Number(p) : p));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    return String(x) < String(y) ? -1 : 1;
  }
  return 0;
}
