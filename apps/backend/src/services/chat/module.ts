import type { DbOrTx } from '@crewhall/db';
import { invalidateModules, isModuleEnabled, isModuleEnabledCached } from '../identity/modules';

/**
 * Is the chat module on for the org (OrgSettings.modules, absent key = on)? The chat
 * endpoints are blocked centrally (MODULE_OF_ENDPOINT); this covers the paths outside the
 * endpoint table: WS chat events, incoming webhooks, chat push and digest. Thin wrappers
 * over the platform's isModuleEnabled (one cache, cleared when the org settings change).
 */
export function chatEnabled(db: DbOrTx, orgId: string): Promise<boolean> {
  return isModuleEnabled(db, orgId, 'chat');
}

/**
 * Synchronous answer for hot paths (every WS event): the cached value, refreshed in the
 * background when stale. Call `chatEnabled` once first (on connect) to prime it.
 */
export function chatEnabledCached(db: DbOrTx, orgId: string): boolean {
  return isModuleEnabledCached(db, orgId, 'chat');
}

/** Tests and settings changes: forget the cached value. */
export function forgetChatModule(orgId?: string) {
  invalidateModules(orgId);
}

/** WS events that belong to chat (dropped while the module is off). */
export const CHAT_EVENT_TYPES = new Set([
  'message.created',
  'message.updated',
  'message.deleted',
  'reaction',
  'read',
  'typing',
  'conversation.updated',
  'conversation.removed',
]);
