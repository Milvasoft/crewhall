import {
  MODULE_KEYS,
  moduleOn,
  type CardType,
  type Me,
  type ModuleKey,
  type NodeType,
  type OrgSettings,
} from '@crewhall/shared';
import { type IconName } from '@crewhall/ui';
import { useQuery } from '@tanstack/react-query';
import { useCallback } from 'react';
import { type ModuleId } from '@/lib/modules';
import { meQuery } from '@/lib/queries';

/**
 * Module switches (Yönetim › Genel › Modüller). `Me.modules` lists the enabled modules of the
 * active org; when it is absent (older server) every module counts as on. Drive and quick
 * access are the core and cannot be turned off.
 */

/** Rail entry → switchable module; null = core (always on). */
export const RAIL_MODULE_KEY: Record<ModuleId, ModuleKey | null> = {
  chat: 'chat',
  drive: null,
  pages: 'wiki',
  boards: 'boards',
  drawings: 'drawings',
  meet: 'meet',
  calendar: 'calendar',
  contacts: 'contacts',
  vault: 'vault',
  tables: 'tables',
  forms: 'forms',
  automations: 'automations',
  mail: 'mail',
  tools: 'tools',
};

/** Icon per module for the switches list and the disabled screen. */
export const MODULE_ICON: Record<ModuleKey, IconName> = {
  chat: 'chat',
  meet: 'video',
  wiki: 'page',
  boards: 'board',
  drawings: 'vector',
  vault: 'vault',
  portal: 'portal',
  mcp: 'plug',
  forms: 'todo',
  tables: 'table',
  calendar: 'calendar',
  contacts: 'users',
  automations: 'zap',
  ai: 'sparkle',
  mail: 'mail',
  tools: 'tool',
  office: 'file',
};

/** First path segments (or prefixes) that belong to a switchable module. */
const PATH_PREFIXES: [string, ModuleKey][] = [
  ['/chat', 'chat'],
  ['/pages', 'wiki'],
  ['/p', 'wiki'],
  ['/boards', 'boards'],
  ['/drawings', 'drawings'],
  ['/d', 'drawings'],
  ['/b', 'boards'],
  ['/meetings', 'meet'],
  ['/vault', 'vault'],
  ['/forms', 'forms'],
  ['/tables', 'tables'],
  ['/calendar', 'calendar'],
  ['/contacts', 'contacts'],
  ['/automations', 'automations'],
  ['/portal', 'portal'],
  ['/account/mcp', 'mcp'],
  ['/account/approvals', 'mcp'],
  ['/admin/mcp', 'mcp'],
  ['/admin/ai', 'ai'],
  ['/mail', 'mail'],
  ['/admin/mail', 'mail'],
  ['/admin/calendar', 'calendar'],
  ['/bookings', 'calendar'],
  ['/admin/bookings', 'calendar'],
  ['/tools', 'tools'],
  ['/office', 'office'],
];

/** Modules whose own pages render their "turned off" state (chat); the generic gate leaves them alone. */
export const SELF_GATED_MODULES: ReadonlySet<ModuleKey> = new Set(['chat']);

/** The module a signed-in route belongs to, or null for core pages. */
export function moduleForPath(pathname: string): ModuleKey | null {
  const path = pathname.replace(/\/+$/, '') || '/';
  for (const [prefix, key] of PATH_PREFIXES) {
    if (path === prefix || path.startsWith(`${prefix}/`)) return key;
  }
  return null;
}

/** Enabled modules for a `Me`; absent list = all on. */
export function enabledModules(me: Pick<Me, 'modules'> | undefined): ReadonlySet<ModuleKey> {
  return new Set(me?.modules ?? MODULE_KEYS);
}

export function isModuleEnabled(
  me: Pick<Me, 'modules'> | undefined,
  key: ModuleKey | null,
): boolean {
  if (key === null) return true;
  return me?.modules === undefined || me.modules.includes(key);
}

/** True while the module is on (and while `me` is still loading). */
export function useModuleEnabled(key: ModuleKey | null): boolean {
  const { data: me } = useQuery(meQuery);
  return isModuleEnabled(me, key);
}

/** Drive node types owned by a switchable module: pages are wiki, boards and drawings each their own. */
export const NODE_TYPE_MODULE: Record<NodeType, ModuleKey | null> = {
  folder: null,
  file: null,
  page: 'wiki',
  board: 'boards',
  drawing: 'drawings',
};

/** False when the node type's module is off: Drive lists, search and Ctrl K leave it out. */
export function isNodeTypeEnabled(me: Pick<Me, 'modules'> | undefined, type: NodeType): boolean {
  return isModuleEnabled(me, NODE_TYPE_MODULE[type]);
}

/** `isNodeTypeEnabled` for the signed-in person, as a stable filter predicate. */
export function useNodeTypeEnabled(): (type: NodeType) => boolean {
  const { data: me } = useQuery(meQuery);
  return useCallback((type: NodeType) => isNodeTypeEnabled(me, type), [me]);
}

/** Quick access card types that read a switchable module; they hide while it is off. */
export const CARD_TYPE_MODULE: Record<CardType, ModuleKey | null> = {
  link: null,
  link_group: null,
  note: null,
  todo: null,
  node: null,
  board_assigned: 'boards',
  page: 'wiki',
  chat: 'chat',
  meeting: 'meet',
  vault_item: 'vault',
};

export function isCardTypeEnabled(me: Pick<Me, 'modules'> | undefined, type: CardType): boolean {
  return isModuleEnabled(me, CARD_TYPE_MODULE[type]);
}

/** `isCardTypeEnabled` for the signed-in person, as a stable filter predicate. */
export function useCardTypeEnabled(): (type: CardType) => boolean {
  const { data: me } = useQuery(meQuery);
  return useCallback((type: CardType) => isCardTypeEnabled(me, type), [me]);
}

/** Org settings switch value; a missing key means on (a split module follows its parent). */
export function moduleSwitch(settings: Pick<OrgSettings, 'modules'>, key: ModuleKey): boolean {
  return moduleOn(settings, key);
}

/** Number of switches that differ between two settings (for the save bar). */
export function countModuleChanges(
  base: Pick<OrgSettings, 'modules'>,
  draft: Pick<OrgSettings, 'modules'>,
): number {
  return MODULE_KEYS.filter((k) => moduleSwitch(base, k) !== moduleSwitch(draft, k)).length;
}

/** Settings with one switch changed; keeps the full map so the server stores every key. */
export function withModule(settings: OrgSettings, key: ModuleKey, on: boolean): OrgSettings {
  const modules = Object.fromEntries(
    MODULE_KEYS.map((k) => [k, moduleSwitch(settings, k)]),
  ) as Record<ModuleKey, boolean>;
  modules[key] = on;
  return { ...settings, modules };
}
