import type { Deps } from '../../deps';
import type { ProviderRow } from '../identity/providers';
import { loadApp, credentialsOf } from './app';
import { graph } from './graph';
import { expandGroupIds } from './scim';

/**
 * Entra ID specifics of OIDC sign-in (preset `entra`): group overage, group object ids that
 * SCIM knows by name, and conditional access refusals shown as such.
 */

/**
 * Entra puts at most 200 groups in a token; beyond that it sends `_claim_names.groups`
 * (or `hasgroups`) instead. The groups are then read from Graph with the org's app
 * registration (GroupMember.Read.All); without one the person signs in without groups.
 */
export function hasGroupOverage(claims: Record<string, unknown>) {
  const names = claims._claim_names;
  return (
    claims.hasgroups === true ||
    claims.hasgroups === 'true' ||
    (typeof names === 'object' && names !== null && 'groups' in names)
  );
}

export async function overageGroups(
  deps: Pick<Deps, 'db' | 'env' | 'logger'>,
  orgId: string,
  objectId: string,
): Promise<string[]> {
  try {
    const creds = credentialsOf(deps.env, await loadApp(deps.db, orgId));
    const ids: string[] = [];
    let next: string | undefined = `/users/${encodeURIComponent(objectId)}/getMemberObjects`;
    // getMemberObjects answers in one page of ids (up to 11,000); nextLink is followed just in case.
    let first = true;
    while (next) {
      const page: { value?: string[]; '@odata.nextLink'?: string } = first
        ? await graph(creds, next, { method: 'POST', body: { securityEnabledOnly: false } })
        : await graph(creds, next);
      first = false;
      ids.push(...(page.value ?? []));
      next = page['@odata.nextLink'];
    }
    return ids;
  } catch (err) {
    deps.logger.warn({ err, orgId }, 'Entra group overage: groups could not be read from Graph');
    return [];
  }
}

/** The groups the role mappings see for an Entra sign-in. */
export async function entraGroups(
  deps: Pick<Deps, 'db' | 'env' | 'logger'>,
  provider: Pick<ProviderRow, 'id' | 'orgId'>,
  claims: Record<string, unknown>,
  groups: string[],
) {
  let list = groups;
  const oid = typeof claims.oid === 'string' ? claims.oid : null;
  if (!list.length && oid && hasGroupOverage(claims)) {
    list = await overageGroups(deps, provider.orgId, oid);
  }
  return expandGroupIds(deps.db, provider.id, list);
}

/**
 * AADSTS codes of a refusal by the tenant's policies: conditional access (53xxx), MFA required
 * (50076, 50079), user not assigned to the app (50105), device or location rules (530xxx).
 */
const POLICY_CODES = /AADSTS(53\d{3,4}|50076|50079|50105|50158|50097)\b/;

export function policyRefusal(error: string | undefined, description: string | undefined) {
  if (description && POLICY_CODES.test(description)) return true;
  return error === 'interaction_required';
}
