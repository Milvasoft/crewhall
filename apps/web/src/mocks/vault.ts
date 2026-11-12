import {
  canCreateSpaceVault,
  canVault,
  type SpaceRole,
  type Vault,
  type VaultAction,
  type VaultEvent,
  type VaultEventAction,
  type VaultItem,
  type VaultKdf,
  type VaultKeyStatus,
  type VaultMember,
  type VaultPolicy,
  type VaultRole,
  type VaultShare,
  type VaultUnlockMethod,
} from '@crewhall/shared';
import { http, HttpResponse } from 'msw';
import { MockApiError, myRole, requireUser, summary, type Resolvers } from './core';
import { newId } from './db';
import { type MockState, type MockUser } from './seed';

/**
 * Vault part of the contract mock: a tiny zero-knowledge server. It stores the ciphertext and
 * wrapped keys the client sends, checks verifier hashes and revisions, and never decrypts.
 * State rides on the mock db (persisted like the rest in dev mock mode: ciphertext only).
 */

interface MockKeys {
  publicKey: string;
  fingerprint: string;
  kdf: VaultKdf;
  encryptedPrivateKey: string;
  passwordVerifierHash: string;
  recoveryWrappedKey: string;
  recoveryVerifierHash: string;
  settings: string | null;
  failedAttempts: number;
  lockedUntil: string | null;
  recoveryCreatedAt: string;
  passwordChangedAt: string;
  unlocks: (VaultUnlockMethod & { wrappedPrivateKey: string; verifierHash: string })[];
}

interface MockVault {
  id: string;
  kind: 'personal' | 'space';
  spaceId: string | null;
  ownerUserId: string | null;
  name: string | null;
  keyVersion: number;
  revision: number;
  createdBy: string;
  createdAt: string;
}

interface MockVaultMember {
  vaultId: string;
  userId: string;
  role: VaultRole;
  wrappedKey: string;
  keyVersion: number;
  grantedBy: string;
  grantedAt: string;
}

interface MockItem {
  id: string;
  vaultId: string;
  type: VaultItem['type'];
  revision: number;
  keyVersion: number;
  ciphertext: string;
  nonce: string;
  itemKeyWrapped: string;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  deletedBy: string | null;
  attachments: { id: string; size: number; createdAt: string }[];
  revisions: {
    revision: number;
    type: VaultItem['type'];
    keyVersion: number;
    ciphertext: string;
    nonce: string;
    itemKeyWrapped: string;
    createdBy: string;
    createdAt: string;
  }[];
}

interface MockShare {
  id: string;
  tokenHash: string;
  vaultId: string;
  itemId: string;
  ciphertext: string;
  nonce: string;
  maxViews: number;
  views: number;
  expiresAt: string;
  createdBy: string;
  createdAt: string;
}

interface VaultState {
  /** Roadmap 20: org vault policy (null = defaults) and one-time share links. */
  policy?: Omit<VaultPolicy, 'canEdit'>;
  shares?: MockShare[];
  keys: Record<string, MockKeys>;
  vaults: MockVault[];
  members: MockVaultMember[];
  items: MockItem[];
  events: (Omit<VaultEvent, 'actor' | 'targetUser'> & {
    actorId: string;
    targetUserId: string | null;
  })[];
  seq: number;
}

type WithVault = MockState & { vault?: VaultState };

export function vaultState(s: MockState): VaultState {
  const w = s as WithVault;
  w.vault ??= { keys: {}, vaults: [], members: [], items: [], events: [], seq: 0 };
  return w.vault;
}

const now = () => new Date().toISOString();

async function sha256(b64: string): Promise<string> {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return btoa(String.fromCharCode(...digest));
}

function user(s: MockState): MockUser {
  const u = requireUser(s);
  const m = s.members.find((x) => x.userId === u.id);
  if (m?.role === 'guest') throw new MockApiError('forbidden');
  return u;
}

function log(
  s: MockState,
  actorId: string,
  action: VaultEventAction,
  e: Partial<{
    vaultId: string;
    itemId: string;
    field: string;
    targetUserId: string;
    meta: Record<string, unknown>;
  }> = {},
) {
  const v = vaultState(s);
  v.events.push({
    id: String(++v.seq),
    at: now(),
    actorId,
    action,
    vaultId: e.vaultId ?? null,
    itemId: e.itemId ?? null,
    field: e.field ?? null,
    targetUserId: e.targetUserId ?? null,
    meta: e.meta ?? {},
    ip: '127.0.0.1',
    userAgent: navigator.userAgent,
  });
}

function publicMethod(m: MockKeys['unlocks'][number]): VaultUnlockMethod {
  return {
    id: m.id,
    method: m.method,
    label: m.label,
    credentialId: m.credentialId,
    prfSalt: m.prfSalt,
    createdAt: m.createdAt,
    lastUsedAt: m.lastUsedAt,
  };
}

function keysOf(s: MockState, userId: string) {
  const k = vaultState(s).keys[userId];
  if (!k) throw new MockApiError('vault_setup_required');
  return k;
}

function status(s: MockState, userId: string): VaultKeyStatus {
  const k = vaultState(s).keys[userId];
  if (!k) {
    return {
      setUp: false,
      publicKey: null,
      fingerprint: null,
      kdf: null,
      keyVersion: 0,
      unlockMethods: [],
      recoveryCreatedAt: null,
      passwordChangedAt: null,
      failedAttempts: 0,
      lockedUntil: null,
    };
  }
  const locked = k.lockedUntil && Date.parse(k.lockedUntil) > Date.now() ? k.lockedUntil : null;
  return {
    setUp: true,
    publicKey: k.publicKey,
    fingerprint: k.fingerprint,
    kdf: k.kdf,
    keyVersion: 1,
    unlockMethods: k.unlocks.map(publicMethod),
    recoveryCreatedAt: k.recoveryCreatedAt,
    passwordChangedAt: k.passwordChangedAt,
    failedAttempts: k.failedAttempts,
    lockedUntil: locked,
  };
}

async function checkVerifier(
  s: MockState,
  u: MockUser,
  verifier: string,
  hash: string,
  method: string,
) {
  const k = keysOf(s, u.id);
  if (k.lockedUntil && Date.parse(k.lockedUntil) > Date.now()) {
    throw new MockApiError('vault_unlock_locked', undefined, { retryAfter: 30 });
  }
  if ((await sha256(verifier)) === hash) {
    k.failedAttempts = 0;
    k.lockedUntil = null;
    return;
  }
  k.failedAttempts++;
  log(s, u.id, 'unlock_failed', { field: method, meta: { attempts: k.failedAttempts } });
  if (k.failedAttempts >= 5) {
    k.failedAttempts = 0;
    k.lockedUntil = new Date(Date.now() + 30_000).toISOString();
    throw new MockApiError('vault_unlock_locked', undefined, { retryAfter: 30 });
  }
  throw new MockApiError('vault_unlock_failed', undefined, { remaining: 5 - k.failedAttempts });
}

interface Access {
  vault: MockVault;
  member: MockVaultMember;
  spaceRole: SpaceRole | null;
}

function access(s: MockState, userId: string, vaultId: string): Access {
  const v = vaultState(s);
  const vault = v.vaults.find((x) => x.id === vaultId);
  const member = v.members.find((m) => m.vaultId === vaultId && m.userId === userId);
  if (!vault || !member) throw new MockApiError('not_found');
  return { vault, member, spaceRole: vault.spaceId ? myRole(s, vault.spaceId, userId) : null };
}

const allowed = (a: Access, action: VaultAction) =>
  canVault({ kind: a.vault.kind, vaultRole: a.member.role, spaceRole: a.spaceRole }, action);

function need(a: Access, action: VaultAction) {
  if (!allowed(a, action)) throw new MockApiError('forbidden');
}

function userSummary(s: MockState, id: string | null) {
  const u = id ? s.users.find((x) => x.id === id) : undefined;
  return u ? summary(u) : null;
}

function toVault(s: MockState, a: Access): Vault {
  const v = vaultState(s);
  const sp = a.vault.spaceId ? s.spaces.find((x) => x.id === a.vault.spaceId) : undefined;
  const items = v.items.filter((i) => i.vaultId === a.vault.id);
  const members = v.members.filter((m) => m.vaultId === a.vault.id);
  return {
    id: a.vault.id,
    kind: a.vault.kind,
    name: a.vault.name,
    space: sp ? { id: sp.id, name: sp.name, slug: sp.slug, color: sp.color } : null,
    keyVersion: a.vault.keyVersion,
    revision: a.vault.revision,
    myRole: a.member.role,
    myWrappedKey: a.member.wrappedKey,
    canEdit: allowed(a, 'vault.edit'),
    canManage: allowed(a, 'vault.manage_members'),
    itemCount: items.filter((i) => !i.deletedAt).length,
    trashCount: items.filter((i) => i.deletedAt).length,
    memberCount: members.length,
    staleMemberCount:
      a.vault.kind === 'space'
        ? members.filter((m) => myRole(s, a.vault.spaceId!, m.userId) === null).length
        : 0,
    createdBy: userSummary(s, a.vault.createdBy),
    createdAt: a.vault.createdAt,
  };
}

function toItem(s: MockState, i: MockItem): VaultItem {
  const { createdBy, updatedBy, deletedBy } = i;
  return {
    id: i.id,
    vaultId: i.vaultId,
    type: i.type,
    revision: i.revision,
    keyVersion: i.keyVersion,
    ciphertext: i.ciphertext,
    nonce: i.nonce,
    itemKeyWrapped: i.itemKeyWrapped,
    attachments: i.attachments,
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
    deletedAt: i.deletedAt,
    createdBy: userSummary(s, createdBy),
    updatedBy: userSummary(s, updatedBy),
    deletedBy: userSummary(s, deletedBy),
  };
}

function toMember(s: MockState, a: Access, m: MockVaultMember): VaultMember {
  const k = vaultState(s).keys[m.userId];
  return {
    user: summary(s.users.find((u) => u.id === m.userId)!),
    role: m.role,
    spaceRole: a.vault.kind === 'personal' ? 'owner' : myRole(s, a.vault.spaceId!, m.userId),
    publicKey: k?.publicKey ?? '',
    fingerprint: k?.fingerprint ?? '',
    grantedBy: userSummary(s, m.grantedBy),
    grantedAt: m.grantedAt,
  };
}

function itemOf(s: MockState, userId: string, itemId: string) {
  const item = vaultState(s).items.find((i) => i.id === itemId);
  if (!item) throw new MockApiError('not_found');
  return { item, a: access(s, userId, item.vaultId) };
}

function bump(a: Access) {
  a.vault.revision++;
}

function keyVersion(a: Access, kv: number) {
  if (kv !== a.vault.keyVersion) {
    throw new MockApiError('vault_key_version_mismatch', undefined, {
      keyVersion: a.vault.keyVersion,
    });
  }
}

function newItem(
  u: MockUser,
  vaultId: string,
  b: {
    id: string;
    type: VaultItem['type'];
    keyVersion: number;
    ciphertext: string;
    nonce: string;
    itemKeyWrapped: string;
  },
  dates: { createdAt?: string; updatedAt?: string } = {},
): MockItem {
  return {
    ...b,
    vaultId,
    revision: 1,
    createdBy: u.id,
    updatedBy: u.id,
    createdAt: dates.createdAt ?? now(),
    updatedAt: dates.updatedAt ?? now(),
    deletedAt: null,
    deletedBy: null,
    attachments: [],
    revisions: [],
  };
}

export const vaultResolvers: Resolvers<
  | 'vaultKeys'
  | 'vaultSetupKeys'
  | 'vaultUnlock'
  | 'vaultChangePassword'
  | 'vaultRotateRecovery'
  | 'vaultAddUnlockMethod'
  | 'vaultRemoveUnlockMethod'
  | 'vaultGetSettings'
  | 'vaultUpdateSettings'
  | 'vaultPublicKey'
  | 'vaultList'
  | 'vaultCreate'
  | 'vaultGet'
  | 'vaultUpdate'
  | 'vaultDelete'
  | 'vaultMembers'
  | 'vaultCandidates'
  | 'vaultGrant'
  | 'vaultUpdateMember'
  | 'vaultRotationData'
  | 'vaultRotate'
  | 'vaultItems'
  | 'vaultCreateItem'
  | 'vaultEmptyTrash'
  | 'vaultGetItem'
  | 'vaultUpdateItem'
  | 'vaultTrashItem'
  | 'vaultRestoreItem'
  | 'vaultPurgeItem'
  | 'vaultMoveItem'
  | 'vaultItemRevisions'
  | 'vaultDeleteItemRevision'
  | 'vaultImport'
  | 'vaultCreateAttachment'
  | 'vaultCompleteAttachment'
  | 'vaultAttachmentUrl'
  | 'vaultDeleteAttachment'
  | 'vaultReportEvents'
  | 'vaultEvents'
  | 'vaultPolicy'
  | 'vaultUpdatePolicy'
  | 'vaultBreachRange'
  | 'vaultCreateShare'
  | 'vaultShares'
  | 'vaultRevokeShare'
  | 'vaultPublicShare'
  | 'vaultOpenShare'
> = {
  vaultKeys: ({ s }) => status(s, user(s).id),
  vaultSetupKeys: async ({ s, body }) => {
    const u = user(s);
    const v = vaultState(s);
    if (v.keys[u.id]) throw new MockApiError('vault_already_set_up');
    v.keys[u.id] = {
      publicKey: body.publicKey,
      fingerprint: body.fingerprint,
      kdf: body.kdf,
      encryptedPrivateKey: body.encryptedPrivateKey,
      passwordVerifierHash: await sha256(body.passwordVerifier),
      recoveryWrappedKey: body.recoveryWrappedKey,
      recoveryVerifierHash: await sha256(body.recoveryVerifier),
      settings: null,
      failedAttempts: 0,
      lockedUntil: null,
      recoveryCreatedAt: now(),
      passwordChangedAt: now(),
      unlocks: [],
    };
    if (!v.vaults.some((x) => x.kind === 'personal' && x.ownerUserId === u.id)) {
      v.vaults.push({
        id: body.personalVault.id,
        kind: 'personal',
        spaceId: null,
        ownerUserId: u.id,
        name: null,
        keyVersion: 1,
        revision: 1,
        createdBy: u.id,
        createdAt: now(),
      });
      v.members.push({
        vaultId: body.personalVault.id,
        userId: u.id,
        role: 'manage',
        wrappedKey: body.personalVault.wrappedKey,
        keyVersion: 1,
        grantedBy: u.id,
        grantedAt: now(),
      });
    }
    log(s, u.id, 'keys.setup');
    return status(s, u.id);
  },
  vaultUnlock: async ({ s, body }) => {
    const u = user(s);
    const k = keysOf(s, u.id);
    let wrapped: string;
    if (body.method === 'password') {
      await checkVerifier(s, u, body.verifier, k.passwordVerifierHash, 'password');
      wrapped = k.encryptedPrivateKey;
    } else if (body.method === 'recovery') {
      await checkVerifier(s, u, body.verifier, k.recoveryVerifierHash, 'recovery');
      wrapped = k.recoveryWrappedKey;
    } else {
      const m = k.unlocks.find((x) => x.id === body.unlockId && x.method === body.method);
      if (!m) throw new MockApiError('not_found');
      await checkVerifier(s, u, body.verifier, m.verifierHash, body.method);
      m.lastUsedAt = now();
      wrapped = m.wrappedPrivateKey;
    }
    log(s, u.id, 'unlock', { field: body.method });
    return {
      method: body.method,
      publicKey: k.publicKey,
      wrappedPrivateKey: wrapped,
      keyVersion: 1,
      settings: k.settings,
    };
  },
  vaultChangePassword: async ({ s, body }) => {
    const u = user(s);
    const k = keysOf(s, u.id);
    await checkVerifier(
      s,
      u,
      body.proof.verifier,
      body.proof.method === 'password' ? k.passwordVerifierHash : k.recoveryVerifierHash,
      body.proof.method,
    );
    Object.assign(k, {
      kdf: body.kdf,
      encryptedPrivateKey: body.encryptedPrivateKey,
      passwordVerifierHash: await sha256(body.passwordVerifier),
      passwordChangedAt: now(),
    });
    log(s, u.id, 'keys.password');
    return status(s, u.id);
  },
  vaultRotateRecovery: async ({ s, body }) => {
    const u = user(s);
    const k = keysOf(s, u.id);
    await checkVerifier(
      s,
      u,
      body.proof.verifier,
      body.proof.method === 'password' ? k.passwordVerifierHash : k.recoveryVerifierHash,
      body.proof.method,
    );
    Object.assign(k, {
      recoveryWrappedKey: body.recoveryWrappedKey,
      recoveryVerifierHash: await sha256(body.recoveryVerifier),
      recoveryCreatedAt: now(),
    });
    log(s, u.id, 'keys.recovery');
    return status(s, u.id);
  },
  vaultAddUnlockMethod: async ({ s, body }) => {
    const u = user(s);
    const k = keysOf(s, u.id);
    await checkVerifier(s, u, body.proof.verifier, k.passwordVerifierHash, 'password');
    const m = {
      id: newId(),
      method: body.method,
      label: body.label,
      credentialId: body.credentialId ?? null,
      prfSalt: body.prfSalt ?? null,
      createdAt: now(),
      lastUsedAt: null,
      wrappedPrivateKey: body.wrappedPrivateKey,
      verifierHash: await sha256(body.verifier),
    };
    k.unlocks.push(m);
    return publicMethod(m);
  },
  vaultRemoveUnlockMethod: ({ s, params }) => {
    const k = keysOf(s, user(s).id);
    const before = k.unlocks.length;
    k.unlocks = k.unlocks.filter((m) => m.id !== params.unlockId);
    if (k.unlocks.length === before) throw new MockApiError('not_found');
    return {};
  },
  vaultGetSettings: ({ s }) => ({ settings: keysOf(s, user(s).id).settings }),
  vaultUpdateSettings: ({ s, body }) => {
    keysOf(s, user(s).id).settings = body.settings;
    return {};
  },
  vaultPublicKey: ({ s, params }) => {
    user(s);
    const k = vaultState(s).keys[params.userId!];
    if (!k) throw new MockApiError('vault_member_without_keys');
    return {
      userId: params.userId!,
      publicKey: k.publicKey,
      fingerprint: k.fingerprint,
      keyVersion: 1,
    };
  },

  vaultList: ({ s }) => {
    const u = user(s);
    const v = vaultState(s);
    const mine = v.members.filter((m) => m.userId === u.id).map((m) => access(s, u.id, m.vaultId));
    mine.sort((a, b) =>
      a.vault.kind === b.vault.kind
        ? (a.vault.name ?? '').localeCompare(b.vault.name ?? '', 'tr')
        : a.vault.kind === 'personal'
          ? -1
          : 1,
    );
    return { items: mine.map((a) => toVault(s, a)) };
  },
  vaultCreate: ({ s, body }) => {
    const u = user(s);
    keysOf(s, u.id);
    const v = vaultState(s);
    if (v.vaults.some((x) => x.id === body.id)) throw new MockApiError('conflict');
    if (body.spaceId === null) {
      if (v.vaults.some((x) => x.kind === 'personal' && x.ownerUserId === u.id)) {
        throw new MockApiError('conflict');
      }
      v.vaults.push({
        id: body.id,
        kind: 'personal',
        spaceId: null,
        ownerUserId: u.id,
        name: null,
        keyVersion: 1,
        revision: 1,
        createdBy: u.id,
        createdAt: now(),
      });
    } else {
      const sp = s.spaces.find((x) => x.id === body.spaceId && x.kind === 'shared');
      if (!sp) throw new MockApiError('not_found');
      if (!canCreateSpaceVault(myRole(s, sp.id, u.id))) throw new MockApiError('forbidden');
      if (!body.name) throw new MockApiError('validation_failed');
      v.vaults.push({
        id: body.id,
        kind: 'space',
        spaceId: sp.id,
        ownerUserId: null,
        name: body.name,
        keyVersion: 1,
        revision: 1,
        createdBy: u.id,
        createdAt: now(),
      });
    }
    v.members.push({
      vaultId: body.id,
      userId: u.id,
      role: 'manage',
      wrappedKey: body.wrappedKey,
      keyVersion: 1,
      grantedBy: u.id,
      grantedAt: now(),
    });
    log(s, u.id, 'vault.create', { vaultId: body.id });
    return toVault(s, access(s, u.id, body.id));
  },
  vaultGet: ({ s, params }) => toVault(s, access(s, user(s).id, params.vaultId!)),
  vaultUpdate: ({ s, params, body }) => {
    const u = user(s);
    const a = access(s, u.id, params.vaultId!);
    need(a, 'vault.rename');
    a.vault.name = body.name;
    bump(a);
    return toVault(s, a);
  },
  vaultDelete: ({ s, params }) => {
    const u = user(s);
    const a = access(s, u.id, params.vaultId!);
    need(a, 'vault.delete');
    const v = vaultState(s);
    v.vaults = v.vaults.filter((x) => x.id !== a.vault.id);
    v.members = v.members.filter((x) => x.vaultId !== a.vault.id);
    v.items = v.items.filter((x) => x.vaultId !== a.vault.id);
    log(s, u.id, 'vault.delete', { vaultId: a.vault.id });
    return {};
  },
  vaultMembers: ({ s, params }) => {
    const a = access(s, user(s).id, params.vaultId!);
    const order: Record<VaultRole, number> = { manage: 0, edit: 1, read: 2 };
    return {
      items: vaultState(s)
        .members.filter((m) => m.vaultId === a.vault.id)
        .sort((x, y) => order[x.role] - order[y.role])
        .map((m) => toMember(s, a, m)),
    };
  },
  vaultCandidates: ({ s, params, query }) => {
    const u = user(s);
    const a = access(s, u.id, params.vaultId!);
    if (a.vault.kind !== 'space') throw new MockApiError('vault_personal_not_shareable');
    need(a, 'vault.manage_members');
    const v = vaultState(s);
    const taken = new Set(v.members.filter((m) => m.vaultId === a.vault.id).map((m) => m.userId));
    const q = query.q?.toLocaleLowerCase('tr-TR') ?? '';
    return {
      items: s.members
        .filter((m) => m.status === 'active' && m.role !== 'guest' && !taken.has(m.userId))
        .map((m) => s.users.find((x) => x.id === m.userId)!)
        .filter((x) => !q || `${x.name} ${x.email}`.toLocaleLowerCase('tr-TR').includes(q))
        .map((x) => ({
          user: summary(x),
          spaceRole: myRole(s, a.vault.spaceId!, x.id),
          publicKey: v.keys[x.id]?.publicKey ?? null,
          fingerprint: v.keys[x.id]?.fingerprint ?? null,
        })),
    };
  },
  vaultGrant: ({ s, params, body }) => {
    const u = user(s);
    const a = access(s, u.id, params.vaultId!);
    if (a.vault.kind !== 'space') throw new MockApiError('vault_personal_not_shareable');
    need(a, 'vault.manage_members');
    keyVersion(a, body.keyVersion);
    const v = vaultState(s);
    if (!v.keys[body.userId]) throw new MockApiError('vault_member_without_keys');
    if (v.members.some((m) => m.vaultId === a.vault.id && m.userId === body.userId)) {
      throw new MockApiError('conflict');
    }
    if (myRole(s, a.vault.spaceId!, body.userId) === null) {
      s.spaceMembers.push({
        spaceId: a.vault.spaceId!,
        userId: body.userId,
        role: 'viewer',
        addedAt: now(),
      } as MockState['spaceMembers'][number]);
    }
    const m: MockVaultMember = {
      vaultId: a.vault.id,
      userId: body.userId,
      role: body.role,
      wrappedKey: body.wrappedKey,
      keyVersion: body.keyVersion,
      grantedBy: u.id,
      grantedAt: now(),
    };
    v.members.push(m);
    bump(a);
    log(s, u.id, 'member.grant', {
      vaultId: a.vault.id,
      targetUserId: body.userId,
      field: body.role,
    });
    return toMember(s, a, m);
  },
  vaultUpdateMember: ({ s, params, body }) => {
    const u = user(s);
    const a = access(s, u.id, params.vaultId!);
    if (a.vault.kind !== 'space') throw new MockApiError('vault_personal_not_shareable');
    need(a, 'vault.manage_members');
    const v = vaultState(s);
    const m = v.members.find((x) => x.vaultId === a.vault.id && x.userId === params.userId);
    if (!m) throw new MockApiError('member_not_found');
    const managers = v.members.filter(
      (x) => x.vaultId === a.vault.id && (x === m ? body.role : x.role) === 'manage',
    );
    if (!managers.length) throw new MockApiError('vault_last_manager');
    m.role = body.role;
    bump(a);
    log(s, u.id, 'member.role', { vaultId: a.vault.id, targetUserId: m.userId, field: body.role });
    return toMember(s, a, m);
  },
  vaultRotationData: ({ s, params }) => {
    const u = user(s);
    const a = access(s, u.id, params.vaultId!);
    need(a, a.vault.kind === 'personal' ? 'vault.purge' : 'vault.manage_members');
    const v = vaultState(s);
    const items = v.items.filter((i) => i.vaultId === a.vault.id);
    return {
      vault: toVault(s, a),
      members: v.members.filter((m) => m.vaultId === a.vault.id).map((m) => toMember(s, a, m)),
      items: items.map((i) => toItem(s, i)),
      revisions: items.flatMap((i) =>
        i.revisions.map((r) => ({
          itemId: i.id,
          revision: r.revision,
          keyVersion: r.keyVersion,
          itemKeyWrapped: r.itemKeyWrapped,
        })),
      ),
    };
  },
  vaultRotate: ({ s, params, body }) => {
    const u = user(s);
    const a = access(s, u.id, params.vaultId!);
    need(a, a.vault.kind === 'personal' ? 'vault.purge' : 'vault.manage_members');
    if (body.keyVersion !== a.vault.keyVersion + 1) {
      throw new MockApiError('vault_key_version_mismatch', undefined, {
        keyVersion: a.vault.keyVersion,
      });
    }
    if (body.removeUserIds.includes(u.id)) throw new MockApiError('vault_cannot_remove_self');
    const v = vaultState(s);
    const members = v.members.filter((m) => m.vaultId === a.vault.id);
    const remaining = members.filter((m) => !body.removeUserIds.includes(m.userId));
    const items = v.items.filter((i) => i.vaultId === a.vault.id);
    const sentItems = new Map(body.items.map((i) => [i.id, i]));
    const revCount = items.reduce((n, i) => n + i.revisions.length, 0);
    if (
      remaining.length !== body.members.length ||
      remaining.some((m) => !body.members.some((x) => x.userId === m.userId)) ||
      items.some((i) => sentItems.get(i.id)?.revision !== i.revision + 1) ||
      body.items.length !== items.length ||
      body.revisions.length !== revCount
    ) {
      throw new MockApiError('vault_rotation_incomplete');
    }
    if (!remaining.some((m) => m.role === 'manage')) throw new MockApiError('vault_last_manager');
    v.members = v.members.filter(
      (m) => m.vaultId !== a.vault.id || !body.removeUserIds.includes(m.userId),
    );
    for (const m of body.members) {
      const row = v.members.find((x) => x.vaultId === a.vault.id && x.userId === m.userId)!;
      row.wrappedKey = m.wrappedKey;
      row.keyVersion = body.keyVersion;
    }
    for (const i of items) {
      const sent = sentItems.get(i.id)!;
      Object.assign(i, {
        ciphertext: sent.ciphertext,
        nonce: sent.nonce,
        itemKeyWrapped: sent.itemKeyWrapped,
        revision: sent.revision,
        keyVersion: body.keyVersion,
        updatedAt: now(),
      });
      for (const r of i.revisions) {
        const w = body.revisions.find((x) => x.itemId === i.id && x.revision === r.revision);
        if (!w) throw new MockApiError('vault_rotation_incomplete');
        r.itemKeyWrapped = w.itemKeyWrapped;
        r.keyVersion = body.keyVersion;
      }
    }
    a.vault.keyVersion = body.keyVersion;
    bump(a);
    log(s, u.id, 'vault.rotate', { vaultId: a.vault.id, meta: { keyVersion: body.keyVersion } });
    for (const id of body.removeUserIds) {
      log(s, u.id, 'member.revoke', { vaultId: a.vault.id, targetUserId: id });
    }
    return toVault(s, access(s, u.id, a.vault.id));
  },

  vaultItems: ({ s, params }) => {
    const a = access(s, user(s).id, params.vaultId!);
    return {
      items: vaultState(s)
        .items.filter((i) => i.vaultId === a.vault.id)
        .map((i) => toItem(s, i)),
      nextCursor: null,
    };
  },
  vaultCreateItem: ({ s, params, body }) => {
    const u = user(s);
    const a = access(s, u.id, params.vaultId!);
    need(a, 'vault.edit');
    keyVersion(a, body.keyVersion);
    const v = vaultState(s);
    if (v.items.some((i) => i.id === body.id)) throw new MockApiError('conflict');
    const item = newItem(u, a.vault.id, body);
    v.items.push(item);
    bump(a);
    log(s, u.id, 'item.create', { vaultId: a.vault.id, itemId: item.id, field: item.type });
    return toItem(s, item);
  },
  vaultEmptyTrash: ({ s, params }) => {
    const u = user(s);
    const a = access(s, u.id, params.vaultId!);
    need(a, 'vault.purge');
    const v = vaultState(s);
    const before = v.items.length;
    v.items = v.items.filter((i) => i.vaultId !== a.vault.id || !i.deletedAt);
    bump(a);
    log(s, u.id, 'trash.empty', { vaultId: a.vault.id });
    return { purged: before - v.items.length };
  },
  vaultGetItem: ({ s, params }) => toItem(s, itemOf(s, user(s).id, params.itemId!).item),
  vaultUpdateItem: ({ s, params, body }) => {
    const u = user(s);
    const { item, a } = itemOf(s, u.id, params.itemId!);
    need(a, 'vault.edit');
    if (item.deletedAt) throw new MockApiError('conflict');
    if (body.revision !== item.revision + 1) {
      throw new MockApiError('vault_revision_conflict', undefined, {
        currentRevision: item.revision,
        updatedBy: userSummary(s, item.updatedBy),
        updatedAt: item.updatedAt,
      });
    }
    keyVersion(a, body.keyVersion);
    item.revisions = [
      {
        revision: item.revision,
        type: item.type,
        keyVersion: item.keyVersion,
        ciphertext: item.ciphertext,
        nonce: item.nonce,
        itemKeyWrapped: item.itemKeyWrapped,
        createdBy: item.updatedBy,
        createdAt: item.updatedAt,
      },
      ...item.revisions,
    ].slice(0, 10);
    Object.assign(item, {
      type: body.type,
      revision: body.revision,
      keyVersion: body.keyVersion,
      ciphertext: body.ciphertext,
      nonce: body.nonce,
      itemKeyWrapped: body.itemKeyWrapped,
      updatedBy: u.id,
      updatedAt: now(),
    });
    bump(a);
    log(s, u.id, 'item.update', { vaultId: a.vault.id, itemId: item.id });
    return toItem(s, item);
  },
  vaultTrashItem: ({ s, params }) => {
    const u = user(s);
    const { item, a } = itemOf(s, u.id, params.itemId!);
    need(a, 'vault.edit');
    item.deletedAt ??= now();
    item.deletedBy ??= u.id;
    bump(a);
    log(s, u.id, 'item.trash', { vaultId: a.vault.id, itemId: item.id });
    return toItem(s, item);
  },
  vaultRestoreItem: ({ s, params }) => {
    const u = user(s);
    const { item, a } = itemOf(s, u.id, params.itemId!);
    need(a, 'vault.restore');
    item.deletedAt = null;
    item.deletedBy = null;
    bump(a);
    log(s, u.id, 'item.restore', { vaultId: a.vault.id, itemId: item.id });
    return toItem(s, item);
  },
  vaultPurgeItem: ({ s, params }) => {
    const u = user(s);
    const { item, a } = itemOf(s, u.id, params.itemId!);
    need(a, 'vault.purge');
    const v = vaultState(s);
    v.items = v.items.filter((i) => i !== item);
    bump(a);
    log(s, u.id, 'item.purge', { vaultId: a.vault.id, itemId: item.id });
    return {};
  },
  vaultDeleteItemRevision: ({ s, params }) => {
    const u = user(s);
    const { item, a } = itemOf(s, u.id, params.itemId!);
    need(a, 'vault.purge');
    const revision = Number(params.revision);
    if (revision === item.revision) throw new MockApiError('vault_revision_current');
    if (!item.revisions.some((r) => r.revision === revision)) {
      throw new MockApiError('not_found');
    }
    item.revisions = item.revisions.filter((r) => r.revision !== revision);
    bump(a);
    log(s, u.id, 'item.revision_purge', {
      vaultId: a.vault.id,
      itemId: item.id,
      meta: { revision },
    });
    return {};
  },
  vaultMoveItem: ({ s, params, body }) => {
    const u = user(s);
    const { item, a } = itemOf(s, u.id, params.itemId!);
    need(a, 'vault.edit');
    const t = access(s, u.id, body.targetVaultId);
    need(t, 'vault.edit');
    keyVersion(t, body.item.keyVersion);
    const v = vaultState(s);
    const moved = newItem(u, t.vault.id, body.item, { createdAt: item.createdAt });
    moved.attachments = item.attachments;
    v.items = v.items.filter((i) => i !== item);
    v.items.push(moved);
    bump(a);
    bump(t);
    log(s, u.id, 'item.move', { vaultId: a.vault.id, itemId: item.id });
    return toItem(s, moved);
  },
  vaultItemRevisions: ({ s, params }) => {
    const { item } = itemOf(s, user(s).id, params.itemId!);
    return { items: item.revisions.map((r) => ({ ...r, createdBy: userSummary(s, r.createdBy) })) };
  },
  vaultImport: ({ s, body }) => {
    const u = user(s);
    const v = vaultState(s);
    const byVault = new Map<string, number>();
    for (const i of body.items) {
      const a = access(s, u.id, i.vaultId);
      need(a, 'vault.edit');
      keyVersion(a, i.keyVersion);
    }
    for (const i of body.items) {
      v.items.push(newItem(u, i.vaultId, i, i));
      byVault.set(i.vaultId, (byVault.get(i.vaultId) ?? 0) + 1);
    }
    for (const [vaultId, count] of byVault) {
      bump(access(s, u.id, vaultId));
      log(s, u.id, 'import', { vaultId, meta: { count } });
    }
    return {
      imported: body.items.length,
      byVault: [...byVault].map(([vaultId, count]) => ({ vaultId, count })),
    };
  },

  // Attachments need a store; the mock keeps encrypted bytes as data URLs in memory.
  vaultCreateAttachment: ({ s, params, body }) => {
    const u = user(s);
    const { item, a } = itemOf(s, u.id, params.itemId!);
    need(a, 'vault.edit');
    if (item.deletedAt) throw new MockApiError('conflict');
    pendingUploads.set(body.id, { itemId: item.id, size: body.size });
    return {
      id: body.id,
      partSize: 16 * 1024 * 1024,
      parts: [{ partNumber: 1, url: `${location.origin}/__mock-vault-upload/${body.id}` }],
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    };
  },
  vaultCompleteAttachment: ({ s, params }) => {
    const u = user(s);
    const { item, a } = itemOf(s, u.id, params.itemId!);
    const p = pendingUploads.get(params.attachmentId!);
    if (!p || p.itemId !== item.id) throw new MockApiError('upload_invalid');
    pendingUploads.delete(params.attachmentId!);
    const att = { id: params.attachmentId!, size: p.size, createdAt: now() };
    item.attachments.push(att);
    bump(a);
    return att;
  },
  vaultAttachmentUrl: ({ s, params }) => {
    const u = user(s);
    const { item, a } = itemOf(s, u.id, params.itemId!);
    if (!item.attachments.some((x) => x.id === params.attachmentId)) {
      throw new MockApiError('not_found');
    }
    log(s, u.id, 'item.download', { vaultId: a.vault.id, itemId: item.id, field: 'attachment' });
    return {
      url: `${location.origin}/__mock-vault-upload/${params.attachmentId}`,
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    };
  },
  vaultDeleteAttachment: ({ s, params }) => {
    const u = user(s);
    const { item, a } = itemOf(s, u.id, params.itemId!);
    need(a, 'vault.edit');
    item.attachments = item.attachments.filter((x) => x.id !== params.attachmentId);
    attachmentBytes.delete(params.attachmentId!);
    bump(a);
    return {};
  },

  vaultReportEvents: ({ s, body }) => {
    const u = user(s);
    for (const e of body.events) {
      itemOf(s, u.id, e.itemId);
      log(s, u.id, e.action === 'reveal' ? 'item.reveal' : 'item.copy', {
        vaultId: e.vaultId,
        itemId: e.itemId,
        field: e.field,
      });
    }
    return {};
  },
  vaultEvents: ({ s, query }) => {
    const u = user(s);
    const v = vaultState(s);
    let visible: VaultState['events'];
    if (query.vaultId) {
      need(access(s, u.id, query.vaultId), 'vault.view_log');
      visible = v.events.filter((e) => e.vaultId === query.vaultId);
    } else {
      const managed = new Set(
        v.members.filter((m) => m.userId === u.id && m.role === 'manage').map((m) => m.vaultId),
      );
      visible = v.events.filter(
        (e) => (e.vaultId && managed.has(e.vaultId)) || (!e.vaultId && e.actorId === u.id),
      );
    }
    const filtered = visible
      .filter(
        (e) =>
          (!query.userId || e.actorId === query.userId) &&
          (!query.action || e.action === query.action) &&
          (!query.since || e.at >= query.since),
      )
      .sort((x, y) => Number(y.id) - Number(x.id))
      .filter((e) => !query.cursor || Number(e.id) < Number(query.cursor));
    const page = filtered.slice(0, query.limit);
    return {
      items: page.map(({ actorId, targetUserId, ...e }) => ({
        ...e,
        actor: userSummary(s, actorId),
        targetUser: userSummary(s, targetUserId),
      })),
      nextCursor: filtered.length > query.limit ? page[page.length - 1]!.id : null,
    };
  },

  /* ---------------------- roadmap 20: policy, leak check, share links ---------------------- */

  vaultPolicy: ({ s }) => {
    user(s);
    return { ...policyOf(s), canEdit: isOrgAdmin(s) };
  },
  vaultUpdatePolicy: ({ s, body }) => {
    const u = user(s);
    if (!isOrgAdmin(s)) throw new MockApiError('forbidden');
    const next = { ...policyOf(s) };
    for (const [k, v] of Object.entries(body)) if (v !== undefined) Object.assign(next, { [k]: v });
    vaultState(s).policy = next;
    log(s, u.id, 'policy.update');
    return { ...next, canEdit: true };
  },
  vaultBreachRange: ({ s, params }) => {
    user(s);
    if (!policyOf(s).breachCheck) throw new MockApiError('vault_breach_disabled');
    const prefix = params.prefix ?? '';
    if (!/^[0-9A-F]{5}$/.test(prefix)) throw new MockApiError('not_found');
    return { range: [...(MOCK_BREACHES[prefix] ?? []), `${'0'.repeat(35)}:0`].join('\r\n') };
  },
  vaultCreateShare: async ({ s, params, body }) => {
    const u = user(s);
    const { item, a } = itemOf(s, u.id, params.itemId!);
    if (item.deletedAt) throw new MockApiError('not_found');
    need(a, 'vault.share_link');
    const policy = policyOf(s);
    if (!policy.shareLinks) throw new MockApiError('vault_share_disabled');
    if (body.expiresInHours > policy.shareMaxHours || body.maxViews > policy.shareMaxViews) {
      throw new MockApiError('vault_share_limit');
    }
    const token = randomToken();
    const share: MockShare = {
      id: newId(),
      tokenHash: await sha256(btoa(token)),
      vaultId: item.vaultId,
      itemId: item.id,
      ciphertext: body.ciphertext,
      nonce: body.nonce,
      maxViews: body.maxViews,
      views: 0,
      expiresAt: new Date(Date.now() + body.expiresInHours * 3_600_000).toISOString(),
      createdBy: u.id,
      createdAt: now(),
    };
    sharesOf(s).push(share);
    log(s, u.id, 'share.create', { vaultId: item.vaultId, itemId: item.id });
    return { ...toShare(s, share), token };
  },
  vaultShares: ({ s, query }) => {
    const u = user(s);
    const v = vaultState(s);
    const managed = new Set(
      v.members.filter((m) => m.userId === u.id && m.role === 'manage').map((m) => m.vaultId),
    );
    return {
      items: liveShares(s)
        .filter((x) => !query.itemId || x.itemId === query.itemId)
        .filter((x) => x.createdBy === u.id || managed.has(x.vaultId))
        .map((x) => toShare(s, x)),
    };
  },
  vaultRevokeShare: ({ s, params }) => {
    const u = user(s);
    const v = vaultState(s);
    const share = sharesOf(s).find((x) => x.id === params.shareId);
    if (!share) throw new MockApiError('not_found');
    if (share.createdBy !== u.id) need(access(s, u.id, share.vaultId), 'vault.view_log');
    v.shares = sharesOf(s).filter((x) => x !== share);
    log(s, u.id, 'share.revoke', { vaultId: share.vaultId, itemId: share.itemId });
    return {};
  },
  vaultPublicShare: async ({ s, params }) => {
    const share = await liveShare(s, params.token ?? '');
    return { expiresAt: share.expiresAt, viewsLeft: share.maxViews - share.views };
  },
  vaultOpenShare: async ({ s, params }) => {
    const share = await liveShare(s, params.token ?? '');
    share.views++;
    const viewsLeft = share.maxViews - share.views;
    if (viewsLeft <= 0) vaultState(s).shares = sharesOf(s).filter((x) => x !== share);
    return {
      expiresAt: share.expiresAt,
      viewsLeft,
      ciphertext: share.ciphertext,
      nonce: share.nonce,
    };
  },
};

/**
 * Suffixes the mock range relay "knows", per SHA-1 prefix: "password" and "123456" are in
 * every breach list (k-anonymity: the client sends only the prefix and matches the rest).
 */
const MOCK_BREACHES: Record<string, string[]> = {
  '5BAA6': ['1E4C9B93F3F0682250B6CF8331B7EE68FD8:9545824'],
  '7C4A8': ['D09CA3762AF61E59520943DC26494F8941B:37359195'],
};

const DEFAULT_POLICY: Omit<VaultPolicy, 'canEdit'> = {
  breachCheck: true,
  breachRangeUrl: null,
  shareLinks: true,
  shareMaxHours: 720,
  shareMaxViews: 20,
};

const policyOf = (s: MockState) => vaultState(s).policy ?? DEFAULT_POLICY;

function isOrgAdmin(s: MockState) {
  const u = requireUser(s);
  const m = s.members.find((x) => x.userId === u.id);
  return m?.role === 'owner' || m?.role === 'admin';
}

const sharesOf = (s: MockState) => (vaultState(s).shares ??= []);

const liveShares = (s: MockState) =>
  sharesOf(s).filter((x) => x.views < x.maxViews && Date.parse(x.expiresAt) > Date.now());

async function liveShare(s: MockState, token: string) {
  const hash = await sha256(btoa(token));
  const share = liveShares(s).find((x) => x.tokenHash === hash);
  if (!share) throw new MockApiError('vault_share_gone');
  if (!policyOf(s).shareLinks) throw new MockApiError('vault_share_disabled');
  return share;
}

function toShare(s: MockState, x: MockShare): VaultShare {
  return {
    id: x.id,
    vaultId: x.vaultId,
    itemId: x.itemId,
    createdBy: userSummary(s, x.createdBy),
    createdAt: x.createdAt,
    expiresAt: x.expiresAt,
    maxViews: x.maxViews,
    views: x.views,
  };
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** Encrypted attachment bytes PUT by the client during an upload (mock store). */
export const attachmentBytes = new Map<string, Blob>();
const pendingUploads = new Map<string, { itemId: string; size: number }>();

/** The presigned PUT / GET the mock hands out for attachments. */
export const vaultRawHandlers = [
  http.put('*/__mock-vault-upload/:id', async ({ request, params }) => {
    attachmentBytes.set(String(params.id), await request.blob());
    return new HttpResponse(null, { status: 200, headers: { etag: `"${String(params.id)}"` } });
  }),
  http.get('*/__mock-vault-upload/:id', ({ params }) => {
    const blob = attachmentBytes.get(String(params.id));
    return blob ? new HttpResponse(blob) : new HttpResponse(null, { status: 404 });
  }),
];
