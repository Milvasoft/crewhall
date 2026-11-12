import type { LocalizedText, PortalPublicVersion, PortalSidebarItem } from '@crewhall/shared';
import { env } from '@/env';
import type { PortalSiteData } from '@/lib/hub';
import { localePath } from '@/lib/route';

/** Per-locale text, falling back to the default locale, then any value. */
export function text(
  value: LocalizedText | undefined,
  locale: string,
  defaultLocale: string,
): string {
  if (!value) return '';
  return value[locale] ?? value[defaultLocale] ?? Object.values(value)[0] ?? '';
}

export function currentVersion(site: PortalSiteData): PortalPublicVersion | null {
  return (
    site.versions.find((v) => v.status === 'current') ??
    site.versions.find((v) => v.status === 'archived') ??
    null
  );
}

/** Versions a visitor may open: released ones, plus `next` when public or previewing. */
export function isVisibleVersion(site: PortalSiteData, version: string): boolean {
  const v = site.versions.find((x) => x.name === version);
  if (!v) return false;
  if (v.status !== 'next') return true;
  return site.settings.nextPublic || site.preview;
}

/** Versions in the navbar picker ("next" is never listed). */
export function pickerVersions(site: PortalSiteData): PortalPublicVersion[] {
  return site.versions.filter((v) => v.showInPicker && v.status !== 'next');
}

/** Canonical base URL without trailing slash ('' when unknown). */
export function siteUrl(site: PortalSiteData | null): string {
  const base = site?.url ?? site?.settings.url ?? env().PORTAL_PUBLIC_URL ?? '';
  return base.replace(/\/+$/, '');
}

export function absoluteUrl(site: PortalSiteData | null, path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  return `${siteUrl(site)}${path.startsWith('/') ? path : `/${path}`}`;
}

export const docPath = (site: PortalSiteData, locale: string, version: string, slug: string) =>
  localePath(locale, site.defaultLocale, `/docs/${version}/${slug.replace(/^\/+/, '')}`);

export const sitePath = (site: PortalSiteData, locale: string, path: string) =>
  localePath(locale, site.defaultLocale, path);

/** First link of a sidebar (Docusaurus `docSidebar`: the first doc or category index). */
export function firstSidebarSlug(items: PortalSidebarItem[]): string | null {
  for (const item of items) {
    if (item.kind === 'doc' && item.slug) return item.slug;
    if (item.kind === 'category') {
      if (item.slug) return item.slug;
      const inner = firstSidebarSlug(item.items ?? []);
      if (inner) return inner;
    }
  }
  return null;
}

/** Media path as the browser loads it: Hub media and old /img URLs are served by this site. */
export function mediaSrc(src: string | null | undefined): string | null {
  if (!src) return null;
  if (/^(https?:)?\/\//i.test(src) || src.startsWith('/')) return src;
  return `/media/${src.replace(/^\/+/, '')}`;
}

/** Replaces `{version}` with the current release label. */
export function withVersion(value: string, site: PortalSiteData): string {
  const v = currentVersion(site);
  return value.replace(/\{version\}/g, v?.label ?? v?.name ?? '');
}

export function copyright(value: string): string {
  return value.replace(/\{year\}/g, String(new Date().getUTCFullYear()));
}
