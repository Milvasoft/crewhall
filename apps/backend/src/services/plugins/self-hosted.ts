import {
  SELF_HOSTED_MANIFEST_PATH,
  selfHostedMismatch,
  type PluginManifest,
} from '@crewhall/plugin-sdk';
import type { Env } from '../../env';
import { AppError } from '../../http/errors';
import { BlockedAddressError, outboundFetch } from '../../net/outbound';

/**
 * Self-hosted plugins (docs/contracts/eklentiler.md › Kendi sunucusunda): the org runs its own
 * copy, and Crewhall talks to that origin only after it serves the marketplace-signed manifest.
 * Every request there goes through outboundFetch: no private addresses, each hop checked.
 */

const MAX_MANIFEST_BYTES = 256 * 1024;
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

/**
 * The admin's address as an origin: https, no path, query, user or fragment (a trailing `/` is
 * fine). Plain http only for localhost outside production, for developing a plugin.
 */
export function selfOriginOf(env: Env, raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new AppError('plugin_self_origin_invalid', { reason: 'url' });
  }
  const local = LOCAL_HOSTS.includes(url.hostname);
  const scheme =
    url.protocol === 'https:' ||
    (url.protocol === 'http:' && local && env.NODE_ENV !== 'production');
  const bare =
    (url.pathname === '/' || url.pathname === '') &&
    !url.search &&
    !url.hash &&
    !url.username &&
    !url.password;
  if (!scheme || !bare) throw new AppError('plugin_self_origin_invalid', { reason: 'origin' });
  return url.origin;
}

/**
 * Reads `<origin>/.well-known/crewhall-plugin.json` and returns the signed manifest on that
 * origin, or throws: the copy must be the signed manifest in everything but the origin.
 */
export async function verifySelfHosted(
  signed: PluginManifest,
  origin: string,
): Promise<PluginManifest> {
  let res: Response;
  try {
    res = await outboundFetch(new URL(SELF_HOSTED_MANIFEST_PATH, origin), {
      headers: { Accept: 'application/json' },
      // The manifest must be served on exactly this origin.
      redirect: 'manual',
      maxBytes: MAX_MANIFEST_BYTES,
    });
  } catch (err) {
    if (err instanceof BlockedAddressError) {
      throw new AppError('plugin_self_origin_invalid', { reason: 'blocked' });
    }
    throw new AppError('plugin_self_unreachable', { origin });
  }
  if (res.status !== 200) {
    await res.body?.cancel();
    throw new AppError('plugin_self_unreachable', { origin, status: res.status });
  }
  let served: unknown;
  try {
    served = await res.json();
  } catch {
    throw new AppError('plugin_self_unreachable', { origin, reason: 'json' });
  }
  const reason = selfHostedMismatch(signed, served, origin);
  if (reason) throw new AppError('plugin_self_manifest_mismatch', { reason });
  return { ...signed, origin };
}
