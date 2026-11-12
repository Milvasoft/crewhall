import { MODULE_OF_ENDPOINT } from '@crewhall/shared';
import type { DbOrTx } from '@crewhall/db';
import { AppError } from '../../http/errors';
import type { AuthSession, MemberRow, OrgRow } from '../../http/types';
import { primaryOrg } from '../brand';
import { DEMO_BLOCKED_ENDPOINTS, isDemoMode } from '../demo-flag';
import { resolveActiveOrg } from '../membership';
import { ipInRanges, isAdminArea } from './ip';
import { disabledModuleOf, SHARED_MODULE_ENDPOINTS } from './modules';
import { securityPolicy } from './policy';

/**
 * Org-wide checks the router runs before every handler (moduller.md "Platform", design 9.11):
 * a switched-off module answers 403 module_disabled, the IP allow list 403 ip_not_allowed.
 */
export async function checkOrgRequest(
  db: DbOrTx,
  input: {
    endpoint: string;
    method: string;
    path: string;
    org: OrgRow;
    member?: MemberRow | null;
    ip: string | null;
  },
) {
  if (isDemoMode() && DEMO_BLOCKED_ENDPOINTS.has(input.endpoint)) {
    throw new AppError('forbidden', { reason: 'demo' });
  }
  const module = disabledModuleOf(input.endpoint, input.org.settings);
  if (module) throw new AppError('module_disabled', { module });
  await checkIpAllowlist(db, input.org.id, input.method, input.path, input.ip);
}

export async function checkIpAllowlist(
  db: DbOrTx,
  orgId: string,
  method: string,
  path: string,
  ip: string | null,
) {
  const { ipAllowlist } = await securityPolicy(db, orgId);
  if (!ipAllowlist.enabled) return;
  if (ipAllowlist.scope === 'admin' && !isAdminArea(method, path)) return;
  // Requests without an address are in-process (tests, scripts), never from the network.
  if (ip === null) return;
  if (!ipInRanges(ip, ipAllowlist.ranges)) throw new AppError('ip_not_allowed');
}

/** Session endpoints without an org scope (e.g. Hesabım › MCP): the active org's switches. */
export async function checkUserRequest(
  db: DbOrTx,
  input: {
    endpoint: string;
    method: string;
    path: string;
    userId: string;
    session: AuthSession;
    ip: string | null;
  },
) {
  if (!MODULE_OF_ENDPOINT[input.endpoint] || SHARED_MODULE_ENDPOINTS.has(input.endpoint)) return;
  const active = await resolveActiveOrg(db, input.userId, input.session);
  if (!active) return;
  await checkOrgRequest(db, { ...input, org: active.org, member: active.member });
}

/** Public module endpoints (portal site, meeting lobby): the installation's org. */
export async function checkPublicRequest(db: DbOrTx, endpoint: string) {
  if (!MODULE_OF_ENDPOINT[endpoint]) return;
  const org = await primaryOrg(db);
  if (!org) return;
  const module = disabledModuleOf(endpoint, org.settings);
  if (module) throw new AppError('module_disabled', { module });
}
