import { officeExtensionOf, type DriveNode, type OfficeExtension } from '@crewhall/shared';
import { queryOptions, useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useModuleEnabled } from '@/lib/identity/modules';

export const officeKeys = {
  capabilities: ['office', 'capabilities'] as const,
  settings: ['office', 'settings'] as const,
};

export const officeCapabilitiesQuery = queryOptions({
  queryKey: officeKeys.capabilities,
  queryFn: ({ signal }) => api.call('getOfficeCapabilities', { signal }),
  staleTime: 5 * 60_000,
});

/**
 * How Drive can open a file in the office editor: `edit`, `view`, or null (module off, no
 * working document server, or a type it does not handle).
 */
export function useOfficeMode() {
  const on = useModuleEnabled('office');
  const caps = useQuery({ ...officeCapabilitiesQuery, enabled: on });
  return (node: Pick<DriveNode, 'type' | 'name'>, canEdit: boolean): 'edit' | 'view' | null => {
    if (!on || !caps.data?.available || node.type !== 'file') return null;
    const ext = officeExtensionOf(node.name);
    if (!ext) return null;
    if (caps.data.edit.includes(ext)) return canEdit ? 'edit' : 'view';
    return caps.data.view.includes(ext) ? 'view' : null;
  };
}

/** Whether the server can make new files of this type (Drive › Yeni). */
export function useOfficeCanCreate() {
  const on = useModuleEnabled('office');
  const caps = useQuery({ ...officeCapabilitiesQuery, enabled: on });
  return (ext: OfficeExtension) =>
    Boolean(on && caps.data?.available && caps.data.edit.includes(ext));
}
