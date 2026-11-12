import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { Readable, Transform } from 'node:stream';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';

/**
 * Requests the server makes to addresses people type in (link titles and favicons, link health
 * checks, automation webhooks, federation peers). A member must not be able to make the server
 * reach its own network (S3, Postgres, cloud metadata, localhost, the Docker network), so:
 * - only http and https, ports 80 and 443 unless OUTBOUND_ALLOWED_PORTS lists more;
 * - the name is resolved once, every address is checked (loopback, private, link-local, CGNAT,
 *   ULA, multicast, reserved, metadata), and the connection goes to that checked address, so a
 *   second DNS answer cannot point elsewhere (DNS rebinding);
 * - every redirect goes through the same checks;
 * - a time limit and a body size limit.
 * PRIVATE_FETCH_ALLOWLIST opens intranet hosts or ranges (CIDR, a host, or `*.corp.example`):
 * they may be private and use any port. Admin-configured integrations (AI server, Notifike,
 * OIDC issuer, portal, S3) do not go through here: they are expected on the internal network.
 */

/** The destination is not reachable for server-side requests made on someone's behalf. */
export class BlockedAddressError extends Error {
  override name = 'BlockedAddressError';
  constructor(
    readonly reason: 'protocol' | 'port' | 'private' | 'dns',
    readonly host: string,
  ) {
    super(`outbound request to ${host} blocked (${reason})`);
  }
}

export interface Resolved {
  address: string;
  family: 4 | 6;
}

export interface OutboundPolicy {
  /** Ranges that may be reached even though private. */
  allowCidrs: BlockList;
  /** Host names that may be private: exact, or `*.example.com` for subdomains. */
  allowHosts: string[];
  /** Ports allowed besides 80 and 443 for everyone. */
  ports: Set<number>;
  resolve: (host: string) => Promise<Resolved[]>;
}

const forbidden = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  forbidden.addSubnet(net, bits, 'ipv4');
}
for (const [net, bits] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 32],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const) {
  forbidden.addSubnet(net, bits, 'ipv6');
}

/** IPv4 inside an IPv4-mapped IPv6 address (`::ffff:10.0.0.1`), else null. */
function mappedV4(address: string): string | null {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  return m ? m[1]! : null;
}

/** Private, loopback, link-local, reserved and other addresses nobody outside should reach. */
export function isInternalAddress(address: string): boolean {
  const v4 = mappedV4(address);
  if (v4) return forbidden.check(v4, 'ipv4');
  const family = isIP(address);
  if (family === 0) return true;
  return forbidden.check(address, family === 6 ? 'ipv6' : 'ipv4');
}

const systemResolve = async (host: string): Promise<Resolved[]> =>
  (await dnsLookup(host, { all: true, verbatim: true })).map((a) => ({
    address: a.address,
    family: a.family === 6 ? 6 : 4,
  }));

/** The policy from env: PRIVATE_FETCH_ALLOWLIST and OUTBOUND_ALLOWED_PORTS (comma lists). */
export function outboundPolicy(
  env: { PRIVATE_FETCH_ALLOWLIST?: string; OUTBOUND_ALLOWED_PORTS?: string },
  resolve: OutboundPolicy['resolve'] = systemResolve,
): OutboundPolicy {
  const allowCidrs = new BlockList();
  const allowHosts: string[] = [];
  for (const raw of (env.PRIVATE_FETCH_ALLOWLIST ?? '').split(',')) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    const [net, bits] = entry.split('/');
    const family = isIP(net!);
    if (family) {
      const type = family === 6 ? 'ipv6' : 'ipv4';
      if (bits === undefined) allowCidrs.addAddress(net!, type);
      else allowCidrs.addSubnet(net!, Number(bits), type);
    } else allowHosts.push(entry);
  }
  const ports = new Set(
    (env.OUTBOUND_ALLOWED_PORTS ?? '')
      .split(',')
      .map((p) => Number(p.trim()))
      .filter((p) => Number.isInteger(p) && p > 0 && p < 65_536),
  );
  return { allowCidrs, allowHosts, ports, resolve };
}

let current: OutboundPolicy = outboundPolicy({});

/** Set once at start from env (server.ts); tests may pass their own policy per call. */
export function configureOutbound(policy: OutboundPolicy) {
  current = policy;
}

function hostAllowed(policy: OutboundPolicy, host: string) {
  const h = host.toLowerCase();
  return policy.allowHosts.some((p) =>
    p.startsWith('*.') ? h.endsWith(p.slice(1)) && h.length > p.length - 1 : h === p,
  );
}

function addressAllowed(policy: OutboundPolicy, a: Resolved) {
  const v4 = mappedV4(a.address);
  return v4
    ? policy.allowCidrs.check(v4, 'ipv4')
    : policy.allowCidrs.check(a.address, a.family === 6 ? 'ipv6' : 'ipv4');
}

/**
 * Checks a URL and resolves it to the one address to connect to. Throws BlockedAddressError
 * when the protocol, port or any address it resolves to is not allowed.
 */
export async function checkDestination(
  url: URL,
  policy: OutboundPolicy = current,
): Promise<Resolved> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BlockedAddressError('protocol', host);
  }
  const byHost = hostAllowed(policy, host);
  const literal = isIP(host);
  let addresses: Resolved[];
  if (literal) addresses = [{ address: host, family: literal === 6 ? 6 : 4 }];
  else {
    try {
      addresses = await policy.resolve(host);
    } catch {
      throw new BlockedAddressError('dns', host);
    }
    if (!addresses.length) throw new BlockedAddressError('dns', host);
  }
  // Every answer must pass: one private answer among public ones is how rebinding starts.
  const allowed = (a: Resolved) =>
    byHost || addressAllowed(policy, a) || !isInternalAddress(a.address);
  if (!addresses.every(allowed)) throw new BlockedAddressError('private', host);
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  const special = byHost || addresses.every((a) => addressAllowed(policy, a));
  if (port !== 80 && port !== 443 && !policy.ports.has(port) && !special) {
    throw new BlockedAddressError('port', host);
  }
  return addresses[0]!;
}

export interface OutboundInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  /** 'follow' (default, up to 5 hops, each checked) or 'manual'. */
  redirect?: 'follow' | 'manual';
  timeoutMs?: number;
  /** Larger bodies end the stream with an error. */
  maxBytes?: number;
  signal?: AbortSignal;
  policy?: OutboundPolicy;
}

const MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

/** A network failure shaped like fetch's: a TypeError with the socket error as `cause`. */
function fetchFailed(err: unknown) {
  if (err instanceof BlockedAddressError) return err;
  const e = err as { name?: string };
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return err;
  return new TypeError('fetch failed', { cause: err });
}

function limited(stream: IncomingMessage, maxBytes: number) {
  let seen = 0;
  return stream.pipe(
    new Transform({
      transform(chunk: Buffer, _enc, done) {
        seen += chunk.length;
        if (seen > maxBytes) done(new Error(`response larger than ${maxBytes} bytes`));
        else done(null, chunk);
      },
    }),
  );
}

async function once(url: URL, init: OutboundInit, policy: OutboundPolicy, signal: AbortSignal) {
  const target = await checkDestination(url, policy);
  const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise<IncomingMessage>((resolve, reject) => {
    const req = request(
      url,
      {
        method: init.method ?? 'GET',
        headers: init.headers,
        signal,
        // Connect to the address that was checked, never to a fresh DNS answer.
        lookup: (_host, options, callback) => {
          const cb = callback as (...args: unknown[]) => void;
          if ((options as { all?: boolean }).all) cb(null, [target]);
          else cb(null, target.address, target.family);
        },
      },
      resolve,
    );
    req.on('error', reject);
    req.end(init.body);
  });
}

/**
 * fetch for addresses people typed: same Response, but every hop is checked and pinned (see
 * the module comment). Blocked destinations throw BlockedAddressError; network failures a
 * TypeError with the socket error as `cause`, like fetch.
 */
export async function outboundFetch(input: string | URL, init: OutboundInit = {}) {
  const policy = init.policy ?? current;
  const timeout = AbortSignal.timeout(init.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  let url = new URL(input);
  let method = init.method ?? 'GET';
  let body = init.body;
  for (let hop = 0; ; hop++) {
    let res: IncomingMessage;
    try {
      res = await once(url, { ...init, method, body }, policy, signal);
    } catch (err) {
      throw fetchFailed(err);
    }
    const location = res.headers.location;
    const status = res.statusCode ?? 0;
    if (
      init.redirect !== 'manual' &&
      status >= 300 &&
      status < 400 &&
      location &&
      hop < MAX_REDIRECTS
    ) {
      res.resume();
      url = new URL(location, url);
      if (status === 303 || ((status === 301 || status === 302) && method === 'POST')) {
        method = 'GET';
        body = undefined;
      }
      continue;
    }
    const headers = new Headers();
    for (const [k, v] of Object.entries(res.headers)) {
      if (Array.isArray(v)) for (const item of v) headers.append(k, item);
      else if (v !== undefined) headers.set(k, v);
    }
    const empty = method === 'HEAD' || status === 204 || status === 205 || status === 304;
    if (empty) res.resume();
    const stream = empty ? null : limited(res, init.maxBytes ?? DEFAULT_MAX_BYTES);
    const response = new Response(
      stream ? (Readable.toWeb(stream) as ReadableStream<Uint8Array>) : null,
      { status: status < 200 ? 200 : status, headers },
    );
    Object.defineProperty(response, 'url', { value: url.href });
    return response;
  }
}

/**
 * A TLS handshake to read the certificate (link health: expiry), with the same checks and
 * pinning as outboundFetch. Throws BlockedAddressError for blocked destinations.
 */
export async function outboundTls(
  url: URL,
  options: { timeoutMs: number; policy?: OutboundPolicy },
): Promise<TLSSocket> {
  const target = await checkDestination(url, options.policy ?? current);
  return tlsConnect({
    host: target.address,
    port: Number(url.port || 443),
    servername: isIP(url.hostname) ? undefined : url.hostname,
    rejectUnauthorized: false,
    timeout: options.timeoutMs,
  });
}
