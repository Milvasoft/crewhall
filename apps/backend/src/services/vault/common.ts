import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  auditLogs,
  orgMembers,
  spaceMembers,
  spaces,
  users,
  vaultEvents,
  vaultMembers,
  vaultVaults,
  type DbOrTx,
} from '@crewhall/db';
import {
  canVault,
  type SpaceRole,
  type UserSummary,
  type Vault,
  type VaultAction,
  type VaultEventAction,
  type VaultRole,
} from '@crewhall/shared';
import { AppError } from '../../http/errors';
import type { OrgRow, RequestInfo } from '../../http/types';

/**
 * Shared pieces of the vault services. The server never decrypts anything: it moves base64
 * ciphertext in and out of bytea columns, checks verifier hashes and enforces permissions.
 */

export interface VaultActor {
  org: OrgRow;
  userId: string;
  req: RequestInfo;
}

export type VaultRow = typeof vaultVaults.$inferSelect;
export type VaultMemberRow = typeof vaultMembers.$inferSelect;

export const toBytes = (b64: string) => Buffer.from(b64, 'base64');
export const toB64 = (buf: Buffer | Uint8Array) => Buffer.from(buf).toString('base64');
export const iso = (d: Date) => d.toISOString();
export const isoOrNull = (d: Date | null) => (d ? d.toISOString() : null);

export const sha256 = (data: Buffer) => createHash('sha256').update(data).digest();

/** Constant-time check of a client verifier against the stored SHA-256. */
export function verifierMatches(verifierB64: string, storedHash: Buffer): boolean {
  const hash = sha256(toBytes(verifierB64));
  return hash.length === storedHash.length && timingSafeEqual(hash, storedHash);
}

type UserRow = typeof users.$inferSelect;
export const summary = (u: Pick<UserRow, 'id' | 'name' | 'email' | 'image'>): UserSummary => ({
  id: u.id,
  name: u.name,
  email: u.email,
  imageUrl: u.image,
});

/** id → UserSummary for a batch of user ids (nulls skipped). */
export async function userSummaries(db: DbOrTx, ids: (string | null | undefined)[]) {
  const unique = [...new Set(ids.filter((i): i is string => !!i))];
  const map = new Map<string, UserSummary>();
  if (!unique.length) return map;
  const rows = await db
    .select({ id: users.id, name: users.name, email: users.email, image: users.image })
    .from(users)
    .where(inArray(users.id, unique));
  for (const r of rows) map.set(r.id, summary(r));
  return map;
}

/* ---------------------------------- access ---------------------------------- */

export interface VaultAccess {
  vault: VaultRow;
  member: VaultMemberRow;
  spaceRole: SpaceRole | null;
}

/** Guests have no vault (doc 17 §5 "Misafir … kişisel space'i ve kasası yoktur"). */
export function assertVaultUser(orgRole: string) {
  if (orgRole === 'guest') throw new AppError('forbidden', { reason: 'guest' });
}

/**
 * My access to a vault. Without my own vault_members row the vault does not exist for me
 * (404), whatever my org or space role: nobody else can open a personal vault, and org
 * admins never see vault content implicitly (doc 17 §5).
 */
/** Space vaults of a space in the trash (deleted, restorable for 30 days) are out of reach. */
const spaceLive = sql`(${vaultVaults.spaceId} is null or not exists (select 1 from spaces s where s.id = ${vaultVaults.spaceId} and s.deleted_at is not null))`;

export async function vaultAccess(
  db: DbOrTx,
  a: VaultActor,
  vaultId: string,
  opts: { forUpdate?: boolean } = {},
): Promise<VaultAccess> {
  const q = db
    .select({ vault: vaultVaults, member: vaultMembers, spaceRole: spaceMembers.role })
    .from(vaultVaults)
    .innerJoin(
      vaultMembers,
      and(eq(vaultMembers.vaultId, vaultVaults.id), eq(vaultMembers.userId, a.userId)),
    )
    .leftJoin(
      spaceMembers,
      and(eq(spaceMembers.spaceId, vaultVaults.spaceId), eq(spaceMembers.userId, a.userId)),
    )
    .where(and(eq(vaultVaults.id, vaultId), eq(vaultVaults.orgId, a.org.id), spaceLive));
  const [row] = opts.forUpdate ? await q.for('update', { of: vaultVaults }) : await q;
  if (!row) throw new AppError('not_found');
  return { vault: row.vault, member: row.member, spaceRole: row.spaceRole };
}

export function can(access: VaultAccess, action: VaultAction) {
  return canVault(
    { kind: access.vault.kind, vaultRole: access.member.role, spaceRole: access.spaceRole },
    action,
  );
}

export function requireVault(access: VaultAccess, action: VaultAction) {
  if (!can(access, action)) throw new AppError('forbidden', { action });
}

export async function bumpVault(db: DbOrTx, vaultId: string) {
  await db
    .update(vaultVaults)
    .set({ revision: sql`${vaultVaults.revision} + 1`, updatedAt: new Date() })
    .where(eq(vaultVaults.id, vaultId));
}

/* ---------------------------------- serialization ---------------------------------- */

const count = (q: ReturnType<typeof sql>) => sql<number>`(${q})`;

/** Correlated counts per vault (single-table selects are unqualified in Drizzle: name it). */
const itemCount = count(
  sql`select count(*)::int from vault_items i where i.vault_id = "vault_vaults"."id" and i.deleted_at is null`,
);
const trashCount = count(
  sql`select count(*)::int from vault_items i where i.vault_id = "vault_vaults"."id" and i.deleted_at is not null`,
);
const memberCount = count(
  sql`select count(*)::int from vault_members m where m.vault_id = "vault_vaults"."id"`,
);
/** Members who left the space or the org but still hold the key (design 8.10). */
const staleCount = count(sql`select count(*)::int from vault_members m
  where m.vault_id = "vault_vaults"."id" and "vault_vaults"."kind" = 'space' and (
    not exists (select 1 from space_members sm where sm.space_id = "vault_vaults"."space_id" and sm.user_id = m.user_id)
    or not exists (select 1 from org_members om where om.org_id = "vault_vaults"."org_id" and om.user_id = m.user_id and om.status = 'active')
  )`);

export async function loadVaults(db: DbOrTx, a: VaultActor, vaultIds?: string[]): Promise<Vault[]> {
  const rows = await db
    .select({
      vault: vaultVaults,
      member: vaultMembers,
      spaceRole: spaceMembers.role,
      space: { id: spaces.id, name: spaces.name, slug: spaces.slug, color: spaces.color },
      itemCount,
      trashCount,
      memberCount,
      staleCount,
    })
    .from(vaultVaults)
    .innerJoin(
      vaultMembers,
      and(eq(vaultMembers.vaultId, vaultVaults.id), eq(vaultMembers.userId, a.userId)),
    )
    .leftJoin(spaces, eq(spaces.id, vaultVaults.spaceId))
    .leftJoin(
      spaceMembers,
      and(eq(spaceMembers.spaceId, vaultVaults.spaceId), eq(spaceMembers.userId, a.userId)),
    )
    .where(
      and(
        eq(vaultVaults.orgId, a.org.id),
        vaultIds ? inArray(vaultVaults.id, vaultIds) : undefined,
        spaceLive,
      ),
    )
    // Personal first, then by name (Turkish collation like spaces).
    .orderBy(sql`${vaultVaults.kind} = 'space'`, sql`${vaultVaults.name} collate "tr-x-icu"`);
  const people = await userSummaries(
    db,
    rows.map((r) => r.vault.createdBy),
  );
  return rows.map((r) => {
    const access = { vault: r.vault, member: r.member, spaceRole: r.spaceRole };
    return {
      id: r.vault.id,
      kind: r.vault.kind,
      name: r.vault.name,
      space: r.space?.id ? r.space : null,
      keyVersion: r.vault.keyVersion,
      revision: r.vault.revision,
      myRole: r.member.role,
      myWrappedKey: toB64(r.member.wrappedKey),
      canEdit: can(access, 'vault.edit'),
      canManage: can(access, 'vault.manage_members'),
      itemCount: r.itemCount,
      trashCount: r.trashCount,
      memberCount: r.memberCount,
      staleMemberCount: r.staleCount,
      createdBy: (r.vault.createdBy && people.get(r.vault.createdBy)) || null,
      createdAt: iso(r.vault.createdAt),
    } satisfies Vault;
  });
}

export async function loadVault(db: DbOrTx, a: VaultActor, vaultId: string): Promise<Vault> {
  const [v] = await loadVaults(db, a, [vaultId]);
  if (!v) throw new AppError('not_found');
  return v;
}

/** Active, non-guest org member (who may hold vault keys). */
export async function vaultCapableMember(db: DbOrTx, orgId: string, userId: string) {
  const [row] = await db
    .select({ role: orgMembers.role })
    .from(orgMembers)
    .where(
      and(
        eq(orgMembers.organizationId, orgId),
        eq(orgMembers.userId, userId),
        eq(orgMembers.status, 'active'),
      ),
    );
  return !!row && row.role !== 'guest';
}

export const VAULT_ROLE_RANK: Record<VaultRole, number> = { read: 0, edit: 1, manage: 2 };

/* ---------------------------------- logging ---------------------------------- */

export interface VaultEventEntry {
  action: VaultEventAction;
  vaultId?: string | null;
  itemId?: string | null;
  field?: string | null;
  targetUserId?: string | null;
  meta?: Record<string, unknown>;
}

/** Vault access log (design 8.11): append-only. */
export async function logEvent(db: DbOrTx, a: VaultActor, e: VaultEventEntry) {
  await logEvents(db, a, [e]);
}

export async function logEvents(db: DbOrTx, a: VaultActor, entries: VaultEventEntry[]) {
  if (!entries.length) return;
  const ip = a.req.ip && isIP(a.req.ip) ? a.req.ip : null;
  await db.insert(vaultEvents).values(
    entries.map((e) => ({
      orgId: a.org.id,
      actorId: a.userId,
      action: e.action,
      vaultId: e.vaultId ?? null,
      itemId: e.itemId ?? null,
      field: e.field ?? null,
      targetUserId: e.targetUserId ?? null,
      meta: e.meta ?? {},
      ip,
      userAgent: a.req.userAgent,
    })),
  );
}

/**
 * Management actions also go to the org audit log (doc 17 §4 audit_logs, `vault.*`).
 * Only ids and roles: never names of items, which the server does not know anyway.
 */
export async function auditVault(
  db: DbOrTx,
  a: VaultActor,
  action: `vault.${string}`,
  target: { type: 'vault' | 'user'; id: string },
  meta: Record<string, unknown> = {},
) {
  const ip = a.req.ip && isIP(a.req.ip) ? a.req.ip : null;
  await db.insert(auditLogs).values({
    orgId: a.org.id,
    actorId: a.userId,
    action,
    targetType: target.type === 'vault' ? 'vault' : 'user',
    targetId: target.id,
    meta,
    ip,
    userAgent: a.req.userAgent,
  });
}
