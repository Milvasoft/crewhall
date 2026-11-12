import { eq } from 'drizzle-orm';
import { organizations, type DbOrTx } from '@crewhall/db';
import {
  MODULE_KEYS,
  MODULE_OF_ENDPOINT,
  moduleOn,
  type ModuleKey,
  type OrgSettings,
} from '@crewhall/shared';
import { AppError } from '../../http/errors';
import type { OrgRow, RequestInfo } from '../../http/types';
import { identityAudit } from './audit';

/**
 * Module switches (moduller.md "Platform"): `OrgSettings.modules`, a missing key means on.
 * Endpoints of the contract table are guarded centrally by the router from MODULE_OF_ENDPOINT;
 * other paths (WS events, collab, LiveKit tokens, jobs, notifications) call isModuleEnabled.
 */

export function enabledModules(settings: Pick<OrgSettings, 'modules'> | null | undefined) {
  return MODULE_KEYS.filter((key) => moduleOn(settings, key));
}

/** A missing key means on, except for split modules that follow their parent (MODULE_PARENT). */
export function moduleEnabledIn(
  settings: Pick<OrgSettings, 'modules'> | null | undefined,
  key: ModuleKey,
) {
  return moduleOn(settings, key);
}

const CACHE_MS = 10_000;
const cache = new Map<string, { at: number; settings: OrgSettings | null }>();

/** Called after the org settings change so this process sees the switch at once. */
export function invalidateModules(orgId?: string) {
  if (orgId) cache.delete(orgId);
  else cache.clear();
}

/**
 * For paths outside the contract table. Reads the org row at most every 10 seconds per
 * process (`fresh` always reads it, e.g. in another process than the one that changed it);
 * an unknown org counts as disabled.
 */
export async function isModuleEnabled(
  db: DbOrTx,
  orgId: string,
  key: ModuleKey,
  opts: { fresh?: boolean } = {},
) {
  const hit = opts.fresh ? undefined : cache.get(orgId);
  const settings =
    hit && Date.now() - hit.at < CACHE_MS ? hit.settings : await readSettings(db, orgId);
  return settings !== null && moduleEnabledIn(settings, key);
}

async function readSettings(db: DbOrTx, orgId: string) {
  const [row] = await db
    .select({ settings: organizations.settings })
    .from(organizations)
    .where(eq(organizations.id, orgId));
  const settings = row ? (row.settings as OrgSettings) : null;
  cache.set(orgId, { at: Date.now(), settings });
  return settings;
}

/**
 * Synchronous answer for hot paths (every WS event): the cached value, refreshed in the
 * background when stale; on (true) until the org was read once. Await isModuleEnabled first
 * (e.g. on connect) to prime it.
 */
export function isModuleEnabledCached(db: DbOrTx, orgId: string, key: ModuleKey) {
  const hit = cache.get(orgId);
  if (!hit || Date.now() - hit.at >= CACHE_MS) void readSettings(db, orgId).catch(() => undefined);
  if (!hit) return true;
  return hit.settings !== null && moduleEnabledIn(hit.settings, key);
}

export async function requireModule(db: DbOrTx, orgId: string, key: ModuleKey) {
  if (!(await isModuleEnabled(db, orgId, key)))
    throw new AppError('module_disabled', { module: key });
}

/**
 * Endpoints listed in a module table that serve the whole app: the WebSocket ticket opens the
 * realtime gateway that also carries core events (Drive, quick access); the chat module drops
 * its own events on it while chat is off.
 */
export const SHARED_MODULE_ENDPOINTS: ReadonlySet<string> = new Set(['createWsTicket']);

/** Router guard: the module an endpoint belongs to, if it is switched off in `settings`. */
export function disabledModuleOf(
  endpoint: string,
  settings: Pick<OrgSettings, 'modules'> | null | undefined,
): ModuleKey | null {
  if (SHARED_MODULE_ENDPOINTS.has(endpoint)) return null;
  const key = MODULE_OF_ENDPOINT[endpoint];
  if (!key) return null;
  return moduleEnabledIn(settings, key) ? null : key;
}

/** Audit row with the switches before and after an `updateOrg` that touched them. */
export async function recordModuleChange(
  db: DbOrTx,
  before: Pick<OrgRow, 'id' | 'settings'>,
  after: Pick<OrgRow, 'settings'>,
  actorId: string,
  req: RequestInfo,
) {
  const was = enabledModules(before.settings);
  const now = enabledModules(after.settings);
  if (was.join() === now.join()) return;
  await identityAudit(
    db,
    {
      orgId: before.id,
      actorId,
      action: 'org.modules.update',
      targetType: 'org',
      targetId: before.id,
      meta: {
        enabled: now.filter((m) => !was.includes(m)),
        disabled: was.filter((m) => !now.includes(m)),
        modules: now,
      },
    },
    req,
  );
}
