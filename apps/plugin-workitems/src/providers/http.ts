import { lookup, type LookupAddress } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import { ProviderError } from '../types';

export type FetchLike = typeof fetch;

/**
 * Addresses a person types (a Jira server, a collection URL) must not reach this server's own
 * network: a hosted copy would otherwise be a way in. The check runs at connect time, on the
 * address actually dialled, so a name cannot resolve to something else afterwards. A copy an
 * organization runs for its own on-premises server sets ALLOW_PRIVATE_HOSTS.
 */
const PRIVATE = new BlockList();
for (const [a, p] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
] as const) {
  PRIVATE.addSubnet(a, p, 'ipv4');
}
for (const [a, p] of [
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
] as const) {
  PRIVATE.addSubnet(a, p, 'ipv6');
}

export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (!family) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1];
  if (mapped) return PRIVATE.check(mapped, 'ipv4');
  return PRIVATE.check(ip, family === 6 ? 'ipv6' : 'ipv4');
}

type LookupDone = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

export function guardedFetch(allowPrivate: boolean): FetchLike {
  const dispatcher = new Agent({
    connect: {
      lookup: (host: string, opts: { all?: boolean }, done: LookupDone) => {
        lookup(host, { all: true }, (err, addresses) => {
          if (err) return done(err, '');
          const ok = allowPrivate
            ? addresses
            : addresses.filter((a) => !isPrivateAddress(a.address));
          if (!ok.length) return done(new Error('blocked address'), '');
          if (opts.all) return done(null, ok);
          done(null, ok[0]!.address, ok[0]!.family);
        });
      },
    },
  });
  return ((input: Parameters<FetchLike>[0], init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const literal = url.hostname.replace(/^\[|\]$/g, '');
    if (!allowPrivate && (isIP(literal) ? isPrivateAddress(literal) : literal === 'localhost')) {
      throw new ProviderError('blocked_address');
    }
    return undiciFetch(url, {
      ...(init as object),
      redirect: 'error',
      dispatcher,
    } as Parameters<typeof undiciFetch>[1]);
  }) as FetchLike;
}

/** https, no credentials or query; `http` only where private hosts are allowed. */
export function cleanBaseUrl(raw: string, allowPrivate: boolean): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new ProviderError('invalid_url');
  }
  if (u.protocol !== 'https:' && !(allowPrivate && u.protocol === 'http:')) {
    throw new ProviderError('invalid_url');
  }
  if (u.username || u.password || u.search || u.hash) throw new ProviderError('invalid_url');
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

export interface RequestOptions {
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  contentType?: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const MAX_WAIT_MS = 30_000;

export class Http {
  constructor(
    private readonly base: string,
    private readonly authorization: () => Promise<string>,
    private readonly doFetch: FetchLike,
    private readonly wait: (ms: number) => Promise<void> = sleep,
  ) {}

  async request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const url = new URL(`${this.base}${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = {
        Accept: 'application/json',
        Authorization: await this.authorization(),
      };
      if (opts.body !== undefined) headers['Content-Type'] = opts.contentType ?? 'application/json';
      let res: Response;
      try {
        res = await this.doFetch(url, {
          method,
          headers,
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
          signal: AbortSignal.timeout(30_000),
        });
      } catch (err) {
        if (err instanceof ProviderError) throw err;
        throw new ProviderError('unreachable');
      }
      if ((res.status === 429 || res.status === 503) && attempt < 3) {
        const after = Number(res.headers.get('retry-after'));
        await this.wait(
          Math.min(Number.isFinite(after) && after > 0 ? after * 1000 : 2000, MAX_WAIT_MS),
        );
        continue;
      }
      const text = await res.text();
      if (res.ok) {
        if (!text) return undefined as T;
        try {
          return JSON.parse(text) as T;
        } catch {
          // Azure DevOps answers a bad token with a 203 sign-in page.
          throw new ProviderError('auth_failed', res.status);
        }
      }
      if (res.status === 401) throw new ProviderError('auth_failed', 401);
      if (res.status === 403) throw new ProviderError('forbidden', 403);
      if (res.status === 404) throw new ProviderError('not_found', 404);
      if (res.status === 412) throw new ProviderError('conflict', 412);
      throw new ProviderError('rejected', res.status, describe(text));
    }
  }
}

/** The service's own words, short: they go to the sync log. */
function describe(text: string): string {
  try {
    const j = JSON.parse(text) as {
      message?: string;
      errorMessages?: string[];
      errors?: Record<string, string>;
    };
    const parts = [j.message, ...(j.errorMessages ?? []), ...Object.values(j.errors ?? {})];
    return parts.filter(Boolean).join(' ').slice(0, 300);
  } catch {
    return '';
  }
}

export const toBasic = (user: string, secret: string) =>
  `Basic ${Buffer.from(`${user}:${secret}`, 'utf8').toString('base64')}`;
