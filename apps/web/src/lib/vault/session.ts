import {
  decryptItem,
  RevisionGuard,
  unwrapVaultKey,
  wipe,
  type ItemPayload,
  type ItemSummary,
  type ItemType,
  type SettingsState,
} from '@crewhall/crypto';
import { type Vault, type VaultItem } from '@crewhall/shared';
import { useSyncExternalStore } from 'react';
import { cacheKeyOf } from './engine';
import { engine } from './engine-client';
import { DEFAULT_SETTINGS, type VaultSettings } from './settings';

/**
 * The unlocked vault lives here and nowhere else: module memory only, never React Query,
 * localStorage or sessionStorage (doc 17 §7 "Çözülmüş veri yalnız bellekte"). Locking wipes
 * the private key, the vault keys and every decrypted item.
 */

/** 'system': Windows locked or the computer went to sleep (desktop app). */
export type LockReason = 'manual' | 'idle' | 'hidden' | 'system';
export type UnlockMethod = 'password' | 'recovery' | 'passkey_prf' | 'device';

interface Unlocked {
  userId: string;
  privateKey: Uint8Array;
  publicKey: string;
  method: UnlockMethod;
  /** Password verifier from this unlock, as proof for key changes ("sudo"); null otherwise. */
  verifier: Uint8Array | null;
  settings: VaultSettings;
  /** Anything but `ok`: the settings may be old or not mine to save over; pins prove nothing. */
  settingsState: SettingsState;
  unlockedAt: number;
}

interface State {
  unlocked: Unlocked | null;
  lockedAt: number | null;
  lockReason: LockReason | null;
  lastActivity: number;
}

let state: State = { unlocked: null, lockedAt: null, lockReason: null, lastActivity: Date.now() };
const listeners = new Set<() => void>();
const vaultKeys = new Map<string, { keyVersion: number; key: Uint8Array }>();
const items = new Map<string, ItemPayload>();
const guard = new RevisionGuard();
/** List summaries per id:revision:keyVersion (no secrets, see ItemSummary). */
const summaries = new Map<string, ItemSummary | null>();
/** Summaries being decrypted; a second caller (list and health badge) waits instead. */
const inflight = new Map<string, Promise<void>>();
let generation = 0;
/** Full payload decryptions in the page (performance test). */
const pageStats = { full: 0 };

function emit(next: Partial<State>) {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

export function getSession(): State {
  return state;
}

export function useVaultSession(): State {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
    () => state,
  );
}

export function setUnlocked(u: Omit<Unlocked, 'unlockedAt'>) {
  wipeAll();
  emit({
    unlocked: { ...u, unlockedAt: Date.now() },
    lockedAt: null,
    lockReason: null,
    lastActivity: Date.now(),
  });
}

function wipeAll() {
  for (const v of vaultKeys.values()) wipe(v.key);
  vaultKeys.clear();
  items.clear();
  summaries.clear();
  inflight.clear();
  guard.clear();
  generation++;
  engine().lock();
}

export function lock(reason: LockReason) {
  if (!state.unlocked) return;
  wipe(state.unlocked.privateKey, state.unlocked.verifier);
  wipeAll();
  emit({ unlocked: null, lockedAt: Date.now(), lockReason: reason });
}

/** Activity resets the idle timer (design 8.4 "Açık · 4 dk sonra kilitlenir"). */
export function touch() {
  if (state.unlocked) state = { ...state, lastActivity: Date.now() };
}

export function updateSettings(settings: VaultSettings, settingsState?: SettingsState) {
  if (state.unlocked) {
    emit({
      unlocked: {
        ...state.unlocked,
        settings,
        settingsState: settingsState ?? state.unlocked.settingsState,
      },
    });
  }
}

export function requireUnlocked(): Unlocked {
  if (!state.unlocked) throw new Error('vault locked');
  return state.unlocked;
}

export function currentSettings(): VaultSettings {
  return state.unlocked?.settings ?? DEFAULT_SETTINGS;
}

/** My TOFU pins, or null when they say nothing: locked, or the settings can't be relied on. */
export function currentPins(): Record<string, string> | null {
  return state.unlocked?.settingsState === 'ok' ? state.unlocked.settings.pins : null;
}

/** The vault key for my current key version, unwrapped once per unlock. */
export function vaultKeyFor(v: Pick<Vault, 'id' | 'keyVersion' | 'myWrappedKey'>): Uint8Array {
  const u = requireUnlocked();
  const cached = vaultKeys.get(v.id);
  if (cached && cached.keyVersion === v.keyVersion) return cached.key;
  if (cached) wipe(cached.key);
  const key = unwrapVaultKey(u.privateKey, v.myWrappedKey, {
    vaultId: v.id,
    keyVersion: v.keyVersion,
    userId: u.userId,
  });
  vaultKeys.set(v.id, { keyVersion: v.keyVersion, key });
  return key;
}

export type DecryptResult =
  { ok: true; payload: ItemPayload } | { ok: false; reason: 'tampered' | 'rollback' };

/**
 * Decrypts an item (cached per revision). Refuses a revision lower than one already seen in
 * this session (rollback guard, doc 17 §7) and anything that fails authentication.
 */
export function decryptVaultItem(vault: Vault, item: VaultItem): DecryptResult {
  const cacheKey = `${item.id}:${item.revision}:${item.keyVersion}`;
  if (!guard.check(item.id, item.revision)) return { ok: false, reason: 'rollback' };
  const hit = items.get(cacheKey);
  if (hit) return { ok: true, payload: hit };
  try {
    const payload = decryptItem(
      vaultKeyFor(vault),
      {
        vaultId: item.vaultId,
        itemId: item.id,
        revision: item.revision,
        keyVersion: item.keyVersion,
        type: item.type as ItemType,
      },
      item,
    );
    items.set(cacheKey, payload);
    pageStats.full++;
    return { ok: true, payload };
  } catch {
    return { ok: false, reason: 'tampered' };
  }
}

export interface Summarized {
  item: VaultItem;
  summary: ItemSummary | null;
  error: 'tampered' | 'rollback' | null;
}

/**
 * List view of a vault (H13): only summaries, decrypted in the worker once per revision and
 * cached here; repeated renders cost nothing. Rollbacks are refused as for full decryption.
 */
export async function summarizeVaultItems(vault: Vault, rows: VaultItem[]): Promise<Summarized[]> {
  const gen = generation;
  const key = vaultKeyFor(vault);
  const client = engine();
  client.setKey(vault.id, vault.keyVersion, key);
  const missing = rows.filter((r) => {
    const k = cacheKeyOf(r);
    return r.keyVersion === vault.keyVersion && !summaries.has(k) && !inflight.has(k);
  });
  if (missing.length) {
    const request = client
      .summarize(
        missing.map((r) => ({
          id: r.id,
          vaultId: r.vaultId,
          type: r.type,
          revision: r.revision,
          keyVersion: r.keyVersion,
          ciphertext: r.ciphertext,
          nonce: r.nonce,
          itemKeyWrapped: r.itemKeyWrapped,
          updatedAt: r.updatedAt,
        })),
      )
      .then((results) => {
        if (gen !== generation) return;
        for (const res of results) summaries.set(res.cacheKey, res.summary);
      })
      .finally(() => {
        for (const r of missing) {
          if (inflight.get(cacheKeyOf(r)) === request) inflight.delete(cacheKeyOf(r));
        }
      });
    for (const r of missing) inflight.set(cacheKeyOf(r), request);
  }
  await Promise.all(
    new Set(rows.map((r) => inflight.get(cacheKeyOf(r))).filter((p) => p !== undefined)),
  );
  if (gen !== generation) return [];
  return rows.map((item) => {
    if (!guard.check(item.id, item.revision)) {
      return { item, summary: null, error: 'rollback' as const };
    }
    const summary = summaries.get(cacheKeyOf(item)) ?? null;
    return { item, summary, error: summary ? null : ('tampered' as const) };
  });
}

/** Counters for the performance test: worker decryptions and full payloads in the page. */
export function vaultStats() {
  return { ...engine().stats(), full: pageStats.full };
}
