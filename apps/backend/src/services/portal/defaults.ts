import type { PortalSiteSettingsData } from '@crewhall/db';
import type { PortalHome, PortalNavigation } from '@crewhall/shared';

/** Settings of a new site; everything is editable in Ayarlar (design 10.17). */
export function defaultSettings(name: string, domain: string | null): PortalSiteSettingsData {
  return {
    title: name,
    tagline: null,
    url: domain ? `https://${domain}` : null,
    revalidateUrl: domain ? `https://${domain}/api/revalidate` : null,
    previewUrl: domain ? `https://${domain}/api/preview` : null,
    timezone: 'Europe/Istanbul',
    titleTemplate: '{page} | {site}',
    logo: { src: null, srcDark: null, alt: name },
    favicon: null,
    socialImage: null,
    nextPublic: false,
    showUntranslatedNotice: true,
    prism: { light: 'github', dark: 'dracula' },
  };
}

/**
 * Starter navbar and footer: docs + blog on the left, language and version dropdowns on the
 * right (system items: hidden, never deleted). Labels are content and editable per locale.
 */
export function defaultNavigation(name: string, defaultLocale: string): PortalNavigation {
  const l = (text: string) => ({ [defaultLocale]: text });
  return {
    navbar: {
      title: l(name),
      logo: { src: null, srcDark: null, alt: name },
      items: [
        { id: 'docs', kind: 'docs', position: 'left', label: l('Docs'), hidden: false },
        { id: 'blog', kind: 'blog', position: 'left', label: l('Blog'), hidden: false },
        { id: 'locale', kind: 'localeDropdown', position: 'right', label: l(''), hidden: false },
        { id: 'version', kind: 'versionDropdown', position: 'right', label: l(''), hidden: false },
      ],
    },
    footer: {
      style: 'dark',
      columns: [],
      copyright: l(`Copyright © {year} ${name}`),
    },
  };
}

export function defaultHome(name: string, defaultLocale: string): PortalHome {
  return {
    sections: [
      {
        id: 'hero',
        type: 'hero',
        hidden: false,
        title: { [defaultLocale]: name },
        badge: { [defaultLocale]: '{version}' },
        description: { [defaultLocale]: '' },
      },
    ],
  };
}

/** System navbar items (design 10.9): cannot be removed, only hidden. */
export const SYSTEM_NAV_KINDS = ['localeDropdown', 'versionDropdown'] as const;
