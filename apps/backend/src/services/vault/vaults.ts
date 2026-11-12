import { and, asc, eq, ilike, inArray, notInArray, or, sql } from 'drizzle-orm';
import {
  orgMembers,
  spaceMembers,
  spaces,
  userKeys,
  users,
  vaultAttachments,
  vaultItemRevisions,
  vaultItems,
  vaultMembers,
  vaultVaults,
  type DbOrTx,
} from '@crewhall/db';
import {
  canCreateSpaceVault,
  type RotateVault,
  type Vault,
  type VaultCandidate,
  type VaultMember,
  type VaultRole,
  type VaultRotationData,
} from '@crewhall/shared';
import type { z } from 'zod';
import type { CreateVault, GrantVaultAccess } from '@crewhall/shared';
import { AppError } from '../../http/errors';
import { audit } from '../audit';
import {
  auditVault,
  bumpVault,
  iso,
  loadVault,
  loadVaults,
  logEvent,
  logEvents,
  requireVault,
  summary,
  toB64,
  toBytes,
  userSummaries,
  vaultAccess,
  vaultCapableMember,
  type VaultActor,
} from './common';
import { releaseAttachments } from './attachments';
import { createPersonalVault, isUniqueViolation, requireKeys } from './keys';
import { toItems } from './items';

/**
 * Vaults, membership and key rotation (design 8.10, 8.17; doc 17 §7 "Üye çıkarma ve anahtar
 * döndürme"). Sharing is sealing the vault key to a person's public key on a manager's device;
 * revoking is a rotation, so the removed person's old key opens nothing new.
 */

export const listVaults = (db: DbOrTx, a: VaultActor) => loadVaults(db, a);

export async function createVault(
  db: DbOrTx,
  a: VaultActor,
  input: z.infer<typeof CreateVault>,
): Promise<Vault> {
  await requireKeys(db, a.userId);
  if (input.spaceId === null) {
    await createPersonalVault(db, a, input);
    return loadVault(db, a, input.id);
  }
  const [space] = await db
    .select({ space: spaces, role: spaceMembers.role })
    .from(spaces)
    .leftJoin(
      spaceMembers,
      and(eq(spaceMembers.spaceId, spaces.id), eq(spaceMembers.userId, a.userId)),
    )
    .where(and(eq(spaces.id, input.spaceId), eq(spaces.orgId, a.org.id)));
  if (!space || space.space.kind !== 'shared') throw new AppError('not_found');
  if (space.space.archivedAt) throw new AppError('forbidden', { reason: 'archived' });
  if (!canCreateSpaceVault(space.role)) throw new AppError('forbidden');
  if (!input.name) throw new AppError('validation_failed', { field: 'name' });
  try {
    await db.insert(vaultVaults).values({
      id: input.id,
      orgId: a.org.id,
      kind: 'space',
      spaceId: input.spaceId,
      name: input.name,
      createdBy: a.userId,
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new AppError('conflict', { reason: 'id_taken' });
    throw err;
  }
  await db.insert(vaultMembers).values({
    vaultId: input.id,
    userId: a.userId,
    orgId: a.org.id,
    role: 'manage',
    wrappedKey: toBytes(input.wrappedKey),
    keyVersion: 1,
    grantedBy: a.userId,
  });
  await logEvent(db, a, { action: 'vault.create', vaultId: input.id, meta: { kind: 'space' } });
  await auditVault(
    db,
    a,
    'vault.create',
    { type: 'vault', id: input.id },
    {
      spaceId: input.spaceId,
    },
  );
  return loadVault(db, a, input.id);
}

export async function getVault(db: DbOrTx, a: VaultActor, vaultId: string) {
  await vaultAccess(db, a, vaultId);
  return loadVault(db, a, vaultId);
}

export async function renameVault(db: DbOrTx, a: VaultActor, vaultId: string, name: string) {
  const access = await vaultAccess(db, a, vaultId);
  if (access.vault.kind !== 'space') throw new AppError('forbidden', { reason: 'personal' });
  requireVault(access, 'vault.rename');
  await db.update(vaultVaults).set({ name }).where(eq(vaultVaults.id, vaultId));
  await bumpVault(db, vaultId);
  await logEvent(db, a, { action: 'vault.update', vaultId });
  return loadVault(db, a, vaultId);
}

export async function deleteVault(db: DbOrTx, a: VaultActor, vaultId: string) {
  const access = await vaultAccess(db, a, vaultId, { forUpdate: true });
  requireVault(access, 'vault.delete');
  const atts = await db
    .select()
    .from(vaultAttachments)
    .where(eq(vaultAttachments.vaultId, vaultId));
  await releaseAttachments(db, atts);
  await db.delete(vaultVaults).where(eq(vaultVaults.id, vaultId));
  await logEvent(db, a, { action: 'vault.delete', vaultId });
  await auditVault(db, a, 'vault.delete', { type: 'vault', id: vaultId });
}

/* ---------------------------------- members ---------------------------------- */

async function memberRows(db: DbOrTx, vaultId: string, spaceId: string | null, userIds?: string[]) {
  return db
    .select({
      m: vaultMembers,
      u: users,
      spaceRole: spaceMembers.role,
      publicKey: userKeys.publicKey,
      fingerprint: userKeys.fingerprint,
    })
    .from(vaultMembers)
    .innerJoin(users, eq(users.id, vaultMembers.userId))
    .innerJoin(userKeys, eq(userKeys.userId, vaultMembers.userId))
    .leftJoin(
      spaceMembers,
      and(
        eq(spaceMembers.userId, vaultMembers.userId),
        spaceId ? eq(spaceMembers.spaceId, spaceId) : sql`false`,
      ),
    )
    .where(
      and(
        eq(vaultMembers.vaultId, vaultId),
        userIds ? inArray(vaultMembers.userId, userIds) : undefined,
      ),
    )
    .orderBy(
      sql`array_position(array['manage','edit','read']::vault_role[], ${vaultMembers.role})`,
      asc(users.name),
    );
}

async function toMembers(
  db: DbOrTx,
  rows: Awaited<ReturnType<typeof memberRows>>,
  kind: 'personal' | 'space',
): Promise<VaultMember[]> {
  const granters = await userSummaries(
    db,
    rows.map((r) => r.m.grantedBy),
  );
  return rows.map((r) => ({
    user: summary(r.u),
    role: r.m.role,
    // A personal vault's owner has no space role; treat the owner as in place.
    spaceRole: kind === 'personal' ? 'owner' : r.spaceRole,
    publicKey: toB64(r.publicKey),
    fingerprint: r.fingerprint,
    grantedBy: (r.m.grantedBy && granters.get(r.m.grantedBy)) || null,
    grantedAt: iso(r.m.createdAt),
  }));
}

export async function listMembers(db: DbOrTx, a: VaultActor, vaultId: string) {
  const access = await vaultAccess(db, a, vaultId);
  return toMembers(db, await memberRows(db, vaultId, access.vault.spaceId), access.vault.kind);
}

/** Org members who could get access, with their public keys (design 8.10 "Erişim ver"). */
export async function listCandidates(
  db: DbOrTx,
  a: VaultActor,
  vaultId: string,
  q: string | undefined,
): Promise<VaultCandidate[]> {
  const access = await vaultAccess(db, a, vaultId);
  if (access.vault.kind !== 'space') throw new AppError('vault_personal_not_shareable');
  requireVault(access, 'vault.manage_members');
  const existing = await db
    .select({ id: vaultMembers.userId })
    .from(vaultMembers)
    .where(eq(vaultMembers.vaultId, vaultId));
  const term = q?.trim();
  const rows = await db
    .select({
      u: users,
      spaceRole: spaceMembers.role,
      publicKey: userKeys.publicKey,
      fingerprint: userKeys.fingerprint,
    })
    .from(orgMembers)
    .innerJoin(users, eq(users.id, orgMembers.userId))
    .leftJoin(userKeys, eq(userKeys.userId, orgMembers.userId))
    .leftJoin(
      spaceMembers,
      and(
        eq(spaceMembers.userId, orgMembers.userId),
        eq(spaceMembers.spaceId, access.vault.spaceId!),
      ),
    )
    .where(
      and(
        eq(orgMembers.organizationId, a.org.id),
        eq(orgMembers.status, 'active'),
        sql`${orgMembers.role} <> 'guest'`,
        existing.length
          ? notInArray(
              orgMembers.userId,
              existing.map((e) => e.id),
            )
          : undefined,
        term
          ? or(
              ilike(users.name, `%${escapeLike(term)}%`),
              ilike(users.email, `%${escapeLike(term)}%`),
            )
          : undefined,
      ),
    )
    .orderBy(sql`${spaceMembers.role} is null`, asc(users.name))
    .limit(50);
  return rows.map((r) => ({
    user: summary(r.u),
    spaceRole: r.spaceRole,
    publicKey: r.publicKey ? toB64(r.publicKey) : null,
    fingerprint: r.fingerprint,
  }));
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Grants access with a vault key sealed on the manager's device (design 8.10). A person
 * outside the space joins it as viewer, as the design says.
 */
export async function grantAccess(
  db: DbOrTx,
  a: VaultActor,
  vaultId: string,
  input: z.infer<typeof GrantVaultAccess>,
) {
  const access = await vaultAccess(db, a, vaultId, { forUpdate: true });
  if (access.vault.kind !== 'space') throw new AppError('vault_personal_not_shareable');
  requireVault(access, 'vault.manage_members');
  if (input.keyVersion !== access.vault.keyVersion) {
    throw new AppError('vault_key_version_mismatch', { keyVersion: access.vault.keyVersion });
  }
  if (!(await vaultCapableMember(db, a.org.id, input.userId))) throw new AppError('not_found');
  const [keys] = await db
    .select({ userId: userKeys.userId })
    .from(userKeys)
    .where(eq(userKeys.userId, input.userId));
  if (!keys) throw new AppError('vault_member_without_keys');

  const spaceId = access.vault.spaceId!;
  const [inSpace] = await db
    .select({ role: spaceMembers.role })
    .from(spaceMembers)
    .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, input.userId)));
  if (!inSpace) {
    await db.insert(spaceMembers).values({
      spaceId,
      userId: input.userId,
      orgId: a.org.id,
      role: 'viewer',
      addedBy: a.userId,
    });
    await audit(
      db,
      {
        orgId: a.org.id,
        actorId: a.userId,
        action: 'space.member.add',
        targetType: 'space',
        targetId: spaceId,
        meta: { userId: input.userId, role: 'viewer', via: 'vault' },
      },
      a.req,
    );
  }
  try {
    await db.insert(vaultMembers).values({
      vaultId,
      userId: input.userId,
      orgId: a.org.id,
      role: input.role,
      wrappedKey: toBytes(input.wrappedKey),
      keyVersion: input.keyVersion,
      grantedBy: a.userId,
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new AppError('conflict', { reason: 'already_member' });
    throw err;
  }
  await bumpVault(db, vaultId);
  await logEvent(db, a, {
    action: 'member.grant',
    vaultId,
    targetUserId: input.userId,
    field: input.role,
  });
  await auditVault(
    db,
    a,
    'vault.member.grant',
    { type: 'vault', id: vaultId },
    {
      userId: input.userId,
      role: input.role,
    },
  );
  const [m] = await toMembers(db, await memberRows(db, vaultId, spaceId, [input.userId]), 'space');
  return m!;
}

async function assertManagerRemains(
  db: DbOrTx,
  vaultId: string,
  without: string[],
  changed?: { userId: string; role: VaultRole },
) {
  const rows = await db
    .select({ userId: vaultMembers.userId, role: vaultMembers.role })
    .from(vaultMembers)
    .where(eq(vaultMembers.vaultId, vaultId));
  const managers = rows
    .filter((r) => !without.includes(r.userId))
    .map((r) => (changed && r.userId === changed.userId ? { ...r, role: changed.role } : r))
    .filter((r) => r.role === 'manage');
  if (!managers.length) throw new AppError('vault_last_manager');
}

export async function updateMemberRole(
  db: DbOrTx,
  a: VaultActor,
  vaultId: string,
  userId: string,
  role: VaultRole,
) {
  const access = await vaultAccess(db, a, vaultId, { forUpdate: true });
  if (access.vault.kind !== 'space') throw new AppError('vault_personal_not_shareable');
  requireVault(access, 'vault.manage_members');
  await assertManagerRemains(db, vaultId, [], { userId, role });
  const updated = await db
    .update(vaultMembers)
    .set({ role })
    .where(and(eq(vaultMembers.vaultId, vaultId), eq(vaultMembers.userId, userId)))
    .returning({ userId: vaultMembers.userId });
  if (!updated.length) throw new AppError('member_not_found');
  await bumpVault(db, vaultId);
  await logEvent(db, a, { action: 'member.role', vaultId, targetUserId: userId, field: role });
  await auditVault(db, a, 'vault.member.role', { type: 'vault', id: vaultId }, { userId, role });
  const [m] = await toMembers(
    db,
    await memberRows(db, vaultId, access.vault.spaceId, [userId]),
    'space',
  );
  return m!;
}

/* ---------------------------------- rotation ---------------------------------- */

export async function rotationData(
  db: DbOrTx,
  a: VaultActor,
  vaultId: string,
): Promise<VaultRotationData> {
  const access = await vaultAccess(db, a, vaultId);
  requireRotate(access);
  const items = await db
    .select()
    .from(vaultItems)
    .where(eq(vaultItems.vaultId, vaultId))
    .orderBy(asc(vaultItems.id));
  const revisions = await db
    .select({
      itemId: vaultItemRevisions.itemId,
      revision: vaultItemRevisions.revision,
      keyVersion: vaultItemRevisions.keyVersion,
      itemKeyWrapped: vaultItemRevisions.itemKeyWrapped,
    })
    .from(vaultItemRevisions)
    .where(eq(vaultItemRevisions.vaultId, vaultId));
  return {
    vault: await loadVault(db, a, vaultId),
    members: await toMembers(
      db,
      await memberRows(db, vaultId, access.vault.spaceId),
      access.vault.kind,
    ),
    items: await toItems(db, items),
    revisions: revisions.map((r) => ({ ...r, itemKeyWrapped: toB64(r.itemKeyWrapped) })),
  };
}

function requireRotate(access: Awaited<ReturnType<typeof vaultAccess>>) {
  // A personal vault's owner may rotate (no members to remove); space vaults need managers.
  requireVault(access, access.vault.kind === 'personal' ? 'vault.purge' : 'vault.manage_members');
}

const key = (itemId: string, revision: number) => `${itemId}:${revision}`;

/**
 * Atomic rotation (doc 17 §7): new key version, the vault key sealed again to exactly the
 * remaining members, every item re-encrypted at revision + 1, every kept revision's item key
 * re-wrapped. Anything missing or stale is refused as a whole, so a concurrent edit makes
 * the manager's device simply retry with fresh data.
 */
export async function rotateVault(db: DbOrTx, a: VaultActor, vaultId: string, input: RotateVault) {
  const access = await vaultAccess(db, a, vaultId, { forUpdate: true });
  requireRotate(access);
  const { vault } = access;
  if (input.keyVersion !== vault.keyVersion + 1) {
    throw new AppError('vault_key_version_mismatch', { keyVersion: vault.keyVersion });
  }
  if (vault.kind === 'personal' && input.removeUserIds.length) {
    throw new AppError('vault_personal_not_shareable');
  }

  const members = await db
    .select({ userId: vaultMembers.userId })
    .from(vaultMembers)
    .where(eq(vaultMembers.vaultId, vaultId));
  const current = new Set(members.map((m) => m.userId));
  const removing = new Set(input.removeUserIds);
  // The rotating device makes the new key, so rotating yourself out would not revoke you: you
  // would leave knowing it, and the server cannot tell. Another manager's rotation can.
  if (removing.has(a.userId)) throw new AppError('vault_cannot_remove_self');
  for (const id of removing)
    if (!current.has(id)) throw new AppError('member_not_found', { userId: id });
  await assertManagerRemains(db, vaultId, [...removing]);
  const remaining = [...current].filter((id) => !removing.has(id));
  const sent = new Map(input.members.map((m) => [m.userId, m.wrappedKey]));
  const missingMembers = remaining.filter((id) => !sent.has(id));
  const extraMembers = [...sent.keys()].filter((id) => !remaining.includes(id));

  const items = await db
    .select({ id: vaultItems.id, revision: vaultItems.revision })
    .from(vaultItems)
    .where(eq(vaultItems.vaultId, vaultId))
    .for('update');
  const sentItems = new Map(input.items.map((i) => [i.id, i]));
  const missingItems = items
    .filter((i) => sentItems.get(i.id)?.revision !== i.revision + 1)
    .map((i) => i.id);
  const known = new Set(items.map((i) => i.id));
  const extraItems = input.items.filter((i) => !known.has(i.id)).map((i) => i.id);

  const revisions = await db
    .select({ itemId: vaultItemRevisions.itemId, revision: vaultItemRevisions.revision })
    .from(vaultItemRevisions)
    .where(eq(vaultItemRevisions.vaultId, vaultId));
  const sentRevisions = new Map(input.revisions.map((r) => [key(r.itemId, r.revision), r]));
  const missingRevisions = revisions.filter((r) => !sentRevisions.has(key(r.itemId, r.revision)));

  if (
    missingMembers.length ||
    extraMembers.length ||
    missingItems.length ||
    extraItems.length ||
    missingRevisions.length ||
    sentRevisions.size !== revisions.length
  ) {
    throw new AppError('vault_rotation_incomplete', {
      missingMembers,
      extraMembers,
      missingItems,
      extraItems,
      missingRevisions: missingRevisions.length,
      revisions: missingRevisions.slice(0, 20),
    });
  }

  if (removing.size) {
    await db
      .delete(vaultMembers)
      .where(and(eq(vaultMembers.vaultId, vaultId), inArray(vaultMembers.userId, [...removing])));
  }
  for (const [userId, wrappedKey] of sent) {
    await db
      .update(vaultMembers)
      .set({ wrappedKey: toBytes(wrappedKey), keyVersion: input.keyVersion })
      .where(and(eq(vaultMembers.vaultId, vaultId), eq(vaultMembers.userId, userId)));
  }
  const now = new Date();
  for (const item of input.items) {
    await db
      .update(vaultItems)
      .set({
        ciphertext: toBytes(item.ciphertext),
        nonce: toBytes(item.nonce),
        itemKeyWrapped: toBytes(item.itemKeyWrapped),
        keyVersion: input.keyVersion,
        revision: item.revision,
        updatedAt: now,
      })
      .where(eq(vaultItems.id, item.id));
  }
  for (const r of input.revisions) {
    await db
      .update(vaultItemRevisions)
      .set({ itemKeyWrapped: toBytes(r.itemKeyWrapped), keyVersion: input.keyVersion })
      .where(
        and(eq(vaultItemRevisions.itemId, r.itemId), eq(vaultItemRevisions.revision, r.revision)),
      );
  }
  await db
    .update(vaultVaults)
    .set({
      keyVersion: input.keyVersion,
      revision: sql`${vaultVaults.revision} + 1`,
      updatedAt: now,
    })
    .where(eq(vaultVaults.id, vaultId));

  await logEvents(db, a, [
    {
      action: 'vault.rotate',
      vaultId,
      meta: { keyVersion: input.keyVersion, items: items.length, removed: removing.size },
    },
    ...[...removing].map((userId) => ({
      action: 'member.revoke' as const,
      vaultId,
      targetUserId: userId,
    })),
  ]);
  await auditVault(
    db,
    a,
    'vault.rotate',
    { type: 'vault', id: vaultId },
    {
      keyVersion: input.keyVersion,
      removed: [...removing],
    },
  );
  return loadVault(db, a, vaultId);
}

/** Vault ids I hold a key for in this org (event visibility). */
export async function myVaultIds(db: DbOrTx, a: VaultActor, roles?: VaultRole[]) {
  const rows = await db
    .select({ id: vaultVaults.id })
    .from(vaultVaults)
    .innerJoin(
      vaultMembers,
      and(eq(vaultMembers.vaultId, vaultVaults.id), eq(vaultMembers.userId, a.userId)),
    )
    .where(
      and(eq(vaultVaults.orgId, a.org.id), roles ? inArray(vaultMembers.role, roles) : undefined),
    );
  return rows.map((r) => r.id);
}
