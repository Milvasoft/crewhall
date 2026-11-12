import { type Branding, type OrgTheme } from '@crewhall/shared';

interface ManifestIcon {
  src: string;
  sizes: string;
  purpose?: 'any' | 'maskable';
}

export interface WebManifest {
  id: string;
  name: string;
  short_name: string;
  lang: string;
  start_url: string;
  scope: string;
  display: 'standalone';
  theme_color: string;
  background_color: string;
  icons: ManifestIcon[];
}

/** Build icons of the web image (apps/web/public/icons), for an org without its own mark. */
const DEFAULT_ICONS: ManifestIcon[] = [
  { src: '/icons/icon-192.png', sizes: '192x192', purpose: 'any' },
  { src: '/icons/icon-512.png', sizes: '512x512', purpose: 'any' },
  { src: '/icons/maskable-512.png', sizes: '512x512', purpose: 'maskable' },
];

/** Before setup there is no org yet. */
const PRODUCT: Pick<Branding, 'orgName' | 'appName' | 'markUrl' | 'defaultLocale'> = {
  orgName: '',
  appName: 'Crewhall',
  markUrl: null,
  defaultLocale: 'tr',
};

/** Home screens cut names longer than this. */
const SHORT_NAME_MAX = 12;

/**
 * What an installed web app is called and looks like: the org's name, mark and theme, so a
 * white-label install never shows another brand. The mark is stored at 512 px square.
 */
export function buildWebManifest(
  branding: Pick<Branding, 'orgName' | 'appName' | 'markUrl' | 'defaultLocale'> = PRODUCT,
  theme?: Pick<OrgTheme, 'light'>,
): WebManifest {
  const { orgName, appName, markUrl, defaultLocale } = branding;
  const bg = theme?.light.bg ?? '#FFFFFF';
  return {
    id: '/',
    name: orgName && orgName !== appName ? `${orgName} · ${appName}` : appName,
    short_name: orgName && orgName.length <= SHORT_NAME_MAX ? orgName : appName,
    lang: defaultLocale,
    start_url: '/',
    scope: '/',
    display: 'standalone',
    theme_color: bg,
    background_color: bg,
    icons: markUrl
      ? [
          { src: markUrl, sizes: '192x192', purpose: 'any' },
          { src: markUrl, sizes: '512x512', purpose: 'any' },
        ]
      : DEFAULT_ICONS,
  };
}
