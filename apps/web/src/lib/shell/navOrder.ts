import { queryOptions } from '@tanstack/react-query';
import { api } from '@/lib/api';

/**
 * The person's left menu (Hesabım › Görünüm › Sol menü), kept on the server so the web and the
 * desktop app share it; the phone app has its own (navOrder). Entries are module ids or plugin
 * tab ids; the ones not in the list keep their default place after the ordered ones, so a module
 * switched on later still shows up.
 */
export const uiPrefsKey = ['me', 'ui-prefs'] as const;

export const uiPrefsQuery = queryOptions({
  queryKey: uiPrefsKey,
  queryFn: ({ signal }) => api.call('getUiPrefs', { signal }),
  staleTime: 5 * 60_000,
});

/** Sorts entries by `order` (ids); unknown ids are ignored, unlisted entries follow in place. */
export function applyNavOrder<T extends { id: string }>(
  entries: T[],
  order: readonly string[],
): T[] {
  if (!order.length) return entries;
  const rank = new Map(order.map((id, i) => [id, i]));
  const listed = entries.filter((e) => rank.has(e.id));
  listed.sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
  return [...listed, ...entries.filter((e) => !rank.has(e.id))];
}

/** How many of the entries fit, and which go under "Diğer" on a short screen. */
export const RAIL_ITEM_PX = 48;
/** Org mark, separator and avatar with their gaps. */
export const RAIL_RESERVED_PX = 140;

export interface RailFit<T> {
  modules: T[];
  extra: T[];
  /** Behind the "Diğer" entry. */
  more: T[];
}

/**
 * Fits the entries into the rail's height. Portal and admin keep their place at the bottom while
 * they can, modules go first; the entry you are on never hides. A height of 0 (not measured yet)
 * shows everything.
 */
export function fitRail<T extends { active: boolean }>(
  modules: T[],
  extra: T[],
  height: number,
): RailFit<T> {
  const slots = Math.floor((height - RAIL_RESERVED_PX) / RAIL_ITEM_PX);
  if (height <= 0 || modules.length + extra.length <= slots) return { modules, extra, more: [] };
  // One slot goes to "Diğer" itself; home always stays.
  const room = Math.max(1, slots - 1);
  const keptModules = Math.max(1, room - extra.length);
  const keptExtra = Math.max(0, room - keptModules);
  const shown = modules.slice(0, keptModules);
  const shownExtra = extra.slice(0, keptExtra);
  const more = [...modules.slice(keptModules), ...extra.slice(keptExtra)];
  const hiddenActive = more.findIndex((e) => e.active);
  if (hiddenActive >= 0) {
    // The last module steps aside for the one you are on, unless home is the only one left.
    const active = more.splice(hiddenActive, 1)[0]!;
    if (shown.length > 1) more.unshift(shown.pop()!);
    shown.push(active);
  }
  return { modules: shown, extra: shownExtra, more };
}

/** Moves one id a step up or down in the full visible order. */
export function moveId(ids: readonly string[], id: string, by: -1 | 1): string[] {
  const i = ids.indexOf(id);
  const j = i + by;
  if (i < 0 || j < 0 || j >= ids.length) return [...ids];
  const next = [...ids];
  [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
}
