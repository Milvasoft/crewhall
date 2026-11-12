import { queryOptions } from '@tanstack/react-query';
import { api } from '@/lib/api';

/** Plugins (docs/contracts/eklentiler.md): what people see, and the admin screens. */
export const pluginKeys = {
  all: ['plugins'] as const,
  surfaces: ['plugins', 'surfaces'] as const,
  installations: ['plugins', 'installations'] as const,
  catalog: (q: string) => ['plugins', 'catalog', q] as const,
  notificationPrefs: ['plugins', 'notification-prefs'] as const,
};

/** Plugins that may notify me and how (Bildirim ayarları › Eklentiler). */
export const pluginNotificationPrefsQuery = queryOptions({
  queryKey: pluginKeys.notificationPrefs,
  queryFn: async ({ signal }) => (await api.call('listPluginNotificationPrefs', { signal })).items,
});

/** Tabs, cards and commands of the org's active plugins (empty for guests). */
export const pluginSurfacesQuery = queryOptions({
  queryKey: pluginKeys.surfaces,
  queryFn: async ({ signal }) => (await api.call('listPluginSurfaces', { signal })).items,
  staleTime: 5 * 60_000,
});

export const pluginInstallationsQuery = queryOptions({
  queryKey: pluginKeys.installations,
  queryFn: async ({ signal }) => (await api.call('listPluginInstallations', { signal })).items,
});

export const pluginCatalogQuery = (q: string) =>
  queryOptions({
    queryKey: pluginKeys.catalog(q),
    queryFn: async ({ signal }) =>
      (await api.call('listPluginCatalog', { query: q ? { q } : {}, signal })).items,
    staleTime: 60_000,
  });
