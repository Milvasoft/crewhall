import { Button, Icon, IconButton } from '@crewhall/ui';
import { useQuery } from '@tanstack/react-query';
import { useRouterState } from '@tanstack/react-router';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n/I18nContext';
import {
  appOpenUrl,
  bannerAllowedOn,
  launchApp,
  mobilePlatform,
  type MobilePlatform,
} from '@/lib/open-in-app';
import { isStandalone } from '@/lib/pwa';
import { compatQuery } from '@/lib/queries';
import { readStorage, StorageKey, writeStorage } from '@/lib/storage';

/** A closed banner stays closed this long in that browser. */
const DISMISS_MS = 30 * 86_400_000;

/** The store or download page of the app for this phone (getCompat, CLIENT_STORE_URL_*). */
export function useStoreUrl(platform: MobilePlatform | null): string | null {
  const compat = useQuery({ ...compatQuery, enabled: platform !== null });
  return platform ? (compat.data?.storeUrls[platform] ?? null) : null;
}

function dismissedRecently(): boolean {
  const at = Number(readStorage(StorageKey.openInAppDismissed));
  return Number.isFinite(at) && at > 0 && Date.now() - at < DISMISS_MS;
}

/**
 * Phone browsers: "Uygulamada aç" hands this page to the mobile app (`crewhall://open?url=`), or
 * goes to the store when no app answers. Closable; left out on pages the app opens in the browser.
 */
export function OpenInAppBanner() {
  // An installed web app is an app already: it would only be asked to leave itself.
  const [platform] = useState(() => (isStandalone() ? null : mobilePlatform()));
  const [dismissed, setDismissed] = useState(dismissedRecently);
  const location = useRouterState({ select: (s) => s.location });
  const store = useStoreUrl(platform);
  if (!platform || dismissed || !bannerAllowedOn(location.pathname)) return null;
  return (
    <Banner
      href={`${window.location.origin}${location.href}`}
      store={store}
      onClose={() => {
        writeStorage(StorageKey.openInAppDismissed, String(Date.now()));
        setDismissed(true);
      }}
    />
  );
}

function Banner({
  href,
  store,
  onClose,
}: {
  /** This page's full address: the app picks the server from it. */
  href: string;
  store: string | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  return (
    <div
      role="region"
      aria-label={t('openInApp.region')}
      className="fixed inset-x-3 top-[calc(env(safe-area-inset-top)+8px)] z-50 flex items-center gap-3 rounded-2xl bg-surface p-3 shadow-overlay"
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-accent text-accent-fg">
        <Icon name="phone" size={18} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-sm font-semibold">{t('openInApp.title')}</span>
        <span className="truncate text-xs text-fg2">{t('openInApp.body')}</span>
      </span>
      <Button size="sm" variant="pri" onClick={() => launchApp(appOpenUrl(href), store)}>
        {t('openInApp.open')}
      </Button>
      <IconButton size="sm" tone="plain" aria-label={t('openInApp.close')} onClick={onClose}>
        <Icon name="x" size={16} />
      </IconButton>
    </div>
  );
}
