import type { DbOrTx } from '@crewhall/db';
import { invalidateModules, isModuleEnabled } from '../identity/modules';

/**
 * Are the boards / drawings modules on for the org (OrgSettings.modules; drawings follow
 * boards until their own switch is set)? Endpoints are blocked centrally
 * (MODULE_OF_ENDPOINT); these cover the paths outside the endpoint table: collab documents,
 * thumbnail and notification jobs. Thin wrappers over the platform's isModuleEnabled.
 */
export function boardsEnabled(db: DbOrTx, orgId: string): Promise<boolean> {
  return isModuleEnabled(db, orgId, 'boards');
}

export function drawingsEnabled(db: DbOrTx, orgId: string): Promise<boolean> {
  return isModuleEnabled(db, orgId, 'drawings');
}

/** Tests flip the switch and need the next read to see it. */
export function forgetBoardsSwitch(orgId?: string) {
  invalidateModules(orgId);
}
