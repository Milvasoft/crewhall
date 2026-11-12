import { eq } from 'drizzle-orm';
import { vaultPolicies, type DbOrTx } from '@crewhall/db';
import {
  VAULT_SHARE_MAX_HOURS,
  VAULT_SHARE_MAX_VIEWS,
  type UpdateVaultPolicy,
  type VaultPolicy,
} from '@crewhall/shared';
import { AppError } from '../../http/errors';
import { auditVault, logEvent, type VaultActor } from './common';

/**
 * Org vault policy (roadmap 20): the leaked password check (on/off, range API mirror) and
 * share links (on/off, upper limits). No row = defaults; org admins change it.
 */

export type StoredPolicy = Omit<VaultPolicy, 'canEdit'>;

export const DEFAULT_POLICY: StoredPolicy = {
  breachCheck: true,
  breachRangeUrl: null,
  shareLinks: true,
  shareMaxHours: VAULT_SHARE_MAX_HOURS,
  shareMaxViews: VAULT_SHARE_MAX_VIEWS,
};

export async function getPolicy(db: DbOrTx, orgId: string): Promise<StoredPolicy> {
  const [row] = await db.select().from(vaultPolicies).where(eq(vaultPolicies.orgId, orgId));
  if (!row) return DEFAULT_POLICY;
  return {
    breachCheck: row.breachCheck,
    breachRangeUrl: row.breachRangeUrl,
    shareLinks: row.shareLinks,
    shareMaxHours: row.shareMaxHours,
    shareMaxViews: row.shareMaxViews,
  };
}

export async function updatePolicy(
  db: DbOrTx,
  a: VaultActor,
  canEdit: boolean,
  input: UpdateVaultPolicy,
): Promise<VaultPolicy> {
  if (!canEdit) throw new AppError('forbidden', { action: 'org.update_settings' });
  const next: StoredPolicy = { ...(await getPolicy(db, a.org.id)) };
  for (const key of Object.keys(input) as (keyof UpdateVaultPolicy)[]) {
    if (input[key] !== undefined) Object.assign(next, { [key]: input[key] });
  }
  const values = { ...next, updatedBy: a.userId };
  await db
    .insert(vaultPolicies)
    .values({ orgId: a.org.id, ...values })
    .onConflictDoUpdate({ target: vaultPolicies.orgId, set: { ...values, updatedAt: new Date() } });
  // The URL is configuration, not a secret, but only whether it is set goes to the logs.
  const meta = { ...next, breachRangeUrl: next.breachRangeUrl ? 'custom' : null };
  await logEvent(db, a, { action: 'policy.update', meta });
  await auditVault(db, a, 'vault.policy_update', { type: 'user', id: a.userId }, meta);
  return { ...next, canEdit };
}
