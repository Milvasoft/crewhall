import {
  API_LEVEL,
  compareSemver,
  DEPRECATED_FIELDS,
  endpoints,
  MIN_CLIENT_DEFAULTS,
  parseClientHeader,
  type EndpointDef,
  type GatedPlatform,
  type MinClientVersion,
  type ServerCompat,
} from '@crewhall/shared';
import type { Env } from '../env';
import { PACKAGE_VERSION } from '../version';

/**
 * Server/app compatibility (shared compat.ts): which app versions this server still accepts
 * and which contract entries are on their way out.
 */

export function minClientVersion(env: Env): MinClientVersion {
  return {
    ios: env.MIN_CLIENT_IOS ?? env.MIN_MOBILE_VERSION ?? MIN_CLIENT_DEFAULTS.ios,
    android: env.MIN_CLIENT_ANDROID ?? env.MIN_MOBILE_VERSION ?? MIN_CLIENT_DEFAULTS.android,
    desktop: env.MIN_CLIENT_DESKTOP ?? MIN_CLIENT_DEFAULTS.desktop,
  };
}

function storeUrls(env: Env): ServerCompat['storeUrls'] {
  return {
    ios: env.CLIENT_STORE_URL_IOS ?? null,
    android: env.CLIENT_STORE_URL_ANDROID ?? null,
    desktop: env.CLIENT_STORE_URL_DESKTOP ?? null,
  };
}

export interface ClientCheck {
  status: 'ok' | 'outdated';
  platform: GatedPlatform;
  min: string;
  current: string;
  storeUrl: string | null;
}

/**
 * The `X-Crewhall-Client` header against the minimum for its platform. Null without the
 * header, for a malformed one and for web: those are never turned away.
 */
export function checkClient(env: Env, header: string | null | undefined): ClientCheck | null {
  const client = parseClientHeader(header);
  if (!client || client.platform === 'web') return null;
  const platform = client.platform;
  const min = minClientVersion(env)[platform];
  return {
    status: compareSemver(client.version, min) < 0 ? 'outdated' : 'ok',
    platform,
    min,
    current: client.version,
    storeUrl: storeUrls(env)[platform],
  };
}

export function serverCompat(env: Env): ServerCompat {
  const table = endpoints as Record<string, EndpointDef>;
  const deprecations: ServerCompat['deprecations'] = [];
  for (const [name, d] of Object.entries(table)) {
    if (!d.deprecated) continue;
    deprecations.push({
      endpoint: name,
      method: d.method,
      path: d.path,
      field: null,
      since: d.deprecated.since,
      removeAfter: d.deprecated.removeAfter,
      replacement: d.deprecated.replacement ?? null,
    });
  }
  for (const f of DEPRECATED_FIELDS) {
    const d = table[f.endpoint];
    if (!d) continue;
    deprecations.push({
      endpoint: f.endpoint,
      method: d.method,
      path: d.path,
      field: f.field,
      since: f.since,
      removeAfter: f.removeAfter,
      replacement: f.replacement ?? null,
    });
  }
  return {
    version: env.APP_VERSION ?? PACKAGE_VERSION,
    build: env.BUILD_ID,
    commit: env.BUILD_COMMIT,
    apiLevel: API_LEVEL,
    minClientVersion: minClientVersion(env),
    storeUrls: storeUrls(env),
    deprecations,
  };
}

/** RFC 9745 `Deprecation` (`@<unix seconds>`) and RFC 8594 `Sunset` (HTTP date) values. */
export function deprecationHeaders(d: NonNullable<EndpointDef['deprecated']>) {
  return {
    Deprecation: `@${Math.floor(Date.parse(d.since) / 1000)}`,
    Sunset: new Date(d.removeAfter).toUTCString(),
  };
}
