import { eq } from 'drizzle-orm';
import { organizations } from '@crewhall/db';
import type { JobDeps } from '../../jobs/handlers';
import type { JobPayloads } from '../../jobs/queue';
import { AppError } from '../../http/errors';
import { federationOn, peerActive, peerByDomain, postActivity } from './core';

/**
 * federation.deliver: posts one queued activity. A peer that is no longer active (removed,
 * federation off) drops it; a peer that is down throws so pg-boss retries with backoff.
 */
export async function deliverActivity(deps: JobDeps, data: JobPayloads['federation.deliver']) {
  const [org] = await deps.db
    .select({ id: organizations.id, name: organizations.name, settings: organizations.settings })
    .from(organizations)
    .where(eq(organizations.id, data.orgId));
  if (!org || !federationOn(org)) return;
  const peer = await peerByDomain(deps.db, org.id, data.domain);
  if (!peer || !peerActive(org, peer)) return;
  try {
    await postActivity(deps, org.id, data.domain, data.activity);
  } catch (err) {
    // The peer answered and refused (not a member, unknown conversation): retrying won't help.
    // "Not active" may be the moment between their peer.request and our answer: retried.
    if (
      err instanceof AppError &&
      err.code !== 'federation_peer_unreachable' &&
      err.code !== 'federation_peer_not_active'
    ) {
      deps.logger.warn(
        { err, domain: data.domain, type: data.activity.type },
        'federation activity refused',
      );
      return;
    }
    throw err;
  }
}
