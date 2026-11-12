import { type IconName } from '@crewhall/ui';

/** Global modules on the rail (kit README "Web kabuğu"). Phase 0 ships the shell only. */
export const MODULES = [
  { id: 'chat', icon: 'chat', path: '/chat' },
  { id: 'drive', icon: 'folder', path: '/drive' },
  { id: 'pages', icon: 'page', path: '/pages' },
  { id: 'boards', icon: 'board', path: '/boards' },
  { id: 'drawings', icon: 'vector', path: '/drawings' },
  { id: 'meet', icon: 'video', path: '/meetings' },
  { id: 'calendar', icon: 'calendar', path: '/calendar' },
  { id: 'contacts', icon: 'users', path: '/contacts' },
  { id: 'vault', icon: 'vault', path: '/vault' },
  { id: 'tables', icon: 'table', path: '/tables' },
  { id: 'forms', icon: 'todo', path: '/forms' },
  { id: 'automations', icon: 'zap', path: '/automations' },
  { id: 'mail', icon: 'mail', path: '/mail' },
  { id: 'tools', icon: 'tool', path: '/tools' },
] as const satisfies readonly { id: string; icon: IconName; path: string }[];

export type ModuleId = (typeof MODULES)[number]['id'];

export const MODULE_BY_SEGMENT: Record<string, ModuleId> = Object.fromEntries(
  MODULES.map((m) => [m.path.slice(1), m.id]),
);
