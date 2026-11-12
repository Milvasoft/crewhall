import { type SecurityPolicy, type UpdateSecurityPolicy } from '@crewhall/shared';

/** Security policy draft helpers (9.11): change count for the save bar and the PATCH body. */

type Section = keyof SecurityPolicy;
const SECTIONS: Section[] = ['twoFactor', 'password', 'session', 'ipAllowlist'];

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function changedFields<S extends Section>(base: SecurityPolicy, draft: SecurityPolicy, section: S) {
  const b = base[section] as Record<string, unknown>;
  const d = draft[section] as Record<string, unknown>;
  return Object.keys(d).filter((k) => !same(b[k], d[k]));
}

/** Number of changed settings; the IP range list counts as one. */
export function countPolicyChanges(base: SecurityPolicy, draft: SecurityPolicy): number {
  return SECTIONS.reduce((n, s) => n + changedFields(base, draft, s).length, 0);
}

/** Only the changed fields, grouped by section (UpdateSecurityPolicy is partial per section). */
export function policyPatch(base: SecurityPolicy, draft: SecurityPolicy): UpdateSecurityPolicy {
  const patch: Record<string, Record<string, unknown>> = {};
  for (const s of SECTIONS) {
    const keys = changedFields(base, draft, s);
    if (keys.length === 0) continue;
    const d = draft[s] as Record<string, unknown>;
    patch[s] = Object.fromEntries(keys.map((k) => [k, d[k]]));
  }
  return patch as UpdateSecurityPolicy;
}

/** "Kapalı / Yönetim alanı / Tüm girişler" segmented value of the IP allowlist. */
export type IpMode = 'off' | SecurityPolicy['ipAllowlist']['scope'];

export function ipMode(p: SecurityPolicy['ipAllowlist']): IpMode {
  return p.enabled ? p.scope : 'off';
}

export function withIpMode(
  p: SecurityPolicy['ipAllowlist'],
  mode: IpMode,
): SecurityPolicy['ipAllowlist'] {
  return mode === 'off' ? { ...p, enabled: false } : { ...p, enabled: true, scope: mode };
}
