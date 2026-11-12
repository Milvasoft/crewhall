import { z } from 'zod';
import { Id, Timestamp } from './common';
import { UserSummary } from './org';
import { SpaceColor, SpaceRole } from './space';

/**
 * Zero-knowledge vault (design 08, doc 17 §4 and §7). The server stores and returns only
 * ciphertext, wrapped keys and metadata; every byte value is base64 on the wire. Clients do
 * all cryptography with @crewhall/crypto, which the server never imports.
 */

/** Base64 bytes with a size cap (decoded bytes). */
const B64 = (maxBytes: number) => z.base64().max(Math.ceil(maxBytes / 3) * 4);
const Key32 = z.base64().length(44);
/** Sealed / enveloped 32-byte keys are at most ~110 bytes. */
const WrappedKey = B64(256).min(40);
/** 32-byte verifier the server hashes and compares (never stored as is). */
const Verifier = Key32;

export const VAULT_ITEM_TYPES = [
  'login',
  'note',
  'card',
  'api_key',
  'ssh_key',
  'identity',
] as const;
export const VaultItemType = z.enum(VAULT_ITEM_TYPES);
export type VaultItemType = z.infer<typeof VaultItemType>;

/** Per-vault permission (design 8.10): Görüntüle, Düzenle, Yönet. */
export const VaultRole = z.enum(['read', 'edit', 'manage']);
export type VaultRole = z.infer<typeof VaultRole>;

export const VaultKind = z.enum(['personal', 'space']);
export type VaultKind = z.infer<typeof VaultKind>;

export const VaultUnlockMethodKind = z.enum(['password', 'recovery', 'passkey_prf', 'device']);
export type VaultUnlockMethodKind = z.infer<typeof VaultUnlockMethodKind>;

/* ---------------------------------- keys ---------------------------------- */

/** Argon2id parameters (user_keys.kdf); clients refuse values below their floor. */
export const VaultKdf = z.object({
  alg: z.literal('argon2id'),
  m: z.number().int().min(32768).max(1048576),
  t: z.number().int().min(2).max(16),
  p: z.number().int().min(1).max(16),
  salt: z.base64().min(24).max(64),
});
export type VaultKdf = z.infer<typeof VaultKdf>;

export const VaultUnlockMethod = z.object({
  id: Id,
  method: z.enum(['passkey_prf', 'device']),
  label: z.string(),
  /** WebAuthn credential id (base64url) for passkey_prf. */
  credentialId: z.string().nullable(),
  /** PRF evaluation input (base64) for passkey_prf. */
  prfSalt: z.string().nullable(),
  createdAt: Timestamp,
  lastUsedAt: Timestamp.nullable(),
});
export type VaultUnlockMethod = z.infer<typeof VaultUnlockMethod>;

/** Public part of a person's vault keys; safe to return before unlocking. */
export const VaultKeyStatus = z.object({
  setUp: z.boolean(),
  publicKey: z.string().nullable(),
  fingerprint: z.string().nullable(),
  kdf: VaultKdf.nullable(),
  keyVersion: z.number().int(),
  unlockMethods: z.array(VaultUnlockMethod),
  recoveryCreatedAt: Timestamp.nullable(),
  passwordChangedAt: Timestamp.nullable(),
  /** Wrong verifiers in a row; at 5 the server waits 30 s (design 8.3). */
  failedAttempts: z.number().int(),
  lockedUntil: Timestamp.nullable(),
});
export type VaultKeyStatus = z.infer<typeof VaultKeyStatus>;

export const VaultSetupKeys = z.object({
  publicKey: Key32,
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  kdf: VaultKdf,
  encryptedPrivateKey: WrappedKey,
  passwordVerifier: Verifier,
  recoveryWrappedKey: WrappedKey,
  recoveryVerifier: Verifier,
  /** The personal vault is created with the keys (design 8.17). */
  personalVault: z.object({ id: Id, wrappedKey: WrappedKey }),
});
export type VaultSetupKeys = z.infer<typeof VaultSetupKeys>;

export const VaultUnlockRequest = z.object({
  method: VaultUnlockMethodKind,
  /** Required for passkey_prf and device. */
  unlockId: Id.optional(),
  verifier: Verifier,
});
export type VaultUnlockRequest = z.infer<typeof VaultUnlockRequest>;

/** Released only after a correct verifier. */
export const VaultUnlockBundle = z.object({
  method: VaultUnlockMethodKind,
  publicKey: z.string(),
  wrappedPrivateKey: z.string(),
  keyVersion: z.number().int(),
  /** Encrypted account settings (auto-lock, clipboard, TOFU pins), or null. */
  settings: z.string().nullable(),
});
export type VaultUnlockBundle = z.infer<typeof VaultUnlockBundle>;

/** Proof that the caller knows the vault password (or recovery key) right now. */
export const VaultProof = z.object({
  method: z.enum(['password', 'recovery']),
  verifier: Verifier,
});

export const VaultChangePassword = z.object({
  proof: VaultProof,
  kdf: VaultKdf,
  encryptedPrivateKey: WrappedKey,
  passwordVerifier: Verifier,
});

export const VaultRotateRecovery = z.object({
  proof: VaultProof,
  recoveryWrappedKey: WrappedKey,
  recoveryVerifier: Verifier,
});

export const VaultAddUnlockMethod = z.object({
  proof: VaultProof,
  method: z.enum(['passkey_prf', 'device']),
  label: z.string().trim().min(1).max(100),
  credentialId: z.string().max(1024).optional(),
  prfSalt: Key32.optional(),
  wrappedPrivateKey: WrappedKey,
  verifier: Verifier,
});

export const VaultSettingsBlob = z.object({ settings: B64(64 * 1024) });
/** What is stored now, to build on and to compare with what this device last saw. */
export const VaultStoredSettings = z.object({ settings: z.string().nullable() });

export const VaultPublicKey = z.object({
  userId: Id,
  publicKey: z.string(),
  fingerprint: z.string(),
  keyVersion: z.number().int(),
});
export type VaultPublicKey = z.infer<typeof VaultPublicKey>;

/* ---------------------------------- vaults ---------------------------------- */

export const VaultSpaceRef = z.object({
  id: Id,
  name: z.string(),
  slug: z.string(),
  color: SpaceColor,
});

export const Vault = z.object({
  id: Id,
  kind: VaultKind,
  /** Null for the personal vault (the UI names it). Vault names are visible to the server. */
  name: z.string().nullable(),
  space: VaultSpaceRef.nullable(),
  keyVersion: z.number().int(),
  /** Bumped on every change in the vault: refetch items when it moves. */
  revision: z.number().int(),
  myRole: VaultRole,
  /** My copy of the vault key, sealed to my public key. */
  myWrappedKey: z.string(),
  canEdit: z.boolean(),
  canManage: z.boolean(),
  itemCount: z.number().int(),
  trashCount: z.number().int(),
  memberCount: z.number().int(),
  /** Members who lost space access but still hold a key: rotate (design 8.10). */
  staleMemberCount: z.number().int(),
  createdBy: UserSummary.nullable(),
  createdAt: Timestamp,
});
export type Vault = z.infer<typeof Vault>;

/**
 * A space vault, or (spaceId null) the personal vault in an org where the person has keys but
 * no personal vault yet (keys belong to the person, personal vaults to an org).
 */
export const CreateVault = z.object({
  id: Id,
  spaceId: Id.nullable(),
  /** Required for space vaults. */
  name: z.string().trim().min(1).max(100).optional(),
  /** The vault key sealed to the creator, key version 1. */
  wrappedKey: WrappedKey,
});

export const UpdateVault = z.object({ name: z.string().trim().min(1).max(100) });

export const VaultMember = z.object({
  user: UserSummary,
  role: VaultRole,
  /** Null when the person is no longer in the space: their access is stale. */
  spaceRole: SpaceRole.nullable(),
  publicKey: z.string(),
  fingerprint: z.string(),
  grantedBy: UserSummary.nullable(),
  grantedAt: Timestamp,
});
export type VaultMember = z.infer<typeof VaultMember>;

export const VaultCandidatesQuery = z.object({ q: z.string().max(100).optional() });

export const VaultCandidate = z.object({
  user: UserSummary,
  spaceRole: SpaceRole.nullable(),
  /** Null when the person has not set up the vault yet (design 8.10: cannot be picked). */
  publicKey: z.string().nullable(),
  fingerprint: z.string().nullable(),
});
export type VaultCandidate = z.infer<typeof VaultCandidate>;

export const GrantVaultAccess = z.object({
  userId: Id,
  role: VaultRole,
  /** Must equal the vault's current key version. */
  keyVersion: z.number().int().min(1),
  wrappedKey: WrappedKey,
});

export const UpdateVaultMember = z.object({ role: VaultRole });

const EncryptedFields = {
  ciphertext: B64(2 * 1024 * 1024).min(4),
  nonce: z.base64().length(16),
  itemKeyWrapped: WrappedKey,
};

/**
 * Key rotation (doc 17 §7): a new key version, sealed again to every remaining member, and
 * every item (trash included) re-encrypted at revision + 1. Old revisions only get their item
 * key re-wrapped. One transaction: incomplete payloads are refused.
 */
export const RotateVault = z.object({
  keyVersion: z.number().int().min(2),
  removeUserIds: z.array(Id).max(500).default([]),
  members: z.array(z.object({ userId: Id, wrappedKey: WrappedKey })).max(1000),
  items: z
    .array(z.object({ id: Id, revision: z.number().int().min(2), ...EncryptedFields }))
    .max(10_000),
  revisions: z
    .array(z.object({ itemId: Id, revision: z.number().int().min(1), itemKeyWrapped: WrappedKey }))
    .max(110_000),
});
export type RotateVault = z.infer<typeof RotateVault>;

export const VaultRotationRevision = z.object({
  itemId: Id,
  revision: z.number().int(),
  keyVersion: z.number().int(),
  itemKeyWrapped: z.string(),
});

/* ---------------------------------- items ---------------------------------- */

export const VaultAttachment = z.object({
  id: Id,
  /** Encrypted size in bytes. */
  size: z.number().int(),
  createdAt: Timestamp,
});
export type VaultAttachment = z.infer<typeof VaultAttachment>;

export const VaultItem = z.object({
  id: Id,
  vaultId: Id,
  type: VaultItemType,
  revision: z.number().int(),
  keyVersion: z.number().int(),
  ciphertext: z.string(),
  nonce: z.string(),
  itemKeyWrapped: z.string(),
  attachments: z.array(VaultAttachment),
  createdBy: UserSummary.nullable(),
  updatedBy: UserSummary.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  /** Set while in the trash (30 days, design 8.18). */
  deletedAt: Timestamp.nullable(),
  deletedBy: UserSummary.nullable(),
});
export type VaultItem = z.infer<typeof VaultItem>;

export const VaultItemsQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(500),
});

export const CreateVaultItem = z.object({
  /** Client-generated (it is bound into the ciphertext before upload). */
  id: Id,
  type: VaultItemType,
  keyVersion: z.number().int().min(1),
  ...EncryptedFields,
});
export type CreateVaultItem = z.infer<typeof CreateVaultItem>;

export const UpdateVaultItem = z.object({
  type: VaultItemType,
  /** Must be exactly the current revision + 1; revisions only increase. */
  revision: z.number().int().min(2),
  keyVersion: z.number().int().min(1),
  ...EncryptedFields,
});
export type UpdateVaultItem = z.infer<typeof UpdateVaultItem>;

export const MoveVaultItem = z.object({
  targetVaultId: Id,
  /** The item re-encrypted for the target vault at revision 1 (attachments move along). */
  item: CreateVaultItem,
});

export const VaultItemRevision = z.object({
  revision: z.number().int(),
  type: VaultItemType,
  keyVersion: z.number().int(),
  ciphertext: z.string(),
  nonce: z.string(),
  itemKeyWrapped: z.string(),
  createdBy: UserSummary.nullable(),
  createdAt: Timestamp,
});
export type VaultItemRevision = z.infer<typeof VaultItemRevision>;

export const VAULT_IMPORT_MAX = 5000;

/** Bitwarden import (design 8.14): one transaction, all or nothing. */
export const VaultImport = z.object({
  items: z
    .array(
      CreateVaultItem.extend({
        vaultId: Id,
        /** Bitwarden creation / revision dates are kept. */
        createdAt: Timestamp.optional(),
        updatedAt: Timestamp.optional(),
      }),
    )
    .min(1)
    .max(VAULT_IMPORT_MAX),
});

export const VaultImportResult = z.object({
  imported: z.number().int(),
  byVault: z.array(z.object({ vaultId: Id, count: z.number().int() })),
});

export const VaultRotationData = z.object({
  vault: z.lazy(() => Vault),
  members: z.array(VaultMember),
  items: z.array(VaultItem),
  revisions: z.array(VaultRotationRevision),
});
export type VaultRotationData = z.infer<typeof VaultRotationData>;

/* ---------------------------------- attachments ---------------------------------- */

export const VAULT_ATTACHMENT_MAX_BYTES = 100 * 1024 * 1024 + 64 * 1024;

export const CreateVaultAttachment = z.object({
  id: Id,
  /** Encrypted size (plaintext + chunk tags). */
  size: z.number().int().min(25).max(VAULT_ATTACHMENT_MAX_BYTES),
});

export const VaultAttachmentUpload = z.object({
  id: Id,
  partSize: z.number().int(),
  parts: z.array(z.object({ partNumber: z.number().int(), url: z.url() })),
  expiresAt: Timestamp,
});

export const CompleteVaultAttachment = z.object({
  parts: z
    .array(z.object({ partNumber: z.number().int().min(1), etag: z.string().min(1) }))
    .min(1)
    .max(100),
});

export const VaultSignedUrl = z.object({ url: z.url(), expiresAt: Timestamp });

/* ---------------------------------- access log ---------------------------------- */

/** Client-reported (design 8.11): which field was shown or copied, never its value. */
export const VaultClientEvent = z.object({
  vaultId: Id,
  itemId: Id,
  action: z.enum(['reveal', 'copy']),
  field: z.string().trim().min(1).max(50),
});

export const ReportVaultEvents = z.object({ events: z.array(VaultClientEvent).min(1).max(50) });

export const VAULT_EVENT_ACTIONS = [
  'keys.setup',
  'keys.password',
  'keys.recovery',
  'keys.unlock_method',
  'unlock',
  'unlock_failed',
  'vault.create',
  'vault.update',
  'vault.delete',
  'vault.rotate',
  'member.grant',
  'member.role',
  'member.revoke',
  'item.create',
  'item.update',
  'item.trash',
  'item.restore',
  'item.purge',
  'item.revision_purge',
  'item.move',
  'item.reveal',
  'item.copy',
  'item.download',
  'trash.empty',
  'import',
  /** Roadmap 20: one-time share links and the org vault policy. */
  'share.create',
  'share.open',
  'share.revoke',
  'policy.update',
] as const;
export const VaultEventAction = z.enum(VAULT_EVENT_ACTIONS);
export type VaultEventAction = z.infer<typeof VaultEventAction>;

export const VaultEventsQuery = z.object({
  vaultId: Id.optional(),
  userId: Id.optional(),
  action: VaultEventAction.optional(),
  since: Timestamp.optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const VaultEvent = z.object({
  id: z.string(),
  at: Timestamp,
  actor: UserSummary.nullable(),
  action: VaultEventAction,
  vaultId: Id.nullable(),
  itemId: Id.nullable(),
  /** Field shown / copied, unlock method, … */
  field: z.string().nullable(),
  targetUser: UserSummary.nullable(),
  meta: z.record(z.string(), z.unknown()),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
});
export type VaultEvent = z.infer<typeof VaultEvent>;

/* ---------------------------------- permissions ---------------------------------- */

export type VaultAction =
  | 'vault.read'
  | 'vault.edit'
  | 'vault.restore'
  | 'vault.purge'
  | 'vault.manage_members'
  | 'vault.view_log'
  | 'vault.rename'
  | 'vault.delete'
  /** Roadmap 20: one-time link to someone outside (the org may switch links off). */
  | 'vault.share_link';

const VAULT_RANK: Record<VaultRole, number> = { read: 0, edit: 1, manage: 2 };
const SPACE_RANK: Record<SpaceRole, number> = { viewer: 0, editor: 1, admin: 2, owner: 3 };

/**
 * Vault permissions (doc 17 §5 "Space kasası"; design 8.10, 8.18). Both conditions hold:
 * the person's own vault_members row (they must hold the key) and their space role. A personal
 * vault has exactly one member, its owner, and no space.
 */
export function canVault(
  input: { kind: VaultKind; vaultRole: VaultRole | null; spaceRole: SpaceRole | null },
  action: VaultAction,
): boolean {
  const { kind, vaultRole, spaceRole } = input;
  if (vaultRole === null) return false;
  if (kind === 'personal') return action !== 'vault.manage_members' && action !== 'vault.delete';
  if (spaceRole === null) return false;
  const v = VAULT_RANK[vaultRole];
  const s = SPACE_RANK[spaceRole];
  switch (action) {
    case 'vault.read':
      return true;
    case 'vault.edit':
    case 'vault.restore':
    case 'vault.share_link':
      return v >= VAULT_RANK.edit && s >= SPACE_RANK.editor;
    case 'vault.purge':
    case 'vault.view_log':
    case 'vault.rename':
      return v >= VAULT_RANK.manage;
    case 'vault.manage_members':
      return v >= VAULT_RANK.manage && s >= SPACE_RANK.admin;
    case 'vault.delete':
      return v >= VAULT_RANK.manage && s >= SPACE_RANK.owner;
  }
}

/** Creating a space vault: space owners and admins (design 8.17). */
export const canCreateSpaceVault = (spaceRole: SpaceRole | null) =>
  spaceRole !== null && SPACE_RANK[spaceRole] >= SPACE_RANK.admin;

/* ------------------------------ roadmap 20: policy ------------------------------ */

/** Share link limits (roadmap 20): at most 30 days and 20 opens. */
export const VAULT_SHARE_MAX_HOURS = 24 * 30;
export const VAULT_SHARE_MAX_VIEWS = 20;
/** Default range API of the leaked password check (Have I Been Pwned, k-anonymity). */
export const VAULT_BREACH_DEFAULT_URL = 'https://api.pwnedpasswords.com';

/**
 * Org-wide vault policy (Kasa › Ayarlar › Kurum politikası, org admins). No stored row means
 * the defaults: leaked password check on through the public range API, share links on.
 */
export const VaultPolicy = z.object({
  breachCheck: z.boolean(),
  /**
   * Base URL of the range API (`<url>/range/<prefix>`) for installations without internet
   * access: an internal mirror or a reverse proxy. Null = VAULT_BREACH_DEFAULT_URL.
   */
  breachRangeUrl: z.url().nullable(),
  shareLinks: z.boolean(),
  /** Upper bounds a link may ask for. */
  shareMaxHours: z.number().int().min(1).max(VAULT_SHARE_MAX_HOURS),
  shareMaxViews: z.number().int().min(1).max(VAULT_SHARE_MAX_VIEWS),
  /** Whether the caller may change it (can(actor, 'org.update_settings')). */
  canEdit: z.boolean(),
});
export type VaultPolicy = z.infer<typeof VaultPolicy>;

export const UpdateVaultPolicy = z.object({
  breachCheck: z.boolean().optional(),
  breachRangeUrl: z
    .url({ protocol: /^https?$/ })
    .max(500)
    .nullable()
    .optional(),
  shareLinks: z.boolean().optional(),
  shareMaxHours: z.number().int().min(1).max(VAULT_SHARE_MAX_HOURS).optional(),
  shareMaxViews: z.number().int().min(1).max(VAULT_SHARE_MAX_VIEWS).optional(),
});
export type UpdateVaultPolicy = z.infer<typeof UpdateVaultPolicy>;

/**
 * One k-anonymity range answer, relayed as is: `SUFFIX:COUNT` lines (35 hex digits each),
 * padded with zero-count decoys. Only the 5-digit prefix ever reaches the server.
 */
export const VaultBreachRange = z.object({ range: z.string() });
export type VaultBreachRange = z.infer<typeof VaultBreachRange>;

/* ---------------------------- roadmap 20: share links ---------------------------- */

/**
 * The ciphertext of a link is the item encrypted again under a fresh key that only the
 * fragment of the link holds (@crewhall/crypto encryptShare); the server cannot open it.
 */
export const CreateVaultShare = z.object({
  ciphertext: B64(512 * 1024).min(4),
  nonce: z.base64().length(16),
  expiresInHours: z.number().int().min(1).max(VAULT_SHARE_MAX_HOURS),
  maxViews: z.number().int().min(1).max(VAULT_SHARE_MAX_VIEWS),
});
export type CreateVaultShare = z.infer<typeof CreateVaultShare>;

export const VaultShare = z.object({
  id: Id,
  vaultId: Id,
  itemId: Id,
  createdBy: UserSummary.nullable(),
  createdAt: Timestamp,
  expiresAt: Timestamp,
  maxViews: z.number().int(),
  views: z.number().int(),
  /**
   * Only in the create response: the random token for `/vault-share/<token>`. The server
   * keeps its hash; the client appends `#<key>` itself.
   */
  token: z.string().optional(),
});
export type VaultShare = z.infer<typeof VaultShare>;

export const VaultSharesQuery = z.object({ itemId: Id.optional() });

/** Public preview: no content, does not count as an open. */
export const PublicVaultShare = z.object({
  expiresAt: Timestamp,
  viewsLeft: z.number().int(),
});
export type PublicVaultShare = z.infer<typeof PublicVaultShare>;

/** Opening counts one view; the row (ciphertext included) is deleted after the last. */
export const OpenedVaultShare = PublicVaultShare.extend({
  ciphertext: z.string(),
  nonce: z.string(),
});
export type OpenedVaultShare = z.infer<typeof OpenedVaultShare>;
