import { type PortalSite, type PortalSiteSummary } from '@crewhall/shared';
import { createContext, useContext, useSyncExternalStore } from 'react';

/** The open portal site (route /portal/$siteSlug) and the site list for the picker. */
export interface PortalSiteValue {
  site: PortalSite;
  sites: PortalSiteSummary[];
}

export const PortalSiteContext = createContext<PortalSiteValue | null>(null);

export function usePortalSite(): PortalSiteValue {
  const ctx = useContext(PortalSiteContext);
  if (!ctx) throw new Error('usePortalSite must be used inside a portal site route');
  return ctx;
}

// ---- last used site (raydaki Portal opens it) ----

const LAST_SITE_KEY = 'crewhall.portal.lastSite';

export function readLastSite(): string | null {
  try {
    return localStorage.getItem(LAST_SITE_KEY);
  } catch {
    return null;
  }
}

export function writeLastSite(slug: string): void {
  try {
    localStorage.setItem(LAST_SITE_KEY, slug);
  } catch {
    /* best effort */
  }
}

// ---- publish dialog (opened from the top bar on every portal screen and from Ctrl K) ----

let publishOpen = false;
const listeners = new Set<() => void>();

export function setPublishOpen(v: boolean): void {
  publishOpen = v;
  listeners.forEach((l) => l());
}

export function usePublishOpen(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => publishOpen,
    () => false,
  );
}
