import type { DbOrTx } from '@crewhall/db';
import { isModuleEnabled } from '../identity/modules';

/**
 * The org can switch the portal module off (OrgSettings.modules.portal === false). Hub
 * endpoints are guarded centrally by the platform; the site's content API, media and the
 * revalidate jobs check here. Read fresh each time, as before (the site API and the worker's
 * jobs are not on a hot path). An unknown org counts as off.
 */
export function portalEnabled(db: DbOrTx, orgId: string): Promise<boolean> {
  return isModuleEnabled(db, orgId, 'portal', { fresh: true });
}
