import { useQuery } from '@tanstack/react-query';
import { ICON_PATHS, type IconName } from '@crewhall/ui';
import { pluginSurfacesQuery } from '@/lib/plugins/queries';
import { useMe } from '@/lib/session';

/** The org's active plugin surfaces (guests get none from the server). */
export function usePluginSurfaces() {
  const me = useMe();
  return useQuery({ ...pluginSurfacesQuery, enabled: Boolean(me) }).data ?? [];
}

/** A manifest icon name when Crewhall knows it, else a generic plug. */
export const pluginIcon = (name: string | undefined): IconName =>
  name && name in ICON_PATHS ? (name as IconName) : 'plug';

/** `/name args` against the plugins' commands: the call to make, or null. */
export function matchPluginCommand(
  text: string,
  surfaces: { installationId: string; commands: { name: string }[] }[],
): { installationId: string; command: string; args: string } | null {
  const m = /^\/([a-z][a-z0-9-]*)(?:\s+([\s\S]*))?$/.exec(text.trimStart());
  if (!m) return null;
  const owner = surfaces.find((s) => s.commands.some((c) => c.name === m[1]));
  return owner
    ? { installationId: owner.installationId, command: m[1]!, args: (m[2] ?? '').trim() }
    : null;
}
