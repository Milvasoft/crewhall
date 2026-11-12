import { and, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import {
  conversations,
  federationConversations,
  federationMembers,
  federationPeers,
  federationSharedChannels,
  federationUsers,
  meetings,
  orgMembers,
  organizations,
  type DbOrTx,
} from '@crewhall/db';
import { MeetingConnection, type SharedMeeting, type SharedMeetingJoin } from '@crewhall/shared';
import type { Deps } from '../../deps';
import { AppError } from '../../http/errors';
import { audit } from '../audit';
import { requireMember, type ChatActor, type ConversationRow } from '../chat/access';
import { publishConversation } from '../chat/conversations';
import { liveSession } from '../meet/access';
import { federatedGuestJoin } from '../meet/join';
import { toActor } from '../membership';
import { localPerson } from './chat';
import {
  newActivity,
  ownDomain,
  peerActive,
  postActivity,
  rateAllowed,
  splitAddress,
  type FedJobDeps,
  type FedOrg,
  type PeerRow,
} from './core';
import { peerById } from './files';

/**
 * Shared channels 2 › shared meetings (kararlar.md, federasyon.md › Paylaşılan kanallar 2):
 * the host's channel meeting, joined by people of the guest organizations as guests on the
 * host's LiveKit. Guests learn when it goes on and off (`meeting.status`); the meeting, its
 * recording and history stay with the host.
 */

/** `meeting.join` per peer per minute. */
const JOINS_PER_MINUTE = 30;

export const MeetingStatusActivity = z.object({
  /** The receiver's copy of the channel. */
  conversationId: z.uuid(),
  meeting: z.object({ title: z.string().max(200), startedAt: z.string().max(40) }).nullable(),
});
// Same shape as chat.ts › Person; declared here because chat.ts loads this module first.
const Person = z.object({ address: z.string().max(320), name: z.string().max(200) });
export const MeetingJoinActivity = z.object({ conversationId: z.uuid(), from: Person });

/** The host's channel meeting of a conversation (one room per conversation). */
async function channelMeeting(db: DbOrTx, orgId: string, conversationId: string) {
  const [row] = await db
    .select()
    .from(meetings)
    .where(
      and(
        eq(meetings.orgId, orgId),
        eq(meetings.conversationId, conversationId),
        eq(meetings.kind, 'chat'),
        isNull(meetings.cancelledAt),
      ),
    );
  return row ?? null;
}

/** Active guests of a host channel, with their copy's id. */
async function guestsOf(deps: Pick<FedJobDeps, 'db'>, org: FedOrg, conversationId: string) {
  const rows = await deps.db
    .select({ peer: federationPeers, link: federationConversations })
    .from(federationSharedChannels)
    .innerJoin(federationPeers, eq(federationPeers.id, federationSharedChannels.peerId))
    .innerJoin(
      federationConversations,
      and(
        eq(federationConversations.conversationId, federationSharedChannels.conversationId),
        eq(federationConversations.peerId, federationSharedChannels.peerId),
      ),
    )
    .where(
      and(
        eq(federationSharedChannels.conversationId, conversationId),
        eq(federationSharedChannels.role, 'host'),
        eq(federationSharedChannels.status, 'active'),
      ),
    );
  return rows.filter((r) => peerActive(org, r.peer) && r.link.remoteConversationId);
}

/**
 * Called when a channel meeting starts or ends (meet/chat-bridge.ts): its shared channels'
 * guests are told. Best effort; a guest that misses it catches up on the next change.
 */
export async function federateMeetingStatus(
  deps: Pick<FedJobDeps, 'db' | 'env' | 'jobs'>,
  orgId: string,
  conversationIds: string[],
  meeting: { title: string; startedAt: Date } | null,
) {
  const [org] = await deps.db
    .select({ id: organizations.id, name: organizations.name, settings: organizations.settings })
    .from(organizations)
    .where(eq(organizations.id, orgId));
  if (!org) return;
  for (const conversationId of conversationIds) {
    for (const g of await guestsOf(deps, org, conversationId)) {
      await deps.jobs.send('federation.deliver', {
        orgId,
        domain: g.peer.domain,
        activity: newActivity('meeting.status', {
          conversationId: g.link.remoteConversationId,
          meeting: meeting
            ? { title: meeting.title, startedAt: meeting.startedAt.toISOString() }
            : null,
        }),
      });
    }
  }
}

/** federation.share_joined: a guest that just accepted hears about a meeting going on. */
export async function meetingStatusTo(
  deps: FedJobDeps,
  org: FedOrg,
  conversationId: string,
  peer: PeerRow,
) {
  const m = await channelMeeting(deps.db, org.id, conversationId);
  const session = m ? await liveSession(deps.db, m.id) : null;
  if (!m || !session) return;
  const [link] = await deps.db
    .select({ remote: federationConversations.remoteConversationId })
    .from(federationConversations)
    .where(
      and(
        eq(federationConversations.conversationId, conversationId),
        eq(federationConversations.peerId, peer.id),
      ),
    );
  if (!link?.remote) return;
  await deps.jobs.send('federation.deliver', {
    orgId: org.id,
    domain: peer.domain,
    activity: newActivity('meeting.status', {
      conversationId: link.remote,
      meeting: { title: m.title, startedAt: session.startedAt.toISOString() },
    }),
  });
}

/** Members of the channel copy see the banner change at once. */
async function republish(deps: FedJobDeps, conv: ConversationRow) {
  const [org] = await deps.db.select().from(organizations).where(eq(organizations.id, conv.orgId));
  const [member] = await deps.db
    .select()
    .from(orgMembers)
    .where(eq(orgMembers.organizationId, conv.orgId))
    .limit(1);
  if (!org || !member) return;
  await publishConversation(deps, { org, actor: toActor(member), userId: member.userId }, conv);
}

/** `meeting.status` on a guest: kept on the share row (Conversation.federation.meeting). */
export async function receiveMeetingStatus(
  deps: FedJobDeps,
  org: FedOrg,
  peer: PeerRow,
  input: z.infer<typeof MeetingStatusActivity>,
) {
  const [share] = await deps.db
    .select()
    .from(federationSharedChannels)
    .where(
      and(
        eq(federationSharedChannels.orgId, org.id),
        eq(federationSharedChannels.peerId, peer.id),
        eq(federationSharedChannels.conversationId, input.conversationId),
        eq(federationSharedChannels.role, 'guest'),
        eq(federationSharedChannels.status, 'active'),
      ),
    );
  if (!share) throw new AppError('federation_not_allowed', { reason: 'not_shared' });
  const startedAt = input.meeting ? new Date(input.meeting.startedAt) : null;
  await deps.db
    .update(federationSharedChannels)
    .set({
      meetingTitle: input.meeting?.title ?? null,
      meetingStartedAt: startedAt && !Number.isNaN(startedAt.getTime()) ? startedAt : null,
      updatedAt: new Date(),
    })
    .where(eq(federationSharedChannels.id, share.id));
  const [conv] = await deps.db
    .select()
    .from(conversations)
    .where(eq(conversations.id, input.conversationId));
  if (conv) await republish(deps, conv);
  return {};
}

/** Conversation.federation.meeting for a page of guest copies. */
export async function meetingsOf(db: DbOrTx, ids: string[]) {
  const out = new Map<string, SharedMeeting>();
  if (ids.length === 0) return out;
  const rows = await db
    .select({ share: federationSharedChannels, domain: federationPeers.domain })
    .from(federationSharedChannels)
    .innerJoin(federationPeers, eq(federationPeers.id, federationSharedChannels.peerId))
    .where(
      and(
        inArray(federationSharedChannels.conversationId, ids),
        eq(federationSharedChannels.role, 'guest'),
        eq(federationSharedChannels.status, 'active'),
      ),
    );
  for (const r of rows) {
    if (!r.share.conversationId || !r.share.meetingStartedAt) continue;
    out.set(r.share.conversationId, {
      title: r.share.meetingTitle ?? '',
      startedAt: r.share.meetingStartedAt.toISOString(),
      domain: r.domain,
    });
  }
  return out;
}

/** Guest side: joins the host's channel meeting through this installation. */
export async function joinSharedMeeting(
  deps: FedJobDeps,
  a: ChatActor,
  conversationId: string,
): Promise<SharedMeetingJoin> {
  if (a.actor.orgRole === 'guest') throw new AppError('forbidden');
  const m = await requireMember(deps.db, a, conversationId);
  const [share] = await deps.db
    .select()
    .from(federationSharedChannels)
    .where(
      and(
        eq(federationSharedChannels.orgId, a.org.id),
        eq(federationSharedChannels.conversationId, m.conv.id),
        eq(federationSharedChannels.role, 'guest'),
        eq(federationSharedChannels.status, 'active'),
      ),
    );
  if (!share?.remoteConversationId) {
    throw new AppError('federation_not_allowed', { reason: 'not_shared' });
  }
  const peer = await peerById(deps.db, share.peerId);
  if (!peer || !peerActive(a.org, peer)) throw new AppError('federation_peer_not_active');
  const from = await localPerson(deps, a.org.id, a.userId);
  const answer = await postActivity(
    deps,
    a.org.id,
    peer.domain,
    newActivity('meeting.join', { conversationId: share.remoteConversationId, from }),
  );
  const parsed = z.object({ title: z.string(), connection: MeetingConnection }).safeParse(answer);
  if (!parsed.success) throw new AppError('federation_peer_unreachable', { domain: peer.domain });
  await audit(deps.db, {
    orgId: a.org.id,
    actorId: a.userId,
    action: 'federation.meeting.join',
    targetType: 'conversation',
    targetId: m.conv.id,
    meta: { domain: peer.domain },
  });
  return { title: parsed.data.title, domain: peer.domain, connection: parsed.data.connection };
}

/**
 * `meeting.join` on the host: a person of a guest organization with an active share, not
 * blocked in the channel, gets a guest connection to the channel meeting.
 */
export async function receiveMeetingJoin(
  deps: Deps,
  org: FedOrg,
  peer: PeerRow,
  input: z.infer<typeof MeetingJoinActivity>,
) {
  if (!rateAllowed(`meet:${org.id}:${peer.domain}`, JOINS_PER_MINUTE)) {
    throw new AppError('rate_limited', { reason: 'federation_meeting_join' });
  }
  const { handle, domain } = splitAddress(input.from.address);
  if (domain !== peer.domain) throw new AppError('federation_not_allowed', { reason: 'author' });
  const [link] = await deps.db
    .select()
    .from(federationConversations)
    .where(
      and(
        eq(federationConversations.peerId, peer.id),
        eq(federationConversations.conversationId, input.conversationId),
      ),
    );
  if (!link || link.homeDomain !== ownDomain(deps.env)) throw new AppError('not_found');
  const [share] = await deps.db
    .select({ id: federationSharedChannels.id })
    .from(federationSharedChannels)
    .where(
      and(
        eq(federationSharedChannels.conversationId, input.conversationId),
        eq(federationSharedChannels.peerId, peer.id),
        eq(federationSharedChannels.role, 'host'),
        eq(federationSharedChannels.status, 'active'),
      ),
    );
  if (!share) throw new AppError('federation_not_allowed', { reason: 'not_shared' });
  const [blocked] = await deps.db
    .select({ at: federationMembers.blockedAt })
    .from(federationMembers)
    .innerJoin(federationUsers, eq(federationUsers.id, federationMembers.remoteUserId))
    .where(
      and(
        eq(federationMembers.conversationId, input.conversationId),
        eq(federationUsers.peerId, peer.id),
        eq(federationUsers.handle, handle),
      ),
    );
  if (blocked?.at) throw new AppError('federation_not_allowed', { reason: 'blocked' });
  const meeting = await channelMeeting(deps.db, org.id, input.conversationId);
  if (!meeting) throw new AppError('not_found');
  const connection = await federatedGuestJoin(
    deps,
    meeting,
    `${input.from.name} · ${peer.name ?? peer.domain}`,
  );
  await audit(deps.db, {
    orgId: org.id,
    actorId: null,
    action: 'federation.meeting.join',
    targetType: 'meeting',
    targetId: meeting.id,
    meta: { address: input.from.address },
  });
  return { title: meeting.title, connection };
}
