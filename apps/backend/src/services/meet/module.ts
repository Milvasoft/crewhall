import type { DbOrTx } from '@crewhall/db';
import { isModuleEnabled } from '../identity/modules';

/**
 * The org may switch meetings off (OrgSettings.modules.meet === false). Endpoints answer
 * 403 module_disabled centrally (platform); this covers the paths outside the endpoint
 * table: LiveKit webhooks, the guest link and the recording jobs.
 */
export function meetEnabled(db: DbOrTx, orgId: string): Promise<boolean> {
  return isModuleEnabled(db, orgId, 'meet');
}
