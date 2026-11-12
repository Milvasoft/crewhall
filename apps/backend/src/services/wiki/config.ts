import { z } from 'zod';
import type { Env } from '../../env';

/**
 * Collab settings. They are read from the process environment here (not env.ts) so the
 * wiki module stays inside its own files; see the wiki notes in docs/contracts.
 *
 * - COLLAB_PORT: where `src/collab` listens (default 3001).
 * - COLLAB_PUBLIC_URL: WebSocket URL (or a path such as `/collab`) handed to clients. Default:
 *   `ws(s)://<HUB_URL host>/collab` in production (Caddy routes it), `ws://localhost:<COLLAB_PORT>`
 *   otherwise. Browsers get the path only when it is on a web origin, see `clientCollabUrl`.
 * - COLLAB_INTERNAL_URL: how the api reaches the collab server for live edits
 *   (restore, MCP writes). Default `http://localhost:<COLLAB_PORT>`.
 */
const CollabEnv = z.object({
  COLLAB_PORT: z.coerce.number().int().default(3001),
  COLLAB_PUBLIC_URL: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  COLLAB_INTERNAL_URL: z.preprocess((v) => (v === '' ? undefined : v), z.url().optional()),
});

export interface CollabConfig {
  port: number;
  publicUrl: string;
  internalUrl: string;
}

export function collabConfig(env: Env, source: Record<string, string | undefined> = process.env) {
  const c = CollabEnv.parse(source);
  let publicUrl = c.COLLAB_PUBLIC_URL;
  if (!publicUrl) {
    if (env.NODE_ENV === 'production') {
      const hub = new URL(env.HUB_URL);
      publicUrl = `${hub.protocol === 'https:' ? 'wss' : 'ws'}://${hub.host}/collab`;
    } else {
      publicUrl = `ws://localhost:${c.COLLAB_PORT}`;
    }
  }
  return {
    port: c.COLLAB_PORT,
    publicUrl,
    internalUrl: c.COLLAB_INTERNAL_URL ?? `http://localhost:${c.COLLAB_PORT}`,
  } satisfies CollabConfig;
}

/** `ws(s)://host/x` → `http(s)://host`; null for a relative path or a malformed URL. */
function httpOrigin(url: string): string | null {
  try {
    const u = new URL(url);
    const scheme = u.protocol === 'wss:' || u.protocol === 'https:' ? 'https:' : 'http:';
    return `${scheme}//${u.host}`;
  } catch {
    return null;
  }
}

/**
 * The collab URL handed to a client (B12). A collab server on a web origin (HUB_URL or
 * WEB_ORIGINS, Caddy and the Vite proxy route `/collab`) goes out as its path, and browsers
 * resolve it against the page, so the hub works from any address it is opened at (127.0.0.1, a
 * domain, a VPN). `absolute` clients (the mobile app) always get a full URL.
 */
export function clientCollabUrl(env: Env, publicUrl: string, absolute = false): string {
  if (publicUrl.startsWith('/')) {
    if (!absolute) return publicUrl;
    const hub = new URL(env.HUB_URL);
    return `${hub.protocol === 'https:' ? 'wss' : 'ws'}://${hub.host}${publicUrl}`;
  }
  if (absolute) return publicUrl;
  const origin = httpOrigin(publicUrl);
  const web = [env.HUB_URL, ...env.WEB_ORIGINS].map(httpOrigin);
  if (!origin || !web.includes(origin)) return publicUrl;
  const u = new URL(publicUrl);
  return `${u.pathname}${u.search}`;
}
