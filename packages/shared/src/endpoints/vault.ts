import { z } from 'zod';
import { Empty, def, items, type EndpointDef } from '../endpoint-def';
import { page } from '../schemas/common';
import {
  CompleteVaultAttachment,
  CreateVault,
  CreateVaultShare,
  OpenedVaultShare,
  PublicVaultShare,
  UpdateVaultPolicy,
  VaultBreachRange,
  VaultPolicy,
  VaultShare,
  VaultSharesQuery,
  CreateVaultAttachment,
  CreateVaultItem,
  GrantVaultAccess,
  MoveVaultItem,
  ReportVaultEvents,
  RotateVault,
  UpdateVault,
  UpdateVaultItem,
  UpdateVaultMember,
  Vault,
  VaultAddUnlockMethod,
  VaultAttachment,
  VaultAttachmentUpload,
  VaultCandidate,
  VaultCandidatesQuery,
  VaultChangePassword,
  VaultEvent,
  VaultEventsQuery,
  VaultImport,
  VaultImportResult,
  VaultItem,
  VaultItemRevision,
  VaultItemsQuery,
  VaultKeyStatus,
  VaultMember,
  VaultPublicKey,
  VaultRotateRecovery,
  VaultRotationData,
  VaultSettingsBlob,
  VaultStoredSettings,
  VaultSetupKeys,
  VaultSignedUrl,
  VaultUnlockBundle,
  VaultUnlockMethod,
  VaultUnlockRequest,
} from '../schemas/vault';

/**
 * Vault module contract (design 08, doc 17 §7). Only the vault session edits this file.
 * The server sees ciphertext, wrapped keys and metadata only. Endpoint names start with
 * `vault` to stay unique across modules.
 */
export const vaultEndpoints = {
  /* --------------------------- keys and unlocking --------------------------- */

  /** Public key state; never contains wrapped private keys. */
  vaultKeys: def({
    method: 'GET',
    path: '/api/v1/vault/keys',
    auth: 'session',
    response: VaultKeyStatus,
  }),
  /** Setup (design 8.1-8.2): key pair, password and recovery wraps, the personal vault. */
  vaultSetupKeys: def({
    method: 'POST',
    path: '/api/v1/vault/keys',
    auth: 'session',
    body: VaultSetupKeys,
    response: VaultKeyStatus,
  }),
  /** Releases the wrapped private key for a correct verifier; 5 misses → 30 s wait. */
  vaultUnlock: def({
    method: 'POST',
    path: '/api/v1/vault/keys/unlock',
    auth: 'session',
    body: VaultUnlockRequest,
    response: VaultUnlockBundle,
  }),
  /** New vault password, also the last step of recovery (proof: recovery verifier). */
  vaultChangePassword: def({
    method: 'PUT',
    path: '/api/v1/vault/keys/password',
    auth: 'session',
    body: VaultChangePassword,
    response: VaultKeyStatus,
  }),
  /** New recovery key; the old one stops working at once (design 8.16). */
  vaultRotateRecovery: def({
    method: 'PUT',
    path: '/api/v1/vault/keys/recovery',
    auth: 'session',
    body: VaultRotateRecovery,
    response: VaultKeyStatus,
  }),
  vaultAddUnlockMethod: def({
    method: 'POST',
    path: '/api/v1/vault/keys/unlocks',
    auth: 'session',
    body: VaultAddUnlockMethod,
    response: VaultUnlockMethod,
  }),
  vaultRemoveUnlockMethod: def({
    method: 'DELETE',
    path: '/api/v1/vault/keys/unlocks/:unlockId',
    auth: 'session',
    response: Empty,
  }),
  /** The encrypted settings as stored, read again before a save or before trusting pins. */
  vaultGetSettings: def({
    method: 'GET',
    path: '/api/v1/vault/keys/settings',
    auth: 'session',
    response: VaultStoredSettings,
  }),
  /** Encrypted per-account settings (auto-lock, clipboard, TOFU pins). */
  vaultUpdateSettings: def({
    method: 'PUT',
    path: '/api/v1/vault/keys/settings',
    auth: 'session',
    body: VaultSettingsBlob,
    response: Empty,
  }),
  /** A colleague's public key, to seal a vault key to them. */
  vaultPublicKey: def({
    method: 'GET',
    path: '/api/v1/vault/users/:userId/public-key',
    auth: 'session',
    response: VaultPublicKey,
  }),

  /* --------------------------------- vaults --------------------------------- */

  /** Vaults I hold a key for. */
  vaultList: def({
    method: 'GET',
    path: '/api/v1/vault/vaults',
    auth: 'session',
    response: items(Vault),
  }),
  /** Space vault (design 8.17, space owners and admins) or a missing personal vault; the key is sealed to the creator. */
  vaultCreate: def({
    method: 'POST',
    path: '/api/v1/vault/vaults',
    auth: 'session',
    body: CreateVault,
    response: Vault,
  }),
  vaultGet: def({
    method: 'GET',
    path: '/api/v1/vault/vaults/:vaultId',
    auth: 'session',
    response: Vault,
  }),
  vaultUpdate: def({
    method: 'PATCH',
    path: '/api/v1/vault/vaults/:vaultId',
    auth: 'session',
    body: UpdateVault,
    response: Vault,
  }),
  vaultDelete: def({
    method: 'DELETE',
    path: '/api/v1/vault/vaults/:vaultId',
    auth: 'session',
    response: Empty,
  }),
  vaultMembers: def({
    method: 'GET',
    path: '/api/v1/vault/vaults/:vaultId/members',
    auth: 'session',
    response: items(VaultMember),
  }),
  /** Org members who could get access, with their public keys (design 8.10). */
  vaultCandidates: def({
    method: 'GET',
    path: '/api/v1/vault/vaults/:vaultId/candidates',
    auth: 'session',
    query: VaultCandidatesQuery,
    response: items(VaultCandidate),
  }),
  /** Seals access to one more person; adds them to the space as viewer when needed. */
  vaultGrant: def({
    method: 'POST',
    path: '/api/v1/vault/vaults/:vaultId/members',
    auth: 'session',
    body: GrantVaultAccess,
    response: VaultMember,
  }),
  vaultUpdateMember: def({
    method: 'PATCH',
    path: '/api/v1/vault/vaults/:vaultId/members/:userId',
    auth: 'session',
    body: UpdateVaultMember,
    response: VaultMember,
  }),
  /** Everything a manager's device needs to rotate the vault key. */
  vaultRotationData: def({
    method: 'GET',
    path: '/api/v1/vault/vaults/:vaultId/rotation',
    auth: 'session',
    response: VaultRotationData,
  }),
  /** Key rotation, removing members (the only way to revoke access). */
  vaultRotate: def({
    method: 'POST',
    path: '/api/v1/vault/vaults/:vaultId/rotate',
    auth: 'session',
    body: RotateVault,
    response: Vault,
  }),

  /* --------------------------------- items --------------------------------- */

  /** Every item of the vault, trash included; the client decrypts and searches. */
  vaultItems: def({
    method: 'GET',
    path: '/api/v1/vault/vaults/:vaultId/items',
    auth: 'session',
    query: VaultItemsQuery,
    response: page(VaultItem),
  }),
  vaultCreateItem: def({
    method: 'POST',
    path: '/api/v1/vault/vaults/:vaultId/items',
    auth: 'session',
    body: CreateVaultItem,
    response: VaultItem,
  }),
  vaultEmptyTrash: def({
    method: 'POST',
    path: '/api/v1/vault/vaults/:vaultId/trash/empty',
    auth: 'session',
    response: z.object({ purged: z.number().int() }),
  }),
  vaultGetItem: def({
    method: 'GET',
    path: '/api/v1/vault/items/:itemId',
    auth: 'session',
    response: VaultItem,
  }),
  /** Save: revision must be current + 1 (409 vault_revision_conflict otherwise). */
  vaultUpdateItem: def({
    method: 'PUT',
    path: '/api/v1/vault/items/:itemId',
    auth: 'session',
    body: UpdateVaultItem,
    response: VaultItem,
  }),
  vaultTrashItem: def({
    method: 'DELETE',
    path: '/api/v1/vault/items/:itemId',
    auth: 'session',
    response: VaultItem,
  }),
  vaultRestoreItem: def({
    method: 'POST',
    path: '/api/v1/vault/items/:itemId/restore',
    auth: 'session',
    response: VaultItem,
  }),
  vaultPurgeItem: def({
    method: 'DELETE',
    path: '/api/v1/vault/items/:itemId/purge',
    auth: 'session',
    response: Empty,
  }),
  vaultMoveItem: def({
    method: 'POST',
    path: '/api/v1/vault/items/:itemId/move',
    auth: 'session',
    body: MoveVaultItem,
    response: VaultItem,
  }),
  /** The last 10 revisions before the current one, newest first. */
  vaultItemRevisions: def({
    method: 'GET',
    path: '/api/v1/vault/items/:itemId/revisions',
    auth: 'session',
    response: items(VaultItemRevision),
  }),
  /**
   * Deletes one kept revision for good, the way out when it would stop a rotation ("Yönet" only).
   * Not the current revision: 409 vault_revision_current.
   */
  vaultDeleteItemRevision: def({
    method: 'DELETE',
    path: '/api/v1/vault/items/:itemId/revisions/:revision',
    auth: 'session',
    response: Empty,
  }),
  vaultImport: def({
    method: 'POST',
    path: '/api/v1/vault/import',
    auth: 'session',
    body: VaultImport,
    response: VaultImportResult,
  }),

  /* ------------------------------- attachments ------------------------------- */

  /** Encrypted on the device; presigned multipart PUTs straight to the store. */
  vaultCreateAttachment: def({
    method: 'POST',
    path: '/api/v1/vault/items/:itemId/attachments',
    auth: 'session',
    body: CreateVaultAttachment,
    response: VaultAttachmentUpload,
  }),
  vaultCompleteAttachment: def({
    method: 'POST',
    path: '/api/v1/vault/items/:itemId/attachments/:attachmentId/complete',
    auth: 'session',
    body: CompleteVaultAttachment,
    response: VaultAttachment,
  }),
  vaultAttachmentUrl: def({
    method: 'GET',
    path: '/api/v1/vault/items/:itemId/attachments/:attachmentId/url',
    auth: 'session',
    response: VaultSignedUrl,
  }),
  vaultDeleteAttachment: def({
    method: 'DELETE',
    path: '/api/v1/vault/items/:itemId/attachments/:attachmentId',
    auth: 'session',
    response: Empty,
  }),

  /* -------------------------------- access log -------------------------------- */

  /** "Shown / copied" events reported by the client (design 8.11). */
  vaultReportEvents: def({
    method: 'POST',
    path: '/api/v1/vault/events',
    auth: 'session',
    body: ReportVaultEvents,
    response: Empty,
  }),
  /** Managers see their vaults' log; everyone sees their personal vault and own unlocks. */
  vaultEvents: def({
    method: 'GET',
    path: '/api/v1/vault/events',
    auth: 'session',
    query: VaultEventsQuery,
    response: page(VaultEvent),
  }),

  /* ------------------------- roadmap 20: policy and breach check ------------------------- */

  /** Org vault policy; every vault user reads it, org admins change it. */
  vaultPolicy: def({
    method: 'GET',
    path: '/api/v1/vault/policy',
    auth: 'session',
    response: VaultPolicy,
  }),
  vaultUpdatePolicy: def({
    method: 'PUT',
    path: '/api/v1/vault/policy',
    auth: 'session',
    body: UpdateVaultPolicy,
    response: VaultPolicy,
  }),
  /**
   * Leaked password check relay: the device sends the first five hex digits of the SHA-1 of a
   * password (upper case) and matches the suffix locally. 403 vault_breach_disabled when off.
   */
  vaultBreachRange: def({
    method: 'GET',
    path: '/api/v1/vault/breach/range/:prefix',
    auth: 'session',
    response: VaultBreachRange,
  }),

  /* ------------------------------ roadmap 20: share links ------------------------------ */

  /** One-time link for someone outside; returns the token once. */
  vaultCreateShare: def({
    method: 'POST',
    path: '/api/v1/vault/items/:itemId/shares',
    auth: 'session',
    body: CreateVaultShare,
    response: VaultShare,
  }),
  /** Live links I created, plus every live link of the vaults I manage. */
  vaultShares: def({
    method: 'GET',
    path: '/api/v1/vault/shares',
    auth: 'session',
    query: VaultSharesQuery,
    response: items(VaultShare),
  }),
  vaultRevokeShare: def({
    method: 'DELETE',
    path: '/api/v1/vault/shares/:shareId',
    auth: 'session',
    response: Empty,
  }),
  /** Public: limits of a link without opening it (link previews do not use it up). */
  vaultPublicShare: def({
    method: 'GET',
    path: '/api/v1/public/vault/shares/:token',
    auth: 'public',
    response: PublicVaultShare,
  }),
  /** Public: counts one open and returns the ciphertext; deleted after the last open. */
  vaultOpenShare: def({
    method: 'POST',
    path: '/api/v1/public/vault/shares/:token/open',
    auth: 'public',
    response: OpenedVaultShare,
  }),
} as const satisfies Record<string, EndpointDef>;
