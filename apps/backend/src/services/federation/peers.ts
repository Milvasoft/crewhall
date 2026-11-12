import { and, asc, eq, sql } from 'drizzle-orm';
import { federationPeers, organizations } from '@crewhall/db';
import type { FederationPeer, FederationSettings, UpdateFederation } from '@crewhall/shared';
import type { Deps } from '../../deps';
import { AppError } from '../../http/errors';
import type { RequestInfo } from '../../http/types';
import { audit } from '../audit';
import {
  allowedDomains,
  domainAllowed,
  federationOn,
  fetchDiscovery,
  newActivity,
  ownDomain,
  peerActive,
  peerByDomain,
  postActivity,
  requireFederation,
  type FedDeps,
  type FedOrg,
  type PeerRow,
} from './core';
import { fingerprint, instanceKey } from './keys';
import { ownInstanceId, peerInstanceChanged, sharedSettings, syncShares } from './shared';

/** Yönetim › Güvenlik › Federasyon: the switch, allowed domains and peers (mutual registration). */

export function toPeer(org: FedOrg, p: PeerRow): FederationPeer {
  return {
    id: p.id,
    domain: p.domain,
    name: p.name,
    status: peerActive(org, p) ? 'active' : 'pending',
    fingerprint: p.publicKey ? fingerprint(p.publicKey) : null,
    requested: p.theyAdded && !p.weAdded,
    lastSeenAt: p.lastSeenAt?.toISOString() ?? null,
    createdAt: p.createdAt.toISOString(),
  };
}

export async function federationSettings(deps: FedDeps, org: FedOrg): Promise<FederationSettings> {
  const key = await instanceKey(deps.db, deps.env.AUTH_SECRET, org.id, federationOn(org));
  const peers = await deps.db
    .select()
    .from(federationPeers)
    .where(eq(federationPeers.orgId, org.id))
    .orderBy(asc(federationPeers.domain));
  return {
    enabled: federationOn(org),
    domain: ownDomain(deps.env),
    fingerprint: key ? fingerprint(key.publicKey) : null,
    allowedDomains: allowedDomains(org),
    peers: peers.filter((p) => p.weAdded || p.theyAdded).map((p) => toPeer(org, p)),
    sharedChannels: sharedSettings(org),
  };
}

/** Merges into organizations.settings in SQL so a concurrent settings change is kept. */
async function patchSettings(deps: FedDeps, org: FedOrg, patch: Record<string, unknown>) {
  const [row] = await deps.db
    .update(organizations)
    .set({ settings: sql`${organizations.settings} || ${JSON.stringify(patch)}::jsonb` })
    .where(eq(organizations.id, org.id))
    .returning();
  if (!row) throw new AppError('not_found');
  return { id: row.id, name: row.name, settings: row.settings } satisfies FedOrg;
}

export async function updateFederation(
  deps: FedDeps,
  org: FedOrg,
  input: UpdateFederation,
  actorId: string,
  req: RequestInfo,
) {
  const patch: Record<string, unknown> = {};
  if (input.enabled !== undefined) patch.federationEnabled = input.enabled;
  if (input.allowedDomains !== undefined) {
    patch.federationAllowedDomains = [...new Set(input.allowedDomains)].sort();
  }
  if (input.sharedChannels !== undefined) {
    patch.federationSharedChannels = { ...sharedSettings(org), ...input.sharedChannels };
  }
  const next = Object.keys(patch).length ? await patchSettings(deps, org, patch) : org;
  // The key exists from the moment federation is on (the fingerprint can be read out).
  if (federationOn(next)) await instanceKey(deps.db, deps.env.AUTH_SECRET, org.id);
  await audit(
    deps.db,
    {
      orgId: org.id,
      actorId,
      action: 'federation.update',
      targetType: 'org',
      targetId: org.id,
      meta: patch,
    },
    req,
  );
  return federationSettings(deps, next);
}

/**
 * Adds (or accepts) a peer: the domain joins the allowed list, its discovery document gives
 * the key, and a signed `peer.request` tells it; when they had added us it is active at once.
 */
export async function addPeer(
  deps: Deps,
  org: FedOrg,
  domain: string,
  actorId: string,
  req: RequestInfo,
): Promise<FederationPeer> {
  requireFederation(org);
  if (domain === ownDomain(deps.env)) throw new AppError('federation_domain_self');
  let current = org;
  if (!domainAllowed(org, domain)) {
    current = await patchSettings(deps, org, {
      federationAllowedDomains: [...new Set([...allowedDomains(org), domain])].sort(),
    });
  }
  const doc = await fetchDiscovery(deps.env, domain);
  const existing = await peerByDomain(deps.db, org.id, domain);
  // A different key for a known domain needs the old peer removed first (no silent swap).
  if (existing?.publicKey && existing.publicKey !== doc.publicKey && existing.weAdded) {
    throw new AppError('conflict', { reason: 'peer_key_changed' });
  }
  const [peer] = await deps.db
    .insert(federationPeers)
    .values({
      orgId: org.id,
      domain,
      name: doc.name,
      publicKey: doc.publicKey,
      weAdded: true,
      addedBy: actorId,
    })
    .onConflictDoUpdate({
      target: [federationPeers.orgId, federationPeers.domain],
      set: { name: doc.name, publicKey: doc.publicKey, weAdded: true, updatedAt: new Date() },
    })
    .returning();
  await instanceKey(deps.db, deps.env.AUTH_SECRET, org.id);
  const answer = await postActivity(
    deps,
    org.id,
    domain,
    newActivity('peer.request', {
      name: org.name,
      instanceId: await ownInstanceId(deps.db, org.id),
    }),
  );
  let row: PeerRow = peer!;
  if (answer.status === 'active') {
    const [updated] = await deps.db
      .update(federationPeers)
      .set({ theyAdded: true, lastSeenAt: new Date(), updatedAt: new Date() })
      .where(eq(federationPeers.id, row.id))
      .returning();
    row = updated!;
  }
  if (typeof answer.instanceId === 'string' && /^[0-9a-f-]{36}$/i.test(answer.instanceId)) {
    await peerInstanceChanged(deps, current, row, answer.instanceId);
  }
  // Channel invites it holds for us (it may have sent them while we were away or reset).
  if (peerActive(current, row)) {
    await syncShares(deps, current, row).catch((err: unknown) =>
      deps.logger.warn({ err, domain }, 'shared channel sync failed'),
    );
  }
  await audit(
    deps.db,
    {
      orgId: org.id,
      actorId,
      action: 'federation.peer.add',
      targetType: 'federation_peer',
      targetId: row.id,
      meta: { domain, status: answer.status },
    },
    req,
  );
  return toPeer(current, row);
}

/** Ends federation with a peer; they are told (best effort) and their copy turns pending. */
export async function removePeer(
  deps: FedDeps,
  org: FedOrg,
  peerId: string,
  actorId: string,
  req: RequestInfo,
) {
  const [peer] = await deps.db
    .select()
    .from(federationPeers)
    .where(and(eq(federationPeers.id, peerId), eq(federationPeers.orgId, org.id)));
  if (!peer) throw new AppError('not_found');
  if (peer.weAdded && peer.theyAdded && federationOn(org)) {
    await postActivity(deps, org.id, peer.domain, newActivity('peer.remove', {})).catch(
      () => undefined,
    );
  }
  // The row stays: conversations keep pointing at it (read-only while not active).
  await deps.db
    .update(federationPeers)
    .set({ weAdded: false, theyAdded: false, updatedAt: new Date() })
    .where(eq(federationPeers.id, peer.id));
  await audit(
    deps.db,
    {
      orgId: org.id,
      actorId,
      action: 'federation.peer.remove',
      targetType: 'federation_peer',
      targetId: peer.id,
      meta: { domain: peer.domain },
    },
    req,
  );
}
