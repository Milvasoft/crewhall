import { type AppLocale } from '@crewhall/i18n';
import { useEffect } from 'react';
import { useI18n } from '@/lib/i18n/I18nContext';
import { readStorage, StorageKey, writeStorage } from '@/lib/storage';
import { applyPublishedTheme } from '@/lib/theme/ThemeContext';
import { useBootstrap } from '@/lib/useBranding';

/** Applies the tenant's theme, tab title, favicon and default language from `bootstrap`. */
export function BrandingSync() {
  const { data } = useBootstrap();
  const { setLocale } = useI18n();

  useEffect(() => {
    if (!data) return;
    applyPublishedTheme(data.theme);
    writeStorage(StorageKey.branding, JSON.stringify(data.branding));
    const { orgName, appName, faviconUrl } = data.branding;
    document.title = orgName && orgName !== appName ? `${orgName} · ${appName}` : appName;
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (link && faviconUrl) link.href = faviconUrl;
    // Installed app: the org's mark and the theme's page color.
    const touch = document.querySelector<HTMLLinkElement>('link[rel="apple-touch-icon"]');
    if (touch && data.branding.markUrl) touch.href = data.branding.markUrl;
    for (const scheme of ['light', 'dark'] as const) {
      document
        .querySelector(`meta[name="theme-color"][media*="${scheme}"]`)
        ?.setAttribute('content', data.theme[scheme].bg);
    }
    // The org default applies only until the person picks a language themselves.
    if (!readStorage(StorageKey.locale)) {
      setLocale(data.branding.defaultLocale as AppLocale, { persist: false });
    }
  }, [data, setLocale]);

  return null;
}
