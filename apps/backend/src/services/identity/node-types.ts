import { and, isNull, notInArray, type SQL } from 'drizzle-orm';
import { nodes, type DbOrTx } from '@crewhall/db';
import type { ModuleKey, NodeType } from '@crewhall/shared';
import { AppError } from '../../http/errors';
import { isModuleEnabled } from './modules';

/** Drive node types owned by a switchable module; folders and files are core. */
export const MODULE_OF_NODE_TYPE: Readonly<Partial<Record<NodeType, ModuleKey>>> = {
  page: 'wiki',
  board: 'boards',
  drawing: 'drawings',
};

/** Node types of the org's switched-off modules: Drive lists, search and MCP leave them out. */
export async function hiddenNodeTypes(db: DbOrTx, orgId: string): Promise<NodeType[]> {
  const hidden: NodeType[] = [];
  const checked = new Map<ModuleKey, boolean>();
  for (const [type, key] of Object.entries(MODULE_OF_NODE_TYPE) as [NodeType, ModuleKey][]) {
    if (!checked.has(key)) checked.set(key, await isModuleEnabled(db, orgId, key));
    if (!checked.get(key)) hidden.push(type);
  }
  return hidden;
}

/**
 * WHERE condition for the nodes a person sees in Drive lists, search, child counts, recent,
 * favorites and trash: not of a switched-off module, and not one of the app's own folders
 * (`system_role`: page images, card and table attachments...).
 */
export function visibleNodeTypes(hidden: NodeType[]): SQL {
  const notSystem = isNull(nodes.systemRole);
  return hidden.length ? and(notInArray(nodes.type, hidden), notSystem)! : notSystem;
}

/** A single node of a switched-off module answers 403 module_disabled. */
export async function requireNodeModule(db: DbOrTx, orgId: string, type: NodeType) {
  const key = MODULE_OF_NODE_TYPE[type];
  if (key && !(await isModuleEnabled(db, orgId, key))) {
    throw new AppError('module_disabled', { module: key });
  }
}
