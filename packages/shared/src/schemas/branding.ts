import { z } from 'zod';
import { Locale, ImageUpload } from './common';
import { DesktopInfo } from './desktop';

const Hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);

/**
 * Tenant branding (organizations.branding). White-label: nothing about the
 * example tenant (Milvasoft) is hardcoded in code; it all comes from here.
 * Logos are served URLs (signed or public), not blob ids, so clients can render directly.
 */
export const Branding = z.object({
  orgName: z.string().min(1).max(80),
  /** Product name shown in the shell; defaults to "Crewhall". */
  appName: z.string().min(1).max(40),
  logoLightUrl: z.url().nullable(),
  logoDarkUrl: z.url().nullable(),
  markUrl: z.url().nullable(),
  faviconUrl: z.url().nullable(),
  /** Show the "Crewhall ile" / "with Crewhall" line on login and emails. */
  showPoweredBy: z.boolean(),
  defaultLocale: Locale,
});
export type Branding = z.infer<typeof Branding>;

export const ThemeMode = z.object({
  bg: Hex,
  surface: Hex,
  accent: Hex,
});

/** WCAG relative luminance of #rgb or #rrggbb; null for anything else. */
function luminanceOf(hex: string): number | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const h = m[1]!.length === 3 ? [...m[1]!].map((c) => c + c).join('') : m[1]!;
  const [r, g, b] = [0, 2, 4].map((i) => {
    const v = parseInt(h.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Black or white, whichever reads better on this background: one of them is always at least
 * 4.5:1. The brand's yellow gets black; an org's darker accent gets white.
 */
export function readableTextOn(background: string): '#000000' | '#FFFFFF' {
  const l = luminanceOf(background);
  if (l === null) return '#000000';
  return (l + 0.05) / 0.05 >= 1.05 / (l + 0.05) ? '#000000' : '#FFFFFF';
}

/** Published org theme (org_themes). Clients may also load `/api/theme.css`. */
export const OrgTheme = z.object({
  version: z.number().int(),
  light: ThemeMode,
  dark: ThemeMode,
  radius: z.enum(['sm', 'md', 'lg']),
  density: z.enum(['compact', 'comfortable']),
  login: z.object({
    source: z.enum(['scene', 'image', 'color']),
    imageUrl: z.url().nullable(),
    darkImageUrl: z.url().nullable(),
    texts: z.object({ tr: z.string(), en: z.string() }).partial(),
  }),
});
export type OrgTheme = z.infer<typeof OrgTheme>;

/** Defaults used by setup and by clients before branding loads (Crewhall brand). */
export const DEFAULT_THEME: OrgTheme = {
  version: 0,
  // Values from docs/Crewhall tasarımı/16-Tasarim-Sistemi; the kit is the source of truth.
  light: { bg: '#F7F7F6', surface: '#FFFFFF', accent: '#FBC419' },
  dark: { bg: '#0E0F0F', surface: '#151617', accent: '#FBC419' },
  radius: 'md',
  density: 'comfortable',
  login: { source: 'scene', imageUrl: null, darkImageUrl: null, texts: {} },
};

/** Oldest app version a server accepts, per platform (semver). */
export const MinClientVersion = z.object({
  ios: z.string(),
  android: z.string(),
  desktop: z.string(),
});
export type MinClientVersion = z.infer<typeof MinClientVersion>;

/** getCompat: what this server speaks and which apps it still accepts. */
export const ServerCompat = z.object({
  version: z.string(),
  /** CI's build number of this server's image; absent outside CI. */
  build: z.string().optional(),
  /** The commit this server's image was built from; absent outside CI. */
  commit: z.string().optional(),
  apiLevel: z.number().int().positive(),
  minClientVersion: MinClientVersion,
  /** Store or download page per platform, for the update prompt; null when not set. */
  storeUrls: z.object({
    ios: z.string().nullable(),
    android: z.string().nullable(),
    desktop: z.string().nullable(),
  }),
  /** Endpoints and fields on their way out. */
  deprecations: z.array(
    z.object({
      /** Endpoint name in the contract table. */
      endpoint: z.string(),
      method: z.string(),
      path: z.string(),
      /** Null: the whole endpoint goes. */
      field: z.string().nullable(),
      since: z.string(),
      removeAfter: z.string(),
      replacement: z.string().nullable(),
    }),
  ),
});
export type ServerCompat = z.infer<typeof ServerCompat>;

export const PublicBootstrap = z.object({
  branding: Branding,
  theme: OrgTheme,
  /** True until the setup wizard has created the first org and owner. */
  needsSetup: z.boolean(),
  auth: z.object({
    passkey: z.boolean(),
    signupOpen: z.boolean(),
    /** SMTP is configured: password reset and invitation e-mails can be sent (1.6). */
    emailEnabled: z.boolean().optional(),
    /** Local e-mail + password sign-in is offered (an org may allow SSO/LDAP only; the owner keeps a break-glass login). */
    password: z.boolean().optional(),
    /** Directory (Active Directory / LDAP) sign-in: username or e-mail + directory password. */
    ldap: z.object({ label: z.string() }).nullable().optional(),
    /** External identity providers (Keycloak, Entra ID, Google…) shown as "Sign in with" buttons. */
    sso: z
      .array(z.object({ id: z.string(), name: z.string(), kind: z.enum(['oidc', 'saml']) }))
      .optional(),
  }),
  /** Present only while needsSetup: what the wizard shows (1.10). */
  setup: z
    .object({
      tokenRequired: z.boolean(),
      checks: z.object({ database: z.boolean(), storage: z.boolean(), smtp: z.boolean() }),
    })
    .optional(),
  /**
   * Live demo (DEMO_MODE): sample accounts for the sign-in page and when the data resets.
   * Absent on real installs.
   */
  demo: z
    .object({
      resetAt: z.string(),
      accounts: z.array(
        z.object({
          email: z.email(),
          password: z.string(),
          name: z.string(),
          role: z.enum(['owner', 'admin', 'member', 'guest']),
        }),
      ),
    })
    .optional(),
  /** Server build info for the mobile "server" card, About screen and compatibility warning (15.16). */
  server: z
    .object({
      version: z.string(),
      /** Oldest mobile app version this server supports; older apps show an update warning. */
      minMobileVersion: z.string().nullable(),
      /** Contract level (compat.ts API_LEVEL); raised by one on every contract addition. */
      apiLevel: z.number().int().positive().optional(),
      /** Features this server offers the org (compat.ts CAPABILITIES, by enabled modules). */
      capabilities: z.array(z.string()).optional(),
      /** Oldest app version per platform; older apps get 426 client_outdated. */
      minClientVersion: MinClientVersion.optional(),
    })
    .optional(),
  /**
   * The calling app (X-Crewhall-Client) against minClientVersion; absent without the header.
   * 'outdated' apps are refused on every endpoint but bootstrap, auth and getCompat.
   */
  clientStatus: z.enum(['ok', 'outdated']).optional(),
  /** Desktop app releases this server hosts (DESKTOP_UPDATES_DIR); absent when it hosts none. */
  desktop: DesktopInfo.optional(),
});
export type PublicBootstrap = z.infer<typeof PublicBootstrap>;

/** Which brand image an upload replaces (design 9.x Marka): the URL fields of Branding. */
export const BrandAssetSlot = z.enum(['logoLight', 'logoDark', 'mark', 'favicon']);
export type BrandAssetSlot = z.infer<typeof BrandAssetSlot>;

/**
 * Stored right away (unlike the text fields' draft): logos fit in 1024×256, the mark is 512 px
 * square, the favicon 64 px. The file is served from `/api/assets/<id>` without a session,
 * so the login page and e-mails show it.
 */
export const UploadBrandAsset = ImageUpload.extend({ slot: BrandAssetSlot });
export type UploadBrandAsset = z.infer<typeof UploadBrandAsset>;

export const UpdateBranding = Branding.omit({
  logoLightUrl: true,
  logoDarkUrl: true,
  markUrl: true,
  faviconUrl: true,
}).partial();
export type UpdateBranding = z.infer<typeof UpdateBranding>;
