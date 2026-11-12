import { DEFAULT_THEME, type Branding, type PublicBootstrap } from '@crewhall/shared';
import { useQuery } from '@tanstack/react-query';
import { bootstrapQuery } from '@/lib/queries';
import { readStorage, StorageKey } from '@/lib/storage';

const FALLBACK: Branding = {
  orgName: 'Crewhall',
  appName: 'Crewhall',
  logoLightUrl: null,
  logoDarkUrl: null,
  markUrl: null,
  faviconUrl: null,
  showPoweredBy: true,
  defaultLocale: 'tr',
};

/** Last known branding (cache) so error pages and the first paint can still show the tenant. */
export function cachedBranding(): Branding {
  try {
    const raw = readStorage(StorageKey.branding);
    if (raw) return { ...FALLBACK, ...(JSON.parse(raw) as Partial<Branding>) };
  } catch {
    /* ignore */
  }
  return FALLBACK;
}

export function useBootstrap(): {
  data: PublicBootstrap | undefined;
  branding: Branding;
  theme: PublicBootstrap['theme'];
  isLoading: boolean;
} {
  const q = useQuery(bootstrapQuery);
  return {
    data: q.data,
    branding: q.data?.branding ?? cachedBranding(),
    theme: q.data?.theme ?? DEFAULT_THEME,
    isLoading: q.isLoading,
  };
}
