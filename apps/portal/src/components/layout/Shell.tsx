import type { ReactNode } from 'react';
import { Footer } from '@/components/layout/Footer';
import { Navbar, type NavItemData, type NavbarLabels } from '@/components/layout/Navbar';
import { languageName, strings } from '@/i18n';
import { hub } from '@/lib/hub-server';
import type { HubClient, PortalSiteData } from '@/lib/hub';
import { localePath } from '@/lib/route';
import {
  currentVersion,
  docPath,
  firstSidebarSlug,
  isVisibleVersion,
  mediaSrc,
  pickerVersions,
  sitePath,
  text,
} from '@/lib/site';

export interface ShellProps {
  site: PortalSiteData;
  locale: string;
  /** Locale-less public path of the page, e.g. /docs/1.0.1/welcome or /blog. */
  path: string;
  section?: 'docs' | 'blog' | null;
  /** Docs version of the page (doc pages); other pages use the current version. */
  version?: string | null;
  /** Same page in other versions: version → doc slug. */
  versionSlugs?: Record<string, string>;
  /** Mobile drawer's first menu. */
  secondary?: ReactNode;
  children: ReactNode;
}

async function firstDocHref(
  client: HubClient,
  site: PortalSiteData,
  locale: string,
  version: string,
) {
  const sidebar = await client.sidebar(version, locale).catch(() => null);
  const slug = sidebar ? firstSidebarSlug(sidebar.items) : null;
  return slug ? docPath(site, locale, version, slug) : sitePath(site, locale, `/docs/${version}`);
}

/** Internal links are locale-prefixed like Docusaurus' `to` links. */
function navHref(site: PortalSiteData, locale: string, href: string): string {
  if (!href.startsWith('/')) return href;
  const first = href.split('/')[1] ?? '';
  if (site.locales.includes(first)) return href;
  return localePath(locale, site.defaultLocale, href);
}

export async function Shell({
  site,
  locale,
  path,
  section = null,
  version = null,
  versionSlugs,
  secondary = null,
  children,
}: ShellProps) {
  const s = strings(locale);
  const client = await hub();
  const current = currentVersion(site);
  const ctxVersion = version ?? current?.name ?? null;
  const ctxLabel = site.versions.find((v) => v.name === ctxVersion)?.label ?? ctxVersion ?? '';
  const t = (v: Record<string, string> | undefined) => text(v, locale, site.defaultLocale);

  const docsHref = ctxVersion
    ? await firstDocHref(client, site, locale, ctxVersion)
    : sitePath(site, locale, '/docs');
  const picker = pickerVersions(site);
  if (
    ctxVersion &&
    !picker.some((v) => v.name === ctxVersion) &&
    isVisibleVersion(site, ctxVersion)
  ) {
    const v = site.versions.find((x) => x.name === ctxVersion);
    if (v) picker.unshift(v);
  }
  const versionItems = await Promise.all(
    picker.map(async (v) => {
      const same = versionSlugs?.[v.name];
      const href =
        v.name === ctxVersion && section === 'docs'
          ? sitePath(site, locale, path)
          : same
            ? docPath(site, locale, v.name, same)
            : await firstDocHref(client, site, locale, v.name);
      return { label: v.label, href, active: v.name === ctxVersion };
    }),
  );

  const items: { position: 'left' | 'right'; data: NavItemData }[] = [];
  for (const item of site.navigation.navbar.items) {
    if (item.hidden) continue;
    const label = t(item.label);
    let data: NavItemData | null = null;
    switch (item.kind) {
      case 'docs':
        data = { kind: 'link', label, href: docsHref, external: false, active: section === 'docs' };
        break;
      case 'blog':
        data = {
          kind: 'link',
          label,
          href: sitePath(site, locale, '/blog'),
          external: false,
          active: section === 'blog',
        };
        break;
      case 'link':
      case 'doc': {
        if (!item.href) break;
        const href = navHref(site, locale, item.href);
        const external = /^(https?:)?\/\//i.test(href);
        data = {
          kind: 'link',
          label,
          href,
          external,
          active: !external && href === sitePath(site, locale, path),
        };
        break;
      }
      case 'localeDropdown':
        if (site.locales.length < 2) break;
        data = {
          kind: 'dropdown',
          variant: 'locale',
          label: label || languageName(locale, locale),
          href: '#',
          items: site.locales.map((l) => ({
            label: languageName(l, l),
            href: localePath(l, site.defaultLocale, path),
            active: l === locale,
            lang: l,
          })),
        };
        break;
      case 'versionDropdown':
        if (!versionItems.length) break;
        data = {
          kind: 'dropdown',
          variant: 'version',
          label: ctxLabel,
          href: versionItems.find((v) => v.active)?.href ?? docsHref,
          items: versionItems,
        };
        break;
    }
    if (data) items.push({ position: item.position, data });
  }

  const logo = site.navigation.navbar.logo.src ? site.navigation.navbar.logo : site.settings.logo;
  const labels: NavbarLabels = {
    mainNavigation: s.mainNavigation,
    toggleNavigation: s.toggleNavigation,
    closeNavigation: s.closeNavigation,
    backToMainMenu: s.backToMainMenu,
    opensInNewTab: s.opensInNewTab,
    colorMode: {
      aria: s.colorModeAria,
      light: s.colorModeLight,
      dark: s.colorModeDark,
      system: s.colorModeSystem,
    },
    search: {
      placeholder: s.searchPlaceholder,
      seeAll: s.searchSeeAll,
      noResults: s.searchNoResults,
    },
  };

  return (
    <>
      <div role="region" aria-label={s.skipToContent}>
        <a className="skipToContent_fXgn" href="#__docusaurus_skipToContent_fallback">
          {s.skipToContent}
        </a>
      </div>
      <Navbar
        brand={{
          href: sitePath(site, locale, '/'),
          title: t(site.navigation.navbar.title) || site.settings.title,
          logo: logo.src
            ? {
                src: mediaSrc(logo.src) ?? logo.src,
                srcDark: mediaSrc(logo.srcDark),
                alt: logo.alt,
              }
            : null,
        }}
        left={items.filter((i) => i.position === 'left').map((i) => i.data)}
        right={items.filter((i) => i.position === 'right').map((i) => i.data)}
        labels={labels}
        search={{
          locale,
          version: section === 'docs' ? ctxVersion : null,
          searchPagePath: sitePath(site, locale, '/search'),
        }}
        secondary={secondary}
      />
      <div
        id="__docusaurus_skipToContent_fallback"
        className="theme-layout-main main-wrapper mainWrapper_z2l0"
      >
        {children}
      </div>
      <Footer site={site} locale={locale} />
    </>
  );
}
