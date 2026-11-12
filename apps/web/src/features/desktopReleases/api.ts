import { type DesktopPlatformReleases, type DesktopReleases } from '@crewhall/shared';
import { type QueryClient, queryOptions } from '@tanstack/react-query';
import { api } from '@/lib/api';

/** Yönetim › Masaüstü sürümleri (packages/shared endpoints/desktop.ts). */
export const desktopReleasesKey = ['admin', 'desktop-releases'] as const;

export const desktopReleasesQuery = queryOptions({
  queryKey: desktopReleasesKey,
  queryFn: ({ signal }) => api.call('listDesktopReleases', { signal }),
  retry: false,
});

/** Publish and delete answer with the platform's new state; it replaces that platform in the list. */
export function setPlatformReleases(qc: QueryClient, next: DesktopPlatformReleases): void {
  qc.setQueryData<DesktopReleases>(desktopReleasesKey, (old) =>
    old
      ? {
          ...old,
          platforms: old.platforms.some((p) => p.platform === next.platform)
            ? old.platforms.map((p) => (p.platform === next.platform ? next : p))
            : [...old.platforms, next],
        }
      : old,
  );
}
