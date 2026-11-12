import { eq } from 'drizzle-orm';
import { mcpPolicies, type DbOrTx } from '@crewhall/db';
import {
  LOCKED_APPROVAL_RULES,
  MCP_REQUIRED_SCOPE,
  MCP_SCOPES,
  type ApprovalRule,
  type McpPolicy,
  type McpScope,
  type ModuleKey,
  type UpdateMcpPolicy,
} from '@crewhall/shared';

export type PolicyRow = typeof mcpPolicies.$inferSelect;

/** Defaults for an org without a policy row (design 18.10). */
export const DEFAULT_POLICY: Omit<McpPolicy, 'updatedAt'> = {
  enabled: true,
  patsEnabled: true,
  guestsAllowed: false,
  clientMode: 'all',
  maxTokenDays: 90,
  allowedScopes: [...MCP_SCOPES],
  approvalRules: [...LOCKED_APPROVAL_RULES],
  requestsPerMinute: 60,
  writesPerMinute: 20,
};

const asScopes = (v: readonly string[]) =>
  v.filter((s): s is McpScope => (MCP_SCOPES as readonly string[]).includes(s));

export function toPolicy(row: PolicyRow | undefined): McpPolicy {
  if (!row) return { ...DEFAULT_POLICY, updatedAt: null };
  return {
    enabled: row.enabled,
    patsEnabled: row.patsEnabled,
    guestsAllowed: row.guestsAllowed,
    clientMode: row.clientMode,
    maxTokenDays: row.maxTokenDays,
    allowedScopes: asScopes(row.allowedScopes),
    approvalRules: [
      ...new Set([...LOCKED_APPROVAL_RULES, ...(row.approvalRules as ApprovalRule[])]),
    ],
    requestsPerMinute: row.requestsPerMinute,
    writesPerMinute: row.writesPerMinute,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function getPolicy(db: DbOrTx, orgId: string): Promise<McpPolicy> {
  const [row] = await db.select().from(mcpPolicies).where(eq(mcpPolicies.orgId, orgId));
  return toPolicy(row);
}

export async function updatePolicy(
  db: DbOrTx,
  orgId: string,
  patch: UpdateMcpPolicy,
): Promise<McpPolicy> {
  const current = await getPolicy(db, orgId);
  const next = { ...current, ...patch };
  // Reading is the floor of every connection; the locked rules cannot be switched off.
  const allowedScopes = [...new Set([MCP_REQUIRED_SCOPE, ...next.allowedScopes])];
  const approvalRules = [...new Set([...LOCKED_APPROVAL_RULES, ...next.approvalRules])];
  const values = {
    orgId,
    enabled: next.enabled,
    patsEnabled: next.patsEnabled,
    guestsAllowed: next.guestsAllowed,
    clientMode: next.clientMode,
    maxTokenDays: next.maxTokenDays,
    allowedScopes,
    approvalRules,
    requestsPerMinute: next.requestsPerMinute,
    writesPerMinute: next.writesPerMinute,
  };
  const [row] = await db
    .insert(mcpPolicies)
    .values(values)
    .onConflictDoUpdate({ target: mcpPolicies.orgId, set: { ...values, updatedAt: new Date() } })
    .returning();
  return toPolicy(row);
}

/** Policy ∩ connection scopes; reading always stays. */
export function effectiveScopes(policy: McpPolicy, scopes: readonly string[]): McpScope[] {
  const granted = asScopes(scopes);
  return granted.filter((s) => s === MCP_REQUIRED_SCOPE || policy.allowedScopes.includes(s));
}

/** OrgSettings.modules: a missing key means on (Yönetim › Genel module switches). */
export function moduleOn(org: { settings: object }, key: ModuleKey) {
  const modules = (org.settings as { modules?: Partial<Record<ModuleKey, boolean>> }).modules;
  return modules?.[key] !== false;
}

/** Days a new connection or token may live; null = open-ended allowed. */
export function maxLifetimeMs(policy: McpPolicy): number | null {
  return policy.maxTokenDays === null ? null : policy.maxTokenDays * 24 * 60 * 60 * 1000;
}
