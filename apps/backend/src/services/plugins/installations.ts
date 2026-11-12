import { and, asc, eq, inArray } from 'drizzle-orm';
import { pluginInstallations, users, type DbOrTx } from '@crewhall/db';
import {
  compareVersions,
  localize,
  pluginUrl,
  type PluginBrowserCapability,
  type PluginManifest,
} from '@crewhall/plugin-sdk';
import { signRequest, type LifecycleRequest } from '@crewhall/plugin-sdk/server';
import type {
  InstallPlugin,
  PluginCatalogItem,
  PluginInstallation,
  PluginSurface,
  UpgradePlugin,
} from '@crewhall/shared';
import type { Deps } from '../../deps';
import type { Env } from '../../env';
import { AppError } from '../../http/errors';
import type { OrgRow, RequestInfo } from '../../http/types';
import { audit } from '../audit';
import { newSecret, open, seal } from './crypto';
import { BlockedAddressError, outboundFetch } from '../../net/outbound';
import {
  fetchCatalog,
  fetchDetail,
  fetchPackage,
  installationDomain,
  pluginRefOf,
} from './marketplace';
import { selfOriginOf, verifySelfHosted } from './self-hosted';
import { issuerOf } from './tokens';

/**
 * Yönetim › Eklentiler (docs/contracts/eklentiler.md › Kurulum): install a signed version with
 * the admin's approval, upgrade (new permissions wait for approval), turn off, uninstall.
 * The plugin server learns each step through a signed lifecycle request.
 */

export type InstallationRow = typeof pluginInstallations.$inferSelect;
/** The newest catalog version: what an update would ask for. */
type Latest = { version: string; permissions: string[]; browser?: string[] };
/** Manifests stored before API 32 have no `browser`. */
const browserOf = (m: PluginManifest): PluginBrowserCapability[] => m.browser ?? [];

function addedBrowserOf(newer: Latest, m: PluginManifest) {
  const added = (newer.browser ?? []).filter(
    (c): c is PluginBrowserCapability => !(browserOf(m) as string[]).includes(c),
  );
  return added.length ? { addedBrowser: added } : {};
}
const SECRET_PURPOSE = 'plugin-installation-secret';
const TIMEOUT_MS = 10_000;

export const installationSecret = (env: Env, row: InstallationRow) =>
  open(env.AUTH_SECRET, SECRET_PURPOSE, row.secretEnc);

/**
 * A signed POST to a path on the plugin origin; its JSON answer. Anything but 2xx (or no
 * answer in 10 s) is `plugin_unreachable`. A self-hosted copy is an address an admin typed:
 * its requests go through outboundFetch (no private addresses, no redirects).
 */
export async function callPlugin(
  env: Env,
  row: Pick<InstallationRow, 'id' | 'manifest' | 'secretEnc' | 'selfOrigin'>,
  path: string,
  payload: unknown,
  secret = open(env.AUTH_SECRET, SECRET_PURPOSE, row.secretEnc),
): Promise<unknown> {
  const body = JSON.stringify(payload);
  const headers = { ...(await signRequest(secret, row.id, body)), Accept: 'application/json' };
  let res: Response;
  try {
    res = row.selfOrigin
      ? await outboundFetch(pluginUrl(row.manifest, path), {
          method: 'POST',
          headers,
          body,
          redirect: 'manual',
          timeoutMs: TIMEOUT_MS,
        })
      : await fetch(pluginUrl(row.manifest, path), {
          method: 'POST',
          headers,
          body,
          redirect: 'error',
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
  } catch (err) {
    throw new AppError('plugin_unreachable', {
      plugin: row.manifest.id,
      ...(err instanceof BlockedAddressError ? { reason: 'blocked' } : {}),
    });
  }
  if (!res.ok)
    throw new AppError('plugin_unreachable', { plugin: row.manifest.id, status: res.status });
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AppError('plugin_unreachable', { plugin: row.manifest.id, reason: 'json' });
  }
}

function view(
  row: InstallationRow,
  installedBy: { id: string; name: string; email: string; image: string | null } | null,
  latest: Latest | null,
): PluginInstallation {
  const m = row.manifest;
  const r = row.package.review;
  const newer = latest && compareVersions(latest.version, row.version) > 0 ? latest : null;
  return {
    id: row.id,
    pluginId: row.pluginId,
    version: row.version,
    name: m.name,
    description: m.description,
    publisher: { name: m.publisher.name, ...(m.publisher.url ? { url: m.publisher.url } : {}) },
    icon: m.icon ? pluginUrl(m, m.icon) : null,
    origin: m.origin,
    hosting: m.hosting,
    selfOrigin: row.selfOrigin,
    risk: r.risk,
    riskNote: r.riskNote,
    permissions: row.permissions as PluginInstallation['permissions'],
    requestedPermissions: m.permissions,
    browser: row.browser,
    requestedBrowser: browserOf(m),
    status: row.enabled ? 'active' : 'disabled',
    entryPoints: {
      tabs: m.entryPoints.tabs,
      cards: m.entryPoints.cards,
      commands: m.entryPoints.commands,
      tools: m.entryPoints.tools.map((t) => ({
        name: t.name,
        description: t.description,
        write: t.write,
      })),
      events: m.entryPoints.events.map((e) => ({ type: e.type })),
    },
    update: newer
      ? {
          version: newer.version,
          // Newly asked for: what this version asks and the installed one did not (declined
          // permissions are not asked again).
          addedPermissions: newer.permissions.filter(
            (p) => !(m.permissions as string[]).includes(p),
          ) as PluginInstallation['permissions'],
          // Only when there are some: older clients see the same shape as before.
          ...addedBrowserOf(newer, m),
        }
      : null,
    installedBy: installedBy
      ? {
          id: installedBy.id,
          name: installedBy.name,
          email: installedBy.email,
          imageUrl: installedBy.image,
        }
      : null,
    installedAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function installers(db: DbOrTx, rows: InstallationRow[]) {
  const ids = [...new Set(rows.map((r) => r.installedBy).filter((v): v is string => !!v))];
  const list = ids.length
    ? await db
        .select({ id: users.id, name: users.name, email: users.email, image: users.image })
        .from(users)
        .where(inArray(users.id, ids))
    : [];
  return new Map(list.map((u) => [u.id, u]));
}

export async function loadInstallation(db: DbOrTx, orgId: string, id: string) {
  const [row] = await db
    .select()
    .from(pluginInstallations)
    .where(and(eq(pluginInstallations.id, id), eq(pluginInstallations.orgId, orgId)));
  if (!row) throw new AppError('plugin_not_found');
  return row;
}

async function viewOne(deps: Deps, row: InstallationRow, latest: Latest | null = null) {
  return view(row, (await installers(deps.db, [row])).get(row.installedBy ?? '') ?? null, latest);
}

export async function listInstallations(deps: Deps, org: OrgRow): Promise<PluginInstallation[]> {
  const rows = await deps.db
    .select()
    .from(pluginInstallations)
    .where(eq(pluginInstallations.orgId, org.id))
    .orderBy(asc(pluginInstallations.pluginId));
  // Updates come from the catalog; without it the list still shows what is installed.
  const catalog = rows.length ? await fetchCatalog(deps.env).catch(() => []) : [];
  const latest = new Map<string, Latest>(catalog.map((c) => [c.id, c]));
  // Unlisted and private plugins are not in the catalog: ask for each by id.
  for (const r of rows.filter((x) => !latest.has(x.pluginId))) {
    const detail = await fetchDetail(deps.env, r.pluginId).catch(() => null);
    if (detail) latest.set(r.pluginId, detail);
  }
  const people = await installers(deps.db, rows);
  return rows.map((r) =>
    view(r, people.get(r.installedBy ?? '') ?? null, latest.get(r.pluginId) ?? null),
  );
}

export async function catalogFor(
  deps: Deps,
  org: OrgRow,
  q?: string,
): Promise<PluginCatalogItem[]> {
  const items = await fetchCatalog(deps.env, q);
  const rows = await deps.db
    .select({
      id: pluginInstallations.id,
      pluginId: pluginInstallations.pluginId,
      version: pluginInstallations.version,
    })
    .from(pluginInstallations)
    .where(eq(pluginInstallations.orgId, org.id));
  const installed = new Map(rows.map((r) => [r.pluginId, r]));
  return items.map((i) => ({
    ...i,
    installedVersion: installed.get(i.id)?.version ?? null,
    installationId: installed.get(i.id)?.id ?? null,
  }));
}

/** API 29: one listing by plugin id or install link (unlisted ones are found only this way). */
export async function lookupPlugin(
  deps: Deps,
  org: OrgRow,
  ref: string,
): Promise<PluginCatalogItem> {
  const { versions: _versions, ...entry } = await fetchDetail(deps.env, pluginRefOf(deps.env, ref));
  const [row] = await deps.db
    .select({ id: pluginInstallations.id, version: pluginInstallations.version })
    .from(pluginInstallations)
    .where(and(eq(pluginInstallations.orgId, org.id), eq(pluginInstallations.pluginId, entry.id)));
  return { ...entry, installedVersion: row?.version ?? null, installationId: row?.id ?? null };
}

/**
 * The admin's grant (API 26): any subset of what the manifest asks for, in the manifest's
 * order. Anything the manifest does not ask for is refused.
 */
function grantOf<P extends string>(requested: readonly P[], granted: readonly string[]): P[] {
  if (granted.some((p) => !(requested as readonly string[]).includes(p))) {
    throw new AppError('plugin_permissions_mismatch', { asked: requested });
  }
  return requested.filter((p) => granted.includes(p));
}

export async function installPlugin(
  deps: Deps,
  org: OrgRow,
  input: InstallPlugin,
  actorId: string,
  req: RequestInfo,
): Promise<PluginInstallation> {
  const [existing] = await deps.db
    .select({ id: pluginInstallations.id })
    .from(pluginInstallations)
    .where(
      and(eq(pluginInstallations.orgId, org.id), eq(pluginInstallations.pluginId, input.pluginId)),
    );
  if (existing) throw new AppError('plugin_already_installed');
  const pkg = await fetchPackage(deps.env, input.pluginId, input.version);
  const granted = grantOf(pkg.manifest.permissions, input.permissions);
  // Browser features: only what the admin ticked; none when left out.
  const browser = grantOf(browserOf(pkg.manifest), input.browser ?? []);
  // Self-hosted: the org's copy must serve the signed manifest; it is used with its origin.
  if (pkg.manifest.hosting === 'self' && !input.selfOrigin) {
    throw new AppError('plugin_self_origin_required');
  }
  if (pkg.manifest.hosting !== 'self' && input.selfOrigin) {
    throw new AppError('plugin_self_origin_invalid', { reason: 'hosted' });
  }
  const selfOrigin = input.selfOrigin ? selfOriginOf(deps.env, input.selfOrigin) : null;
  const manifest = selfOrigin ? await verifySelfHosted(pkg.manifest, selfOrigin) : pkg.manifest;
  const secret = newSecret();
  const [row] = await deps.db
    .insert(pluginInstallations)
    .values({
      orgId: org.id,
      pluginId: manifest.id,
      version: manifest.version,
      manifest,
      package: pkg,
      permissions: granted,
      browser,
      selfOrigin,
      secretEnc: seal(deps.env.AUTH_SECRET, SECRET_PURPOSE, secret),
      installedBy: actorId,
    })
    .returning();
  const lifecycle: LifecycleRequest = {
    type: 'install',
    installationId: row!.id,
    apiUrl: issuerOf(deps.env),
    org: { id: org.id, name: org.name, domain: installationDomain(deps.env) },
    pluginVersion: pkg.manifest.version,
    permissions: granted,
    browser,
    secret,
  };
  try {
    // The plugin keeps the secret; until it has answered nothing is installed.
    await callPlugin(deps.env, row!, manifest.lifecycle.url, lifecycle, secret);
  } catch (err) {
    await deps.db.delete(pluginInstallations).where(eq(pluginInstallations.id, row!.id));
    throw err;
  }
  await audit(
    deps.db,
    {
      orgId: org.id,
      actorId,
      action: 'plugin.install',
      targetType: 'plugin_installation',
      targetId: row!.id,
      meta: {
        pluginId: pkg.manifest.id,
        version: pkg.manifest.version,
        permissions: granted,
        browser,
        risk: pkg.review.risk,
        keyId: pkg.signature.keyId,
        hosting: manifest.hosting,
        ...(selfOrigin ? { selfOrigin } : {}),
      },
    },
    req,
  );
  return viewOne(deps, row!);
}

export async function upgradePlugin(
  deps: Deps,
  org: OrgRow,
  id: string,
  input: UpgradePlugin,
  actorId: string,
  req: RequestInfo,
): Promise<PluginInstallation> {
  const row = await loadInstallation(deps.db, org.id, id);
  if (compareVersions(input.version, row.version) <= 0) {
    throw new AppError('conflict', { reason: 'not_newer', current: row.version });
  }
  const pkg = await fetchPackage(deps.env, row.pluginId, input.version);
  // Moving between the publisher's server and the org's own copy needs a fresh install.
  if ((pkg.manifest.hosting === 'self') !== (row.selfOrigin !== null)) {
    throw new AppError('plugin_hosting_changed', { hosting: pkg.manifest.hosting });
  }
  // The org's copy is checked again: it must already serve the new signed manifest.
  const manifest = row.selfOrigin
    ? await verifySelfHosted(pkg.manifest, row.selfOrigin)
    : pkg.manifest;
  // Only what this version newly asks for is asked; what was declined before stays declined.
  const added = pkg.manifest.permissions.filter((p) => !row.manifest.permissions.includes(p));
  const addedBrowser = browserOf(pkg.manifest).filter((c) => !browserOf(row.manifest).includes(c));
  if (
    (added.length && input.acceptPermissions === undefined) ||
    (addedBrowser.length && input.acceptBrowser === undefined)
  ) {
    throw new AppError('plugin_permissions_changed', {
      added,
      ...(addedBrowser.length ? { addedBrowser } : {}),
    });
  }
  const accepted = added.filter((p) => input.acceptPermissions?.includes(p));
  const granted = pkg.manifest.permissions.filter(
    (p) => accepted.includes(p) || (!added.includes(p) && row.permissions.includes(p)),
  );
  const acceptedBrowser = addedBrowser.filter((c) => input.acceptBrowser?.includes(c));
  const browser = browserOf(pkg.manifest).filter(
    (c) => acceptedBrowser.includes(c) || (!addedBrowser.includes(c) && row.browser.includes(c)),
  );
  const [next] = await deps.db
    .update(pluginInstallations)
    .set({
      version: manifest.version,
      manifest,
      package: pkg,
      // Permissions the new version no longer asks for are dropped.
      permissions: granted,
      browser,
      updatedAt: new Date(),
    })
    .where(eq(pluginInstallations.id, row.id))
    .returning();
  const lifecycle: LifecycleRequest = {
    type: 'update',
    installationId: row.id,
    pluginVersion: pkg.manifest.version,
    permissions: granted,
    browser,
  };
  await callPlugin(deps.env, next!, manifest.lifecycle.url, lifecycle).catch(() => undefined);
  await audit(
    deps.db,
    {
      orgId: org.id,
      actorId,
      action: 'plugin.upgrade',
      targetType: 'plugin_installation',
      targetId: row.id,
      meta: {
        pluginId: row.pluginId,
        from: row.version,
        to: pkg.manifest.version,
        added,
        accepted,
        addedBrowser,
        acceptedBrowser,
        ...(row.selfOrigin ? { selfOrigin: row.selfOrigin, recheck: 'ok' } : {}),
      },
    },
    req,
  );
  return viewOne(deps, next!);
}

/**
 * Turn on or off, and (API 26) change the grant to another subset of what the installed
 * version asks for; the plugin hears of a new grant through a lifecycle `update`.
 */
export async function updateInstallation(
  deps: Deps,
  org: OrgRow,
  id: string,
  input: {
    enabled?: boolean | undefined;
    permissions?: string[] | undefined;
    browser?: string[] | undefined;
  },
  actorId: string,
  req: RequestInfo,
) {
  const row = await loadInstallation(deps.db, org.id, id);
  const permissions =
    input.permissions !== undefined
      ? grantOf(row.manifest.permissions, input.permissions)
      : undefined;
  const browser =
    input.browser !== undefined ? grantOf(browserOf(row.manifest), input.browser) : undefined;
  const [next] = await deps.db
    .update(pluginInstallations)
    .set({
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(permissions ? { permissions } : {}),
      ...(browser ? { browser } : {}),
      updatedAt: new Date(),
    })
    .where(eq(pluginInstallations.id, row.id))
    .returning();
  if (input.enabled !== undefined && input.enabled !== row.enabled) {
    await audit(
      deps.db,
      {
        orgId: org.id,
        actorId,
        action: input.enabled ? 'plugin.enable' : 'plugin.disable',
        targetType: 'plugin_installation',
        targetId: row.id,
        meta: { pluginId: row.pluginId },
      },
      req,
    );
  }
  const grantChanged =
    (permissions && permissions.join(' ') !== row.permissions.join(' ')) ||
    (browser && browser.join(' ') !== row.browser.join(' '));
  if (grantChanged) {
    const lifecycle: LifecycleRequest = {
      type: 'update',
      installationId: row.id,
      pluginVersion: row.version,
      permissions: next!.permissions as PluginInstallation['permissions'],
      browser: next!.browser,
    };
    await callPlugin(deps.env, next!, row.manifest.lifecycle.url, lifecycle).catch(() => undefined);
    await audit(
      deps.db,
      {
        orgId: org.id,
        actorId,
        action: 'plugin.permissions',
        targetType: 'plugin_installation',
        targetId: row.id,
        meta: {
          pluginId: row.pluginId,
          from: row.permissions,
          to: next!.permissions,
          browserFrom: row.browser,
          browserTo: next!.browser,
        },
      },
      req,
    );
  }
  return viewOne(deps, next!);
}

export async function uninstallPlugin(
  deps: Deps,
  org: OrgRow,
  id: string,
  actorId: string,
  req: RequestInfo,
) {
  const row = await loadInstallation(deps.db, org.id, id);
  const lifecycle: LifecycleRequest = { type: 'uninstall', installationId: row.id };
  // Best effort: a plugin that is gone must not keep it installed here.
  await callPlugin(deps.env, row, row.manifest.lifecycle.url, lifecycle).catch(() => undefined);
  await deps.db.delete(pluginInstallations).where(eq(pluginInstallations.id, row.id));
  await audit(
    deps.db,
    {
      orgId: org.id,
      actorId,
      action: 'plugin.uninstall',
      targetType: 'plugin_installation',
      targetId: row.id,
      meta: { pluginId: row.pluginId, version: row.version },
    },
    req,
  );
}

/** Active installations of the org. */
export async function activeInstallations(db: DbOrTx, orgId: string) {
  return db
    .select()
    .from(pluginInstallations)
    .where(and(eq(pluginInstallations.orgId, orgId), eq(pluginInstallations.enabled, true)))
    .orderBy(asc(pluginInstallations.pluginId));
}

export async function surfaces(db: DbOrTx, orgId: string): Promise<PluginSurface[]> {
  return (await activeInstallations(db, orgId)).map((r) => ({
    installationId: r.id,
    pluginId: r.pluginId,
    name: r.manifest.name,
    icon: r.manifest.icon ? pluginUrl(r.manifest, r.manifest.icon) : null,
    origin: r.manifest.origin,
    risk: r.package.review.risk,
    tabs: r.manifest.entryPoints.tabs,
    cards: r.manifest.entryPoints.cards,
    commands: r.manifest.entryPoints.commands,
    permissions: r.permissions as NonNullable<PluginSurface['permissions']>,
    browser: r.browser,
  }));
}

/** The plugin's display name in the org's language (audit, "<plugin> ile" badges). */
export const pluginName = (m: PluginManifest, locale: string) => localize(m.name, locale);
