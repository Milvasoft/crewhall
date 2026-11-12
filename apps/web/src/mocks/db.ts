import { freshState, seedState, type MockState } from './seed';

/**
 * Mock database. In the browser it is persisted to localStorage so a reload keeps
 * the signed-in session and edits; in tests it lives in memory and is reset per test.
 */

const KEY = 'crewhall.mock.db';
let state: MockState | null = null;
let persist = typeof window !== 'undefined' && typeof localStorage !== 'undefined';

export type Scenario = 'seed' | 'setup';

export function resetDb(scenario: Scenario = 'seed'): MockState {
  state = scenario === 'setup' ? freshState() : seedState();
  save();
  return state;
}

export function db(): MockState {
  if (state) return state;
  if (persist) {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        state = JSON.parse(raw) as MockState;
        return state;
      }
    } catch {
      /* corrupt or blocked storage: start from seed */
    }
  }
  return resetDb('seed');
}

export function save(): void {
  if (!persist || !state) return;
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* best effort */
  }
}

/** Tests keep the db in memory. */
export function disablePersistence(): void {
  persist = false;
}

// Same ids as the app: the mock also runs in the browser over plain HTTP on the LAN.
export { newId } from '@/lib/ids';
