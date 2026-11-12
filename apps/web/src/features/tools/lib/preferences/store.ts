// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/lib/preferences/store.ts. See THIRD_PARTY.md.
/**
 * Centralized, local-only preference store. Every component reads/writes
 * preferences through here instead of touching localStorage directly, so the
 * backing store can later be swapped or synced without rewriting tools.
 *
 * IMPORTANT: this store is for *preferences* only, favorites, recents, theme,
 * editor settings. Never persist tool input/output or secrets here.
 */

export type ThemePreference = 'light' | 'dark' | 'system';

/**
 * Fake Data generator configuration (the schema + output choices, never the
 * generated rows). Field type/format are stored as plain strings to avoid
 * coupling this store to the tool's union types.
 */
export interface FakeDataPrefs {
  fields: { name: string; type: string }[];
  count: number;
  format: string;
  tableName: string;
  /** SQL: emit a single multi-row INSERT instead of one statement per row. */
  sqlBulk?: boolean;
}

export interface Preferences {
  theme: ThemePreference;
  favorites: string[]; // tool ids
  recents: string[]; // tool ids, most-recent-first
  editorFontSize: number;
  cronDialect: 'unix' | 'quartz';
  density: 'comfortable' | 'compact';
  /** Whether the left navigation sidebar is collapsed (slid out). */
  sidebarCollapsed: boolean;
  /** Category ids whose group is collapsed in the sidebar. */
  collapsedCategories: string[];
  /** Remembered Fake Data generator setup (null until first used). */
  fakeData: FakeDataPrefs | null;
}

export const DEFAULT_PREFERENCES: Preferences = {
  theme: 'system',
  favorites: [],
  recents: [],
  editorFontSize: 13,
  cronDialect: 'unix',
  density: 'comfortable',
  sidebarCollapsed: false,
  collapsedCategories: [],
  fakeData: null,
};

// Crewhall: its own key, per browser (favorites and recents are a convenience, not data).
const STORAGE_KEY = 'crewhall.tools.preferences.v1';
const MAX_RECENTS = 12;

type Listener = () => void;

function isBrowser(): boolean {
  return typeof window !== 'undefined';
}

function read(): Preferences {
  if (!isBrowser()) return DEFAULT_PREFERENCES;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PREFERENCES;
    const parsed = JSON.parse(raw) as Partial<Preferences>;
    return { ...DEFAULT_PREFERENCES, ...parsed };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

function write(next: Preferences): void {
  if (!isBrowser()) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage may be unavailable (private mode); preferences degrade gracefully.
  }
}

let cache: Preferences | null = null;
const listeners = new Set<Listener>();

function current(): Preferences {
  if (cache === null) cache = read();
  return cache;
}

function emit(): void {
  for (const l of listeners) l();
}

export const preferences = {
  getAll(): Preferences {
    return current();
  },

  get<K extends keyof Preferences>(key: K): Preferences[K] {
    return current()[key];
  },

  set<K extends keyof Preferences>(key: K, value: Preferences[K]): void {
    const next = { ...current(), [key]: value };
    cache = next;
    write(next);
    emit();
  },

  update(patch: Partial<Preferences>): void {
    const next = { ...current(), ...patch };
    cache = next;
    write(next);
    emit();
  },

  toggleFavorite(id: string): void {
    const favorites = current().favorites;
    const next = favorites.includes(id) ? favorites.filter((f) => f !== id) : [...favorites, id];
    this.set('favorites', next);
  },

  recordRecent(id: string): void {
    const recents = current().recents.filter((r) => r !== id);
    recents.unshift(id);
    this.set('recents', recents.slice(0, MAX_RECENTS));
  },

  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
