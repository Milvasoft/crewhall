/**
 * Cache tag names shared with the Hub (it sends them to /api/revalidate on publish).
 * Every Hub fetch also carries `portal:all`, so a full refresh is one tag.
 */
export const TAG_ALL = 'portal:all';
export const TAG_SITE = 'portal:site';
export const TAG_PATHS = 'portal:paths';
export const TAG_BLOG = 'portal:blog';
export const TAG_REDIRECTS = 'portal:redirects';
export const TAG_MEDIA = 'portal:media';

export const sidebarTag = (version: string, locale: string) =>
  `portal:sidebar:${version}:${locale}`;
export const pageTag = (version: string, locale: string, slug: string) =>
  `portal:page:${version}:${locale}:${slug}`;
export const postTag = (locale: string, slug: string) => `portal:post:${locale}:${slug}`;
