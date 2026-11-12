import { useQuery } from '@tanstack/react-query';
import { useModuleEnabled } from '@/lib/identity/modules';
import { usePermissions } from '@/lib/session';
import { aiStatusQuery } from './queries';

/**
 * Whether to show the AI buttons (module on, switched on and configured by the admin) and
 * whether they work now (`usable`: false while the monthly quota is used up). `setupHint`: AI is
 * switched on but has no working provider yet, and this person can fix that, so the places that
 * would show a button point them to the settings instead of hiding silently.
 */
export function useAiAvailability() {
  const on = useModuleEnabled('ai');
  const { canOrg } = usePermissions();
  const { data: status } = useQuery({ ...aiStatusQuery, enabled: on });
  const visible = on && !!status && (status.reason === null || status.reason === 'quota');
  const setupHint = on && status?.reason === 'not_configured' && canOrg('org.update_settings');
  return { visible, usable: visible && status?.reason === null, setupHint, status };
}
