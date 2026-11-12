import { eq } from 'drizzle-orm';
import { officeSettings, type DbOrTx } from '@crewhall/db';
import {
  OFFICE_EXTENSIONS,
  OfficeTestResult,
  type OfficeCapabilities,
  type OfficeSettings,
  type UpdateOfficeSettings,
} from '@crewhall/shared';
import type { Deps } from '../../deps';
import { AppError } from '../../http/errors';
import type { RequestInfo } from '../../http/types';
import { audit } from '../audit';
import { moduleOn } from '../mcp/policy';
import { capabilitiesOf, clearDiscovery, getDiscovery, type Discovery } from './discovery';
import { openOfficeSecret, sealOfficeSecret } from './secret';

export type OfficeRow = typeof officeSettings.$inferSelect;

export async function loadOfficeSettings(db: DbOrTx, orgId: string): Promise<OfficeRow | null> {
  const [row] = await db.select().from(officeSettings).where(eq(officeSettings.orgId, orgId));
  return row ?? null;
}

export function toOfficeSettingsView(row: OfficeRow | null): OfficeSettings {
  const lastTest = row?.lastTest ? OfficeTestResult.safeParse(row.lastTest) : null;
  return {
    enabled: row?.enabled ?? false,
    serverType: row?.serverType ?? 'onlyoffice',
    serverUrl: row?.serverUrl ?? null,
    internalUrl: row?.internalUrl ?? null,
    jwtSecret: {
      set: !!row?.jwtSecretEnc,
      hint: row?.jwtSecretEnc ? (row.jwtSecretHint ?? null) : null,
    },
    lastTest: lastTest?.success ? lastTest.data : null,
    updatedAt: row?.updatedAt.toISOString() ?? null,
  };
}

export async function updateOfficeSettings(
  deps: Pick<Deps, 'db' | 'env'>,
  a: { orgId: string; userId: string },
  input: UpdateOfficeSettings,
  req: RequestInfo,
) {
  const { db } = deps;
  const before = await loadOfficeSettings(db, a.orgId);
  const values = {
    enabled: input.enabled ?? before?.enabled ?? false,
    serverType: input.serverType ?? before?.serverType ?? 'onlyoffice',
    serverUrl: input.serverUrl !== undefined ? input.serverUrl : (before?.serverUrl ?? null),
    internalUrl:
      input.internalUrl !== undefined ? input.internalUrl : (before?.internalUrl ?? null),
  };
  const secret =
    input.jwtSecret === undefined
      ? { jwtSecretEnc: before?.jwtSecretEnc ?? null, jwtSecretHint: before?.jwtSecretHint ?? null }
      : input.jwtSecret === null
        ? { jwtSecretEnc: null, jwtSecretHint: null }
        : {
            jwtSecretEnc: sealOfficeSecret(deps.env.AUTH_SECRET, a.orgId, input.jwtSecret),
            jwtSecretHint: input.jwtSecret.slice(-4),
          };
  const missing = !values.serverUrl
    ? 'serverUrl'
    : values.serverType === 'onlyoffice' && !secret.jwtSecretEnc
      ? 'jwtSecret'
      : null;
  if (values.enabled && missing) {
    throw new AppError('validation_failed', {
      in: 'body',
      issues: [{ path: [missing], code: 'custom', message: 'required when enabled' }],
    });
  }
  const changed = [
    ...(Object.keys(values) as (keyof typeof values)[]).filter(
      (k) =>
        values[k] !==
        (before?.[k] ?? (k === 'enabled' ? false : k === 'serverType' ? 'onlyoffice' : null)),
    ),
    ...(input.jwtSecret !== undefined ? ['jwtSecret'] : []),
  ];
  const [row] = await db
    .insert(officeSettings)
    .values({ orgId: a.orgId, ...values, ...secret, updatedBy: a.userId })
    .onConflictDoUpdate({
      target: officeSettings.orgId,
      set: { ...values, ...secret, updatedBy: a.userId, updatedAt: new Date() },
    })
    .returning();
  if (changed.some((k) => k === 'serverUrl' || k === 'internalUrl' || k === 'serverType')) {
    clearDiscovery();
  }
  if (changed.length) {
    await audit(
      db,
      {
        orgId: a.orgId,
        actorId: a.userId,
        action: 'office.settings.update',
        targetType: 'org',
        targetId: a.orgId,
        // Field names only; the secret never reaches the log.
        meta: { changed },
      },
      req,
    );
  }
  return toOfficeSettingsView(row ?? null);
}

/** Where the Crewhall server reaches the document server: the internal address when there is one. */
export const serverBase = (row: Pick<OfficeRow, 'serverUrl' | 'internalUrl'>) =>
  row.internalUrl ?? row.serverUrl;

/** Document Server API servers answer `true` on /healthcheck when they can take documents. */
async function healthcheck(base: string) {
  const res = await fetch(`${base}/healthcheck`, { signal: AbortSignal.timeout(8000) });
  const text = (await res.text()).trim();
  if (!res.ok || text !== 'true')
    throw new Error(`healthcheck answered HTTP ${res.status} ${text.slice(0, 80)}`);
}

/** Checks the server now (no cache) and keeps the result for the settings screen. */
export async function testOfficeSettings(db: DbOrTx, orgId: string) {
  const row = await loadOfficeSettings(db, orgId);
  const base = row ? serverBase(row) : null;
  const checkedAt = new Date().toISOString();
  let result: OfficeTestResult;
  if (!row || !base) {
    result = { ok: false, error: 'no_server_url', edit: [], view: [], checkedAt };
  } else {
    try {
      if (row.serverType === 'onlyoffice') {
        await healthcheck(base);
        result = { ok: true, error: null, edit: [...OFFICE_EXTENSIONS], view: [], checkedAt };
      } else {
        const caps = capabilitiesOf(await getDiscovery(base, { fresh: true }));
        result = { ok: true, error: null, ...caps, checkedAt };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result = { ok: false, error: message.slice(0, 300), edit: [], view: [], checkedAt };
    }
  }
  await db
    .insert(officeSettings)
    .values({ orgId, lastTest: result })
    .onConflictDoUpdate({ target: officeSettings.orgId, set: { lastTest: result } });
  return result;
}

export type OfficeConfig =
  | { kind: 'onlyoffice'; row: OfficeRow; jwtSecret: string }
  | { kind: 'wopi'; row: OfficeRow; discovery: Discovery };

/**
 * The org's working office setup, or 503 office_unavailable: module switched off, not enabled,
 * no address, no readable secret, or a WOPI server whose discovery cannot be read.
 */
export async function requireOffice(
  deps: Pick<Deps, 'db' | 'env'>,
  org: { id: string; settings: object },
): Promise<OfficeConfig> {
  if (!moduleOn(org, 'office')) throw new AppError('module_disabled', { module: 'office' });
  const row = await loadOfficeSettings(deps.db, org.id);
  const base = row?.enabled ? serverBase(row) : null;
  if (!row || !base) throw new AppError('office_unavailable', { reason: 'not_configured' });
  if (row.serverType === 'onlyoffice') {
    const jwtSecret = openOfficeSecret(deps.env.AUTH_SECRET, org.id, row.jwtSecretEnc);
    // AUTH_SECRET changed since the secret was saved: the admin has to enter it again.
    if (!jwtSecret) throw new AppError('office_unavailable', { reason: 'secret_unreadable' });
    return { kind: 'onlyoffice', row, jwtSecret };
  }
  try {
    return { kind: 'wopi', row, discovery: await getDiscovery(base) };
  } catch {
    throw new AppError('office_unavailable', { reason: 'server_unreachable' });
  }
}

/** For clients: never fails, just says what is possible. */
export async function officeCapabilities(
  deps: Pick<Deps, 'db' | 'env'>,
  org: { id: string; settings: object },
): Promise<OfficeCapabilities> {
  try {
    const cfg = await requireOffice(deps, org);
    if (cfg.kind === 'onlyoffice') {
      // Without discovery: the last test says whether the server answered.
      const ok = OfficeTestResult.safeParse(cfg.row.lastTest);
      if (ok.success && !ok.data.ok) return { available: false, edit: [], view: [] };
      return { available: true, edit: [...OFFICE_EXTENSIONS], view: [] };
    }
    return { available: true, ...capabilitiesOf(cfg.discovery) };
  } catch {
    return { available: false, edit: [], view: [] };
  }
}
