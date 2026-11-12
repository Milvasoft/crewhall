import {
  apiLevelSupported,
  CatalogDetail,
  CatalogPage,
  PackageError,
  PluginId,
  verifyPackage,
  type PluginPackage,
} from '@crewhall/plugin-sdk';
import type { Env } from '../../env';
import { AppError } from '../../http/errors';

/**
 * The central marketplace as this installation sees it (docs/contracts/eklentiler.md ›
 * Katalog API'si): the catalog for our domain, and packages verified against the trusted
 * marketplace keys before anything is stored.
 */

const TIMEOUT_MS = 10_000;

/** The installation's domain as the marketplace knows it (in-house audience lists). */
export const installationDomain = (env: Env) => new URL(env.API_URL).host.toLowerCase();

async function get(env: Env, path: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(new URL(path, env.MARKETPLACE_URL), {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new AppError('marketplace_unreachable');
  }
  if (res.status === 404) throw new AppError('plugin_not_found');
  if (!res.ok) throw new AppError('marketplace_unreachable', { status: res.status });
  return res.json().catch(() => {
    throw new AppError('marketplace_unreachable', { reason: 'json' });
  });
}

export async function fetchCatalog(env: Env, q?: string) {
  const params = new URLSearchParams({ installation: installationDomain(env) });
  if (q) params.set('q', q);
  const page = CatalogPage.safeParse(await get(env, `/v1/catalog?${params}`));
  if (!page.success) throw new AppError('marketplace_unreachable', { reason: 'shape' });
  return page.data.items;
}

/**
 * A plugin id from what the admin pasted: the id itself, or an install link of our
 * marketplace (`/p/<id>`, `/plugins/<id>`, `/v1/plugins/<id>`). Links to other hosts are
 * refused: packages only ever come from MARKETPLACE_URL.
 */
export function pluginRefOf(env: Env, ref: string): string {
  const trimmed = ref.trim();
  const direct = PluginId.safeParse(trimmed.toLowerCase());
  if (direct.success) return direct.data;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new AppError('plugin_link_invalid');
  }
  if (url.host.toLowerCase() !== new URL(env.MARKETPLACE_URL).host.toLowerCase()) {
    throw new AppError('plugin_link_invalid', { reason: 'host' });
  }
  const m = /^\/(?:p|plugins|v1\/plugins)\/([^/]+)\/?$/.exec(url.pathname);
  let id: string | undefined;
  try {
    id = m ? decodeURIComponent(m[1]!) : undefined;
  } catch {
    id = undefined;
  }
  const parsed = PluginId.safeParse(id?.toLowerCase());
  if (!parsed.success) throw new AppError('plugin_link_invalid', { reason: 'path' });
  return parsed.data;
}

export async function fetchDetail(env: Env, pluginId: string) {
  const params = new URLSearchParams({ installation: installationDomain(env) });
  const detail = CatalogDetail.safeParse(
    await get(env, `/v1/plugins/${encodeURIComponent(pluginId)}?${params}`),
  );
  if (!detail.success) throw new AppError('marketplace_unreachable', { reason: 'shape' });
  return detail.data;
}

/**
 * A version's signed package: the signature must come from a trusted key, the manifest must
 * be this plugin and version, our API level must be in range and we must be in its audience.
 */
export async function fetchPackage(
  env: Env,
  pluginId: string,
  version: string,
): Promise<PluginPackage> {
  // The installation is named so a private listing serves its allowlisted installations.
  const params = new URLSearchParams({ installation: installationDomain(env) });
  const raw = await get(
    env,
    `/v1/plugins/${encodeURIComponent(pluginId)}/versions/${encodeURIComponent(version)}/package?${params}`,
  );
  let pkg: PluginPackage;
  try {
    pkg = await verifyPackage(raw, env.MARKETPLACE_PUBLIC_KEYS);
  } catch (err) {
    throw new AppError('plugin_signature_invalid', {
      reason: err instanceof PackageError ? err.reason : 'shape',
    });
  }
  if (pkg.manifest.id !== pluginId || pkg.manifest.version !== version) {
    throw new AppError('plugin_signature_invalid', { reason: 'mismatch' });
  }
  if (!apiLevelSupported(pkg.manifest)) {
    throw new AppError('plugin_api_level', { apiLevel: pkg.manifest.apiLevel });
  }
  if (pkg.review.audience && !pkg.review.audience.includes(installationDomain(env))) {
    throw new AppError('plugin_not_for_installation');
  }
  return pkg;
}
