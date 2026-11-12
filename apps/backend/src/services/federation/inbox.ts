import { and, eq, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { federationInbox, federationPeers, type Db } from '@crewhall/db';
import { FederationDomain, FederationHandle } from '@crewhall/shared';
import type { Deps } from '../../deps';
import { AppError } from '../../http/errors';
import { primaryOrg } from '../brand';
import {
  DeleteActivity,
  EditActivity,
  InviteActivity,
  MembersActivity,
  MessageActivity,
  ReactionActivity,
  receiveDelete,
  receiveEdit,
  receiveInvite,
  receiveMembers,
  receiveMessage,
  receiveReaction,
} from './chat';
import {
  MAX_BODY_BYTES,
  fetchDiscovery,
  federationOn,
  ownInboxUrl,
  peerActive,
  peerByDomain,
  rateAllowed,
  type FedOrg,
  type PeerRow,
} from './core';
import { userByHandle } from './handles';
import { publicKeyObject } from './keys';
import {
  FolderItemsActivity,
  FolderRefActivity,
  FolderShareActivity,
  receiveFolderEnd,
  receiveFolderItems,
  receiveFolderShare,
} from './folders';
import {
  MeetingJoinActivity,
  MeetingStatusActivity,
  receiveMeetingJoin,
  receiveMeetingStatus,
} from './meetings';
import {
  ShareAcceptActivity,
  ShareInviteActivity,
  ShareRefActivity,
  ownInstanceId,
  peerInstanceChanged,
  receiveShareAccept,
  receiveShareClosed,
  receiveShareEnded,
  receiveShareInvite,
  receiveShareSync,
} from './shared';
import { parseSignature, SignatureError, verifyRequest } from './signature';

/**
 * POST /api/federation/v1/inbox (docs/contracts/federasyon.md › İmzalı istekler): verifies the
 * RFC 9421 signature against the peer's key, answers a replayed activity with its first
 * answer, then applies it.
 */

/** Activities one peer may send per minute (kararlar.md, shared channels). */
const INBOX_PER_MINUTE = 600;

/** Requests from domains nobody here added yet; more are refused until an admin acts. */
const MAX_OPEN_REQUESTS = 100;

async function openRequests(db: Db | Deps['db'], orgId: string) {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(federationPeers)
    .where(and(eq(federationPeers.orgId, orgId), eq(federationPeers.weAdded, false)));
  return r?.n ?? 0;
}

const Envelope = z.object({ id: z.uuid(), type: z.string().max(64) }).passthrough();

export interface InboxRequest {
  body: string;
  signatureInput: string | null;
  signature: string | null;
  contentType: string | null;
  contentDigest: string | null;
}

const invalid = () => new AppError('federation_signature_invalid');

function verifyWith(
  deps: Deps,
  req: InboxRequest,
  parsed: ReturnType<typeof parseSignature>,
  spki: string,
  url = ownInboxUrl(deps.env),
) {
  try {
    verifyRequest({
      parsed,
      method: 'POST',
      url,
      body: req.body,
      contentType: req.contentType,
      contentDigest: req.contentDigest,
      publicKey: publicKeyObject(spki),
    });
  } catch (err) {
    if (err instanceof SignatureError) throw invalid();
    throw err;
  }
}

/** Size, federation switch, signature header and envelope: what every signed request needs. */
async function readSigned(deps: Deps, req: InboxRequest) {
  if (Buffer.byteLength(req.body) > MAX_BODY_BYTES)
    throw new AppError('bad_request', { reason: 'size' });
  const org = await primaryOrg(deps.db);
  if (!org || !federationOn(org)) throw new AppError('federation_disabled');
  let parsed: ReturnType<typeof parseSignature>;
  try {
    parsed = parseSignature({ signatureInput: req.signatureInput, signature: req.signature });
  } catch {
    throw invalid();
  }
  const domain = FederationDomain.safeParse(parsed.keyId);
  if (!domain.success) throw invalid();
  let json: unknown;
  try {
    json = JSON.parse(req.body);
  } catch {
    throw new AppError('bad_request');
  }
  const env = Envelope.safeParse(json);
  if (!env.success) throw new AppError('bad_request');
  const peer = await peerByDomain(deps.db, org.id, domain.data);
  return { org, parsed, domain: domain.data, activity: env.data, json, peer };
}

/**
 * A signed request from an active peer to another endpoint than the inbox (the file pull,
 * POST /api/federation/v1/files): verified for that URL, never stored for replay.
 */
export async function verifyPeerRequest(deps: Deps, req: InboxRequest, url: string) {
  const { org, parsed, activity, json, peer } = await readSigned(deps, req);
  if (!peer?.publicKey || !peer.theyAdded) throw new AppError('federation_peer_not_active');
  verifyWith(deps, req, parsed, peer.publicKey, url);
  if (!peerActive(org, peer)) throw new AppError('federation_peer_not_active');
  return { org, peer, activity, json };
}

export async function handleInbox(deps: Deps, req: InboxRequest): Promise<Record<string, unknown>> {
  const { org, parsed, activity, json, peer, domain } = await readSigned(deps, req);

  let spki = peer?.publicKey ?? null;
  if (activity.type === 'peer.request') {
    // A key we already trust wins; otherwise the domain's discovery document vouches for it.
    if (!peer?.weAdded || !peer.publicKey) {
      if (!peer && (await openRequests(deps.db, org.id)) >= MAX_OPEN_REQUESTS) {
        throw new AppError('rate_limited', { reason: 'federation_requests' });
      }
      spki = (await fetchDiscovery(deps.env, domain)).publicKey;
    }
    verifyWith(deps, req, parsed, spki!);
  } else {
    if (!peer?.publicKey || !peer.theyAdded) throw new AppError('federation_peer_not_active');
    verifyWith(deps, req, parsed, peer.publicKey);
    if (activity.type !== 'peer.remove' && !peerActive(org, peer)) {
      throw new AppError('federation_peer_not_active');
    }
    if (!rateAllowed(`inbox:${org.id}:${domain}`, INBOX_PER_MINUTE)) {
      throw new AppError('rate_limited', { reason: 'federation_inbox' });
    }
  }

  // Replay / retry: the first answer, the activity applied once.
  const [claimed] = await deps.db
    .insert(federationInbox)
    .values({ orgId: org.id, domain, activityId: activity.id, response: {} })
    .onConflictDoNothing()
    .returning();
  if (!claimed) {
    const [first] = await deps.db
      .select({ response: federationInbox.response })
      .from(federationInbox)
      .where(
        and(
          eq(federationInbox.orgId, org.id),
          eq(federationInbox.domain, domain),
          eq(federationInbox.activityId, activity.id),
        ),
      );
    return first?.response ?? {};
  }
  try {
    const response = await apply(deps, org, domain, peer, spki, activity, json);
    await deps.db
      .update(federationInbox)
      .set({ response })
      .where(
        and(
          eq(federationInbox.orgId, org.id),
          eq(federationInbox.domain, domain),
          eq(federationInbox.activityId, activity.id),
        ),
      );
    if (peer) {
      await deps.db
        .update(federationPeers)
        .set({ lastSeenAt: new Date() })
        .where(eq(federationPeers.id, peer.id));
    }
    return response;
  } catch (err) {
    // Not applied: a retry of the same activity may try again.
    await deps.db
      .delete(federationInbox)
      .where(
        and(
          eq(federationInbox.orgId, org.id),
          eq(federationInbox.domain, domain),
          eq(federationInbox.activityId, activity.id),
        ),
      );
    throw err;
  }
}

async function apply(
  deps: Deps,
  org: FedOrg,
  domain: string,
  peer: PeerRow | null,
  spki: string | null,
  activity: z.infer<typeof Envelope>,
  json: unknown,
): Promise<Record<string, unknown>> {
  const parse = <T extends z.ZodType>(schema: T): z.infer<T> => {
    const r = schema.safeParse(json);
    if (!r.success) throw new AppError('bad_request', { type: activity.type });
    return r.data;
  };
  switch (activity.type) {
    case 'peer.request': {
      const { name, instanceId } = parse(
        z.object({
          name: z.string().max(200).nullable().optional(),
          instanceId: z.uuid().optional(),
        }),
      );
      const [row] = await deps.db
        .insert(federationPeers)
        .values({ orgId: org.id, domain, name: name ?? null, publicKey: spki, theyAdded: true })
        .onConflictDoUpdate({
          target: [federationPeers.orgId, federationPeers.domain],
          set: {
            theyAdded: true,
            name: sql`coalesce(${name ?? null}, ${federationPeers.name})`,
            publicKey: spki,
            lastSeenAt: new Date(),
            updatedAt: new Date(),
          },
        })
        .returning();
      if (instanceId) await peerInstanceChanged(deps, org, row!, instanceId);
      return {
        status: peerActive(org, row!) ? 'active' : 'pending',
        instanceId: await ownInstanceId(deps.db, org.id),
      };
    }
    case 'peer.remove': {
      await deps.db
        .update(federationPeers)
        .set({ theyAdded: false, updatedAt: new Date() })
        .where(eq(federationPeers.id, peer!.id));
      return {};
    }
    case 'user.lookup': {
      const { handle } = parse(z.object({ handle: FederationHandle }));
      const user = await userByHandle(deps.db, org.id, handle);
      if (!user) throw new AppError('federation_user_not_found');
      return { handle, name: user.name };
    }
    case 'conversation.invite':
      return receiveInvite(deps, org, peer!, parse(InviteActivity));
    case 'conversation.members':
      return receiveMembers(deps, org, peer!, parse(MembersActivity));
    case 'message.create':
      return receiveMessage(deps, org, peer!, parse(MessageActivity));
    case 'message.update':
      return receiveEdit(deps, org, peer!, parse(EditActivity));
    case 'message.delete':
      return receiveDelete(deps, org, peer!, parse(DeleteActivity));
    case 'reaction.set':
      return receiveReaction(deps, org, peer!, parse(ReactionActivity));
    case 'channel.share.invite':
      return receiveShareInvite(deps, org, peer!, parse(ShareInviteActivity));
    case 'channel.share.accept':
      return receiveShareAccept(deps, org, peer!, parse(ShareAcceptActivity));
    case 'channel.share.decline':
      return receiveShareClosed(deps, org, peer!, parse(ShareRefActivity).shareId, 'declined');
    case 'channel.share.leave':
      return receiveShareClosed(deps, org, peer!, parse(ShareRefActivity).shareId, 'left');
    case 'channel.share.remove':
      return receiveShareEnded(deps, org, peer!, parse(ShareRefActivity).shareId, 'removed');
    case 'channel.share.end':
      return receiveShareEnded(deps, org, peer!, parse(ShareRefActivity).shareId, 'ended');
    case 'channel.share.sync':
      return receiveShareSync(deps, org, peer!);
    case 'folder.share':
      return receiveFolderShare(deps, org, peer!, parse(FolderShareActivity));
    case 'folder.items':
      return receiveFolderItems(deps, org, peer!, parse(FolderItemsActivity));
    case 'folder.end':
      return receiveFolderEnd(deps, org, peer!, parse(FolderRefActivity));
    case 'meeting.status':
      return receiveMeetingStatus(deps, org, peer!, parse(MeetingStatusActivity));
    case 'meeting.join':
      return receiveMeetingJoin(deps, org, peer!, parse(MeetingJoinActivity));
    default:
      throw new AppError('bad_request', { type: activity.type });
  }
}

/** Nightly: answers older than a day are no longer needed for replay protection. */
export async function purgeFederationInbox(db: Db) {
  await db
    .delete(federationInbox)
    .where(lt(federationInbox.receivedAt, new Date(Date.now() - 24 * 60 * 60 * 1000)));
}
