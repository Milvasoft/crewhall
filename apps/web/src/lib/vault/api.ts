import {
  createAccountKeys,
  encryptItem,
  acceptSettings,
  encryptSettings,
  nextSettingsRevision,
  openSettings,
  newId,
  newKdfParams,
  newRecovery,
  newVaultKey,
  openPrivateKey,
  passwordUnlockMaterial,
  recoveryUnlockMaterial,
  toB64,
  wrapForPassword,
  wrapVaultKey,
  type ItemPayload,
} from '@crewhall/crypto';
import {
  type Vault,
  type VaultEventsQuery,
  type VaultItem,
  type VaultUnlockBundle,
} from '@crewhall/shared';
import { queryOptions, type QueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import { api, idempotencyKey } from '@/lib/api';
import { setupVaultCrypto } from './crypto';
import { parseSettings, readSettings, type VaultSettings } from './settings';
import { raiseSettingsFloor, settingsFloor } from './settingsFloor';
import {
  requireUnlocked,
  setUnlocked,
  updateSettings,
  vaultKeyFor,
  type UnlockMethod,
} from './session';

/** Server state for the vault (ciphertext and metadata only) and the key flows around it. */

export const vaultKeys = {
  all: ['vault'] as const,
  status: ['vault', 'keys'] as const,
  list: ['vault', 'vaults'] as const,
  items: (vaultId: string) => ['vault', 'items', vaultId] as const,
  members: (vaultId: string) => ['vault', 'members', vaultId] as const,
  candidates: (vaultId: string, q: string) => ['vault', 'candidates', vaultId, q] as const,
  revisions: (itemId: string) => ['vault', 'revisions', itemId] as const,
  events: (q: object) => ['vault', 'events', q] as const,
  policy: ['vault', 'policy'] as const,
  shares: (itemId: string) => ['vault', 'shares', itemId] as const,
};

/** Org vault policy (roadmap 20): leak check and share link switches and limits. */
export const policyQuery = queryOptions({
  queryKey: vaultKeys.policy,
  queryFn: () => api.call('vaultPolicy'),
  staleTime: 5 * 60_000,
});

/** Live share links of one item (mine, or all of it when I manage the vault). */
export const sharesQuery = (itemId: string) =>
  queryOptions({
    queryKey: vaultKeys.shares(itemId),
    queryFn: async () => (await api.call('vaultShares', { query: { itemId } })).items,
  });

export const keyStatusQuery = queryOptions({
  queryKey: vaultKeys.status,
  queryFn: () => api.call('vaultKeys'),
});

export const vaultsQuery = queryOptions({
  queryKey: vaultKeys.list,
  queryFn: async () => (await api.call('vaultList')).items,
});

/** Every item of a vault, all pages (the client decrypts and searches locally). */
export const itemsQuery = (vaultId: string) =>
  queryOptions({
    queryKey: vaultKeys.items(vaultId),
    queryFn: async () => {
      const out: VaultItem[] = [];
      let cursor: string | undefined;
      do {
        const page = await api.call('vaultItems', {
          params: { vaultId },
          query: { limit: 500, ...(cursor ? { cursor } : {}) },
        });
        out.push(...page.items);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      return out;
    },
  });

export const membersQuery = (vaultId: string) =>
  queryOptions({
    queryKey: vaultKeys.members(vaultId),
    queryFn: async () => (await api.call('vaultMembers', { params: { vaultId } })).items,
  });

export const revisionsQuery = (itemId: string) =>
  queryOptions({
    queryKey: vaultKeys.revisions(itemId),
    queryFn: async () => (await api.call('vaultItemRevisions', { params: { itemId } })).items,
  });

export const eventsQuery = (q: Partial<z.input<typeof VaultEventsQuery>>) =>
  queryOptions({
    queryKey: vaultKeys.events(q),
    queryFn: () => api.call('vaultEvents', { query: q }),
  });

/* ------------------------------- setup and unlock ------------------------------- */

export interface PreparedSetup {
  userId: string;
  setup: Awaited<ReturnType<typeof createAccountKeys>>;
  verifier: Uint8Array;
}

/**
 * Setup step 1 → 2 (design 8.1-8.2): keys and the recovery key are made on this device only.
 * Nothing is uploaded until the person confirms the recovery key is saved (doc 17 §7).
 */
export async function prepareVaultSetup(userId: string, password: string): Promise<PreparedSetup> {
  setupVaultCrypto();
  const setup = await createAccountKeys({ userId, password });
  const m = await passwordUnlockMaterial(password, setup.upload.kdf);
  return { userId, setup, verifier: m.verifier };
}

/** Step 2 → 3: upload the wrapped keys with a new personal vault, then open the vault. */
export async function commitVaultSetup(p: PreparedSetup) {
  const personalId = newId();
  const wrappedKey = wrapVaultKey(newVaultKey(), p.setup.publicKey, {
    vaultId: personalId,
    keyVersion: 1,
    userId: p.userId,
  });
  await api.call('vaultSetupKeys', {
    body: { ...p.setup.upload, personalVault: { id: personalId, wrappedKey } },
    idempotencyKey: idempotencyKey(),
  });
  setUnlocked({
    userId: p.userId,
    privateKey: p.setup.privateKey,
    publicKey: p.setup.upload.publicKey,
    method: 'password',
    verifier: p.verifier,
    settings: parseSettings({}),
    settingsState: 'ok',
  });
}

function finishUnlock(
  userId: string,
  method: UnlockMethod,
  bundle: VaultUnlockBundle,
  kek: Uint8Array,
  verifier: Uint8Array | null,
) {
  const privateKey = openPrivateKey({
    kek,
    wrapped: bundle.wrappedPrivateKey,
    userId,
    method,
    publicKey: bundle.publicKey,
  });
  const opened = openSettings(
    privateKey,
    userId,
    bundle.settings,
    settingsFloor(userId, bundle.publicKey),
  );
  const { settings, readable } = readSettings(opened.value);
  const settingsState = readable ? opened.state : 'unreadable';
  setUnlocked({
    userId,
    privateKey,
    publicKey: bundle.publicKey,
    method,
    verifier,
    settings,
    settingsState,
  });
  if (settingsState !== 'ok') return;
  raiseSettingsFloor(userId, bundle.publicKey, opened.revision);
  // From before revisions: stamped once, so that an older copy can be told from here on.
  if (bundle.settings && opened.revision === 0) void saveSettings(settings).catch(() => undefined);
}

export async function unlockWithPassword(userId: string, password: string) {
  setupVaultCrypto();
  const status = await api.call('vaultKeys');
  if (!status.kdf) throw new Error('vault not set up');
  const m = await passwordUnlockMaterial(password, status.kdf);
  const bundle = await api.call('vaultUnlock', {
    body: { method: 'password', verifier: toB64(m.verifier) },
  });
  finishUnlock(userId, 'password', bundle, m.kek, m.verifier);
}

/** Step 1 of "Kasa şifreni mi unuttun?": the recovery key opens the private key. */
export async function unlockWithRecovery(userId: string, recoveryKey: string) {
  const m = recoveryUnlockMaterial(recoveryKey);
  const bundle = await api.call('vaultUnlock', {
    body: { method: 'recovery', verifier: toB64(m.verifier) },
  });
  finishUnlock(userId, 'recovery', bundle, m.kek, null);
  return m.verifier;
}

export async function unlockWithSecret(
  userId: string,
  method: 'passkey_prf' | 'device',
  unlockId: string,
  material: { kek: Uint8Array; verifier: Uint8Array },
) {
  const bundle = await api.call('vaultUnlock', {
    body: { method, unlockId, verifier: toB64(material.verifier) },
  });
  finishUnlock(userId, method, bundle, material.kek, null);
}

/** New vault password; proof is the current password or, after recovery, the recovery key. */
export async function changeVaultPassword(
  proof: { method: 'password' | 'recovery'; verifier: Uint8Array },
  newPassword: string,
) {
  setupVaultCrypto();
  const u = requireUnlocked();
  const wrap = await wrapForPassword(u.privateKey, u.userId, newPassword, newKdfParams());
  await api.call('vaultChangePassword', {
    body: { proof: { method: proof.method, verifier: toB64(proof.verifier) }, ...wrap },
  });
  const m = await passwordUnlockMaterial(newPassword, wrap.kdf);
  setUnlocked({ ...u, method: 'password', verifier: m.verifier });
}

export async function regenerateRecoveryKey(passwordVerifier: Uint8Array) {
  const u = requireUnlocked();
  const fresh = newRecovery(u.privateKey, u.userId);
  await api.call('vaultRotateRecovery', {
    body: {
      proof: { method: 'password', verifier: toB64(passwordVerifier) },
      recoveryWrappedKey: fresh.recoveryWrappedKey,
      recoveryVerifier: fresh.recoveryVerifier,
    },
  });
  return fresh.recoveryKey;
}

/** Derives the password verifier again when the session has none (passkey unlock). */
export async function passwordProof(password: string) {
  setupVaultCrypto();
  const status = await api.call('vaultKeys');
  if (!status.kdf) throw new Error('vault not set up');
  return (await passwordUnlockMaterial(password, status.kdf)).verifier;
}

async function uploadSettings(settings: VaultSettings) {
  const u = requireUnlocked();
  await api.call('vaultUpdateSettings', {
    body: { settings: encryptSettings(u.privateKey, u.userId, settings) },
  });
}

/** What the server holds now, judged against what this device has seen. */
async function readStoredSettings() {
  const u = requireUnlocked();
  const { settings: blob } = await api.call('vaultGetSettings');
  const opened = openSettings(u.privateKey, u.userId, blob, settingsFloor(u.userId, u.publicKey));
  const { settings, readable } = readSettings(opened.value);
  return {
    settings,
    revision: opened.revision,
    state: readable ? opened.state : ('unreadable' as const),
  };
}

/** Another device may have saved since this unlock: pins are only judged on what is stored now. */
export async function refreshSettings() {
  const u = requireUnlocked();
  const stored = await readStoredSettings();
  if (stored.state !== 'ok') {
    updateSettings(u.settings, stored.state);
    return;
  }
  raiseSettingsFloor(u.userId, u.publicKey, stored.revision);
  const newer = stored.revision > u.settings.revision || u.settingsState !== 'ok';
  updateSettings(newer ? stored.settings : u.settings, 'ok');
}

/**
 * One change on top of what is stored, so that a session left open does not undo another device's
 * save, and the revision goes past the stored one even with a clock behind it.
 */
export async function changeSettings(
  change: (latest: VaultSettings) => VaultSettings,
  options: { onlyIfTrusted?: boolean } = {},
) {
  const u = requireUnlocked();
  if (!options.onlyIfTrusted) updateSettings(change(u.settings));
  const stored = await readStoredSettings();
  if (stored.state !== 'ok') {
    updateSettings(requireUnlocked().settings, stored.state);
    // What would not open may hold another device's pins: choices stay in this session.
    if (options.onlyIfTrusted || stored.state === 'unreadable') return;
    // An old copy keeps its revision: saving a preference must not silence the warning.
    await uploadSettings(requireUnlocked().settings);
    return;
  }
  const base = stored.revision > u.settings.revision ? stored.settings : u.settings;
  const floor = Math.max(settingsFloor(u.userId, u.publicKey), base.revision, stored.revision);
  const next = { ...change(base), revision: nextSettingsRevision(floor) };
  updateSettings(next, 'ok');
  await uploadSettings(next);
  raiseSettingsFloor(u.userId, u.publicKey, next.revision);
}

/** Only what differs from `before` goes on top of `latest`; pins are handled by pinKeys. */
function rebased(settings: VaultSettings, before: VaultSettings, latest: VaultSettings) {
  if (latest === before) return settings;
  const changed = Object.entries(settings).filter(
    ([k, v]) => JSON.stringify(v) !== JSON.stringify(before[k as keyof VaultSettings]),
  );
  return { ...latest, ...Object.fromEntries(changed) };
}

export async function saveSettings(settings: VaultSettings) {
  const before = requireUnlocked().settings;
  await changeSettings((latest) => rebased(settings, before, latest));
}

/**
 * The person read the warning and goes on with the settings as they are now: see acceptSettings.
 */
export async function acceptSettingsAsTheyAre() {
  const u = requireUnlocked();
  const next = acceptSettings(u.settings, settingsFloor(u.userId, u.publicKey));
  await uploadSettings(next);
  raiseSettingsFloor(u.userId, u.publicKey, next.revision);
  updateSettings(next, 'ok');
}

/* ---------------------------------- vaults ---------------------------------- */

export async function createSpaceVault(spaceId: string, name: string) {
  const u = requireUnlocked();
  const id = newId();
  const wrappedKey = wrapVaultKey(newVaultKey(), u.publicKey, {
    vaultId: id,
    keyVersion: 1,
    userId: u.userId,
  });
  return api.call('vaultCreate', {
    body: { id, spaceId, name, wrappedKey },
    idempotencyKey: idempotencyKey(),
  });
}

/** Personal vault in an org where my keys exist but the vault does not (multi-org people). */
export async function createPersonalVault() {
  const u = requireUnlocked();
  const id = newId();
  const wrappedKey = wrapVaultKey(newVaultKey(), u.publicKey, {
    vaultId: id,
    keyVersion: 1,
    userId: u.userId,
  });
  return api.call('vaultCreate', { body: { id, spaceId: null, wrappedKey } });
}

/* ---------------------------------- items ---------------------------------- */

export function encryptFor(vault: Vault, itemId: string, revision: number, payload: ItemPayload) {
  return {
    type: payload.type,
    keyVersion: vault.keyVersion,
    ...encryptItem(
      vaultKeyFor(vault),
      { vaultId: vault.id, itemId, revision, keyVersion: vault.keyVersion, type: payload.type },
      payload,
    ),
  };
}

export async function createItem(vault: Vault, payload: ItemPayload) {
  const id = newId();
  return api.call('vaultCreateItem', {
    params: { vaultId: vault.id },
    body: { id, ...encryptFor(vault, id, 1, payload) },
    idempotencyKey: idempotencyKey(),
  });
}

/** Saves revision current + 1; a 409 means someone saved meanwhile (design 8.8). */
export async function saveItem(vault: Vault, item: VaultItem, payload: ItemPayload) {
  const revision = item.revision + 1;
  return api.call('vaultUpdateItem', {
    params: { itemId: item.id },
    body: { revision, ...encryptFor(vault, item.id, revision, payload) },
  });
}

export async function moveItem(from: VaultItem, target: Vault, payload: ItemPayload) {
  const id = newId();
  return api.call('vaultMoveItem', {
    params: { itemId: from.id },
    body: { targetVaultId: target.id, item: { id, ...encryptFor(target, id, 1, payload) } },
  });
}

export function invalidateVault(qc: QueryClient, vaultId?: string) {
  void qc.invalidateQueries({ queryKey: vaultKeys.list });
  if (vaultId) void qc.invalidateQueries({ queryKey: vaultKeys.items(vaultId) });
}

/* ---------------------------------- access log ---------------------------------- */

const queue: { vaultId: string; itemId: string; action: 'reveal' | 'copy'; field: string }[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/** "Gösterildi / kopyalandı" (design 8.11): which field, never its value; sent in batches. */
export function reportAccess(e: (typeof queue)[number]) {
  queue.push(e);
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    const events = queue.splice(0, 50);
    if (events.length) {
      void api.call('vaultReportEvents', { body: { events } }).catch(() => undefined);
    }
  }, 800);
}
