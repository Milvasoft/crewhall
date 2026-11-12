import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { federationPeers, type DbOrTx, type OrgSettingsData } from '@crewhall/db';
import { ERROR_CODES, type ErrorCode } from '@crewhall/shared';
import type { Deps } from '../../deps';
import type { Env } from '../../env';
import { outboundFetch } from '../../net/outbound';
import { AppError } from '../../http/errors';
import { PACKAGE_VERSION } from '../../version';
import { instanceKey } from './keys';
import { signRequest } from './signature';

/** Federation plumbing shared by the admin, chat and inbox sides (docs/contracts/federasyon.md). */

export const INBOX_PATH = '/api/federation/v1/inbox';
export const DISCOVERY_PATH = '/.well-known/crewhall-federation';
const TIMEOUT_MS = 10_000;
/** Largest activity body accepted or sent. */
export const MAX_BODY_BYTES = 256 * 1024;

export interface FedOrg {
  id: string;
  name: string;
  settings: OrgSettingsData;
}

export interface FedDeps {
  db: DbOrTx;
  env: Env;
}

/** What federation work needs, in a request or in the worker (JobDeps). */
export type FedJobDeps = Pick<Deps, 'db' | 'env' | 'jobs' | 'logger' | 'bus' | 'storage'>;

/** This installation's domain: the host of API_URL (Caddy serves web and api on one origin). */
export function ownDomain(env: Env): string {
  return new URL(env.API_URL).host.toLowerCase();
}

export function baseUrl(env: Env, domain: string): string {
  return `${env.FEDERATION_ALLOW_HTTP ? 'http' : 'https'}://${domain}`;
}

/** The URI peers sign for when they post to us. */
export function ownInboxUrl(env: Env): string {
  return `${new URL(env.API_URL).origin}${INBOX_PATH}`;
}

/** Per-key sliding window over one minute (per peer: inbox, file endpoint, meeting joins). */
const windows = new Map<string, number[]>();
export function rateAllowed(key: string, perMinute: number): boolean {
  const now = Date.now();
  const recent = (windows.get(key) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= perMinute) {
    windows.set(key, recent);
    return false;
  }
  recent.push(now);
  windows.set(key, recent);
  if (windows.size > 10_000) windows.clear();
  return true;
}

export function federationOn(org: FedOrg): boolean {
  return org.settings.federationEnabled === true;
}

export function requireFederation(org: FedOrg) {
  if (!federationOn(org)) throw new AppError('federation_disabled');
}

export function allowedDomains(org: FedOrg): string[] {
  return org.settings.federationAllowedDomains ?? [];
}

/** `*.example.com` covers subdomains (not example.com itself). */
export function domainAllowed(org: FedOrg, domain: string): boolean {
  return allowedDomains(org).some((p) =>
    p.startsWith('*.') ? domain.endsWith(p.slice(1)) && domain.length > p.length - 1 : p === domain,
  );
}

export function splitAddress(address: string): { handle: string; domain: string } {
  const at = address.lastIndexOf('@');
  return { handle: address.slice(0, at), domain: address.slice(at + 1) };
}

export type PeerRow = typeof federationPeers.$inferSelect;

export function peerActive(org: FedOrg, peer: PeerRow): boolean {
  return (
    peer.weAdded && peer.theyAdded && peer.publicKey !== null && domainAllowed(org, peer.domain)
  );
}

export async function peerByDomain(db: DbOrTx, orgId: string, domain: string) {
  const [row] = await db
    .select()
    .from(federationPeers)
    .where(and(eq(federationPeers.orgId, orgId), eq(federationPeers.domain, domain)));
  return row ?? null;
}

/** An active peer for the domain, or the right error for the caller. */
export async function requireActivePeer(deps: FedDeps, org: FedOrg, domain: string) {
  requireFederation(org);
  if (domain === ownDomain(deps.env)) throw new AppError('federation_domain_self');
  if (!domainAllowed(org, domain)) throw new AppError('federation_domain_not_allowed');
  const peer = await peerByDomain(deps.db, org.id, domain);
  if (!peer || !peerActive(org, peer)) throw new AppError('federation_peer_not_active');
  return peer;
}

// ---- Discovery ----

export const Discovery = z.object({
  software: z.literal('crewhall'),
  version: z.string(),
  domain: z.string(),
  name: z.string().nullable(),
  publicKey: z.string().min(40).max(200),
  inbox: z.url(),
});
export type Discovery = z.infer<typeof Discovery>;

export async function discoveryDocument(deps: FedDeps, org: FedOrg): Promise<Discovery> {
  const key = await instanceKey(deps.db, deps.env.AUTH_SECRET, org.id);
  return {
    software: 'crewhall',
    version: PACKAGE_VERSION,
    domain: ownDomain(deps.env),
    name: org.name,
    publicKey: key!.publicKey,
    inbox: ownInboxUrl(deps.env),
  };
}

export async function fetchDiscovery(env: Env, domain: string): Promise<Discovery> {
  let res: Response;
  try {
    // A redirect answers 3xx, which is not ok below.
    res = await outboundFetch(`${baseUrl(env, domain)}${DISCOVERY_PATH}`, {
      headers: { Accept: 'application/json' },
      redirect: 'manual',
      timeoutMs: TIMEOUT_MS,
    });
  } catch {
    throw new AppError('federation_peer_unreachable', { domain });
  }
  if (!res.ok) throw new AppError('federation_peer_unreachable', { domain, status: res.status });
  const doc = Discovery.safeParse(await res.json().catch(() => null));
  if (!doc.success || doc.data.domain !== domain) {
    throw new AppError('federation_peer_unreachable', { domain, reason: 'discovery' });
  }
  return doc.data;
}

// ---- Outgoing activities ----

export interface Activity {
  id: string;
  type: string;
  [key: string]: unknown;
}

export const newActivity = <T extends Record<string, unknown>>(type: string, fields: T) => ({
  id: randomUUID(),
  type,
  ...fields,
});

/** A peer's federation error codes are passed on as ours (the same contract on both sides). */
const FEDERATION_CODES = new Set<string>(ERROR_CODES.filter((c) => c.startsWith('federation_')));

/**
 * Posts a signed activity to the peer's inbox and returns its JSON answer. A federation error
 * code from the peer comes back as the same AppError; anything else is "unreachable".
 */
export async function postActivity(
  deps: FedDeps,
  orgId: string,
  domain: string,
  activity: Activity,
): Promise<Record<string, unknown>> {
  const key = await instanceKey(deps.db, deps.env.AUTH_SECRET, orgId);
  const url = `${baseUrl(deps.env, domain)}${INBOX_PATH}`;
  const body = JSON.stringify(activity);
  if (Buffer.byteLength(body) > MAX_BODY_BYTES)
    throw new AppError('bad_request', { reason: 'size' });
  const headers = signRequest({
    method: 'POST',
    url,
    body,
    keyId: ownDomain(deps.env),
    privateKey: key!.privateKey,
  });
  let res: Response;
  try {
    res = await outboundFetch(url, {
      method: 'POST',
      headers: { ...headers, Accept: 'application/json' },
      body,
      redirect: 'manual',
      timeoutMs: TIMEOUT_MS,
    });
  } catch {
    throw new AppError('federation_peer_unreachable', { domain });
  }
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const code =
      typeof json.code === 'string' && FEDERATION_CODES.has(json.code) ? json.code : null;
    if (code) throw new AppError(code as ErrorCode, { domain });
    throw new AppError('federation_peer_unreachable', { domain, status: res.status });
  }
  return json;
}
