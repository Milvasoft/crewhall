import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  conversations,
  federationConversations,
  federationKeys,
  federationMembers,
  federationPeers,
  federationSharedChannels,
  federationUsers,
  organizations,
  spaces,
  users,
  type DbOrTx,
} from '@crewhall/db';
import type {
  AcceptSharedChannel,
  ConversationShare,
  SharedChannel,
  SharedChannelSettings,
} from '@crewhall/shared';
import { AppError } from '../../http/errors';
import type { RequestInfo } from '../../http/types';
import { audit } from '../audit';
import {
  loadConversation,
  requireMember,
  requirePermission,
  spaceBound,
  type ChatActor,
  type ConversationRow,
} from '../chat/access';
import { appendSystem, publishMessage } from '../chat/messages';
import {
  newActivity,
  ownDomain,
  peerActive,
  postActivity,
  requireActivePeer,
  requireFederation,
  type FedJobDeps,
  type FedOrg,
  type PeerRow,
} from './core';
import { endGuestFolders, offerFoldersTo } from './folders';
import { meetingStatusTo } from './meetings';

/**
 * Shared channels (kararlar.md 2026-10-29, federasyon.md › Paylaşılan kanallar): a space
 * channel shared with whole organizations. The host relays messages like any federated
 * conversation (federation_conversations links); this file keeps the share's life cycle.
 */

type ShareRow = typeof federationSharedChannels.$inferSelect;

const INVITE_DAYS = 7;
/** Open invites one peer may have with us at a time (either direction). */
const MAX_OPEN_INVITES = 20;

export function sharedSettings(org: FedOrg): SharedChannelSettings {
  const s = org.settings.federationSharedChannels ?? {};
  return {
    enabled: s.enabled === true,
    whoCanInvite: s.whoCanInvite ?? 'admins',
    maxFileMb: s.maxFileMb ?? 25,
  };
}

export function requireShared(org: FedOrg) {
  requireFederation(org);
  if (!sharedSettings(org).enabled) throw new AppError('federation_shared_channels_disabled');
}

export const isAdmin = (a: ChatActor) => a.actor.orgRole === 'owner' || a.actor.orgRole === 'admin';

function requireAdmin(a: ChatActor) {
  if (!isAdmin(a)) throw new AppError('forbidden');
}

const inviteExpiry = () => new Date(Date.now() + INVITE_DAYS * 24 * 60 * 60 * 1000);
const open = (s: ShareRow) => s.status === 'invited' || s.status === 'pending';

function toShare(row: ShareRow, peer: Pick<PeerRow, 'domain' | 'name'>): SharedChannel {
  return {
    id: row.id,
    role: row.role,
    status: row.status,
    domain: peer.domain,
    orgName: peer.name,
    conversationId: row.conversationId,
    channelName: row.channelName,
    invitedBy: row.invitedBy,
    expiresAt: open(row) ? (row.expiresAt?.toISOString() ?? null) : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function sharesWhere(db: DbOrTx, where: ReturnType<typeof and>) {
  return db
    .select({ share: federationSharedChannels, peer: federationPeers })
    .from(federationSharedChannels)
    .innerJoin(federationPeers, eq(federationPeers.id, federationSharedChannels.peerId))
    .where(where)
    .orderBy(desc(federationSharedChannels.createdAt));
}

async function loadShare(db: DbOrTx, orgId: string, id: string) {
  const [row] = await sharesWhere(
    db,
    and(eq(federationSharedChannels.orgId, orgId), eq(federationSharedChannels.id, id)),
  );
  if (!row) throw new AppError('not_found');
  return row;
}

async function setStatus(db: DbOrTx, id: string, status: ShareRow['status'], extra = {}) {
  const [row] = await db
    .update(federationSharedChannels)
    .set({ status, updatedAt: new Date(), ...extra })
    .where(eq(federationSharedChannels.id, id))
    .returning();
  return row!;
}

/** Invites past their date close on the next read. */
async function expireInvites(db: DbOrTx, orgId: string) {
  await db
    .update(federationSharedChannels)
    .set({ status: 'expired', updatedAt: new Date() })
    .where(
      and(
        eq(federationSharedChannels.orgId, orgId),
        inArray(federationSharedChannels.status, ['invited', 'pending']),
        lt(federationSharedChannels.expiresAt, new Date()),
      ),
    );
}

async function openInvites(db: DbOrTx, orgId: string, peerId: string) {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(federationSharedChannels)
    .where(
      and(
        eq(federationSharedChannels.orgId, orgId),
        eq(federationSharedChannels.peerId, peerId),
        inArray(federationSharedChannels.status, ['invited', 'pending']),
      ),
    );
  return r?.n ?? 0;
}

/** Stops the message flow with one peer for one conversation; the history stays. */
async function unlink(db: DbOrTx, conversationId: string, peerId: string) {
  await db
    .delete(federationConversations)
    .where(
      and(
        eq(federationConversations.conversationId, conversationId),
        eq(federationConversations.peerId, peerId),
      ),
    );
  // Their people are no longer in the channel.
  await db.execute(sql`
    delete from ${federationMembers} m using ${federationUsers} u
    where m.remote_user_id = u.id and u.peer_id = ${peerId}::uuid
      and m.conversation_id = ${conversationId}::uuid`);
}

/** The guest copy after the share closed: read-only, with a line saying why. */
async function archiveCopy(deps: FedJobDeps, orgId: string, conversationId: string | null) {
  if (!conversationId) return;
  const conv = await loadConversation(deps.db, orgId, conversationId).catch(() => null);
  if (!conv || conv.archivedAt) return;
  await deps.db
    .update(conversations)
    .set({ archivedAt: new Date() })
    .where(eq(conversations.id, conv.id));
  const line = await appendSystem(deps.db, conv, { type: 'archived', actorId: null });
  await publishMessage(deps, { ...conv, archivedAt: new Date() }, 'message.created', line);
}

const inviteActivity = (row: ShareRow, conv: ConversationRow) =>
  newActivity('channel.share.invite', {
    share: {
      id: row.hostShareId,
      conversationId: conv.id,
      name: row.channelName,
      invitedBy: row.invitedBy,
      expiresAt: row.expiresAt?.toISOString() ?? null,
    },
  });

// ---- Local actions ----

/** Yönetim › Federasyon › Paylaşılan kanallar. */
export async function listSharedChannels(deps: FedJobDeps, a: ChatActor) {
  requireAdmin(a);
  await expireInvites(deps.db, a.org.id);
  const rows = await sharesWhere(deps.db, and(eq(federationSharedChannels.orgId, a.org.id)));
  return { items: rows.map((r) => toShare(r.share, r.peer)) };
}

/** The shares of one channel, for its members. */
export async function listConversationShares(
  deps: FedJobDeps,
  a: ChatActor,
  conversationId: string,
) {
  await requireMember(deps.db, a, conversationId);
  await expireInvites(deps.db, a.org.id);
  const rows = await sharesWhere(
    deps.db,
    and(
      eq(federationSharedChannels.orgId, a.org.id),
      eq(federationSharedChannels.conversationId, conversationId),
    ),
  );
  return { items: rows.map((r) => toShare(r.share, r.peer)) };
}

/** Host side: org admins always; the channel's managers when the org allows it. */
export function requireInviter(
  a: ChatActor,
  m: Awaited<ReturnType<typeof requireMember>>,
  org: FedOrg,
) {
  if (isAdmin(a)) return;
  if (sharedSettings(org).whoCanInvite !== 'managers') throw new AppError('forbidden');
  requirePermission(a, m, 'manage');
}

/** "Kurumla paylaş": invites an active peer organization into a space channel. */
export async function shareChannel(
  deps: FedJobDeps,
  a: ChatActor,
  conversationId: string,
  domain: string,
  req: RequestInfo,
): Promise<SharedChannel> {
  requireShared(a.org);
  if (a.actor.orgRole === 'guest') throw new AppError('forbidden');
  const m = await requireMember(deps.db, a, conversationId);
  requireInviter(a, m, a.org);
  const conv = m.conv;
  if (conv.type !== 'space' || !spaceBound(conv) || conv.archivedAt) {
    throw new AppError('federation_not_allowed', { reason: 'type' });
  }
  const links = await deps.db
    .select()
    .from(federationConversations)
    .where(eq(federationConversations.conversationId, conv.id));
  if (links.some((l) => l.homeDomain !== ownDomain(deps.env))) {
    throw new AppError('federation_not_allowed', { reason: 'not_home' });
  }
  const peer = await requireActivePeer(deps, a.org, domain);
  await expireInvites(deps.db, a.org.id);
  const [current] = await deps.db
    .select()
    .from(federationSharedChannels)
    .where(
      and(
        eq(federationSharedChannels.conversationId, conv.id),
        eq(federationSharedChannels.peerId, peer.id),
        inArray(federationSharedChannels.status, ['invited', 'active']),
      ),
    );
  if (current) return toShare(current, peer);
  // Remote people of that installation were added one by one: one kind of link per peer.
  if (links.some((l) => l.peerId === peer.id)) {
    throw new AppError('federation_not_allowed', { reason: 'already_linked' });
  }
  if ((await openInvites(deps.db, a.org.id, peer.id)) >= MAX_OPEN_INVITES) {
    throw new AppError('rate_limited', { reason: 'shared_channel_invites' });
  }
  const [me] = await deps.db.select({ name: users.name }).from(users).where(eq(users.id, a.userId));
  const id = crypto.randomUUID();
  const [row] = await deps.db
    .insert(federationSharedChannels)
    .values({
      id,
      orgId: a.org.id,
      peerId: peer.id,
      role: 'host',
      status: 'invited',
      hostShareId: id,
      conversationId: conv.id,
      channelName: conv.name ?? '',
      invitedBy: me?.name ?? null,
      invitedById: a.userId,
      expiresAt: inviteExpiry(),
    })
    .returning();
  try {
    await postActivity(deps, a.org.id, peer.domain, inviteActivity(row!, conv));
  } catch (err) {
    await deps.db.delete(federationSharedChannels).where(eq(federationSharedChannels.id, id));
    throw err;
  }
  await audit(
    deps.db,
    {
      orgId: a.org.id,
      actorId: a.userId,
      action: 'federation.share.invite',
      targetType: 'conversation',
      targetId: conv.id,
      meta: { domain: peer.domain, shareId: id },
    },
    req,
  );
  // An auto-accepting peer may have answered already.
  const [fresh] = await deps.db
    .select()
    .from(federationSharedChannels)
    .where(eq(federationSharedChannels.id, id));
  return toShare(fresh!, peer);
}

/**
 * Guest side: the invite becomes a channel of `spaceId`. `actorId` is null for an automatic
 * accept (FEDERATION_AUTO_ACCEPT_DOMAINS).
 */
async function acceptShare(
  deps: FedJobDeps,
  org: FedOrg,
  share: ShareRow,
  peer: PeerRow,
  input: AcceptSharedChannel,
  actorId: string | null,
) {
  if (share.role !== 'guest' || share.status !== 'pending' || !share.remoteConversationId) {
    throw new AppError('federation_share_closed');
  }
  if (share.expiresAt && share.expiresAt < new Date()) {
    await setStatus(deps.db, share.id, 'expired');
    throw new AppError('federation_share_closed');
  }
  if (!peerActive(org, peer)) throw new AppError('federation_peer_not_active');
  const [space] = await deps.db
    .select({ id: spaces.id, kind: spaces.kind })
    .from(spaces)
    .where(and(eq(spaces.id, input.spaceId), eq(spaces.orgId, org.id)));
  if (!space || space.kind === 'personal') throw new AppError('invalid_target');
  const name = (input.name ?? share.channelName).slice(0, 80) || peer.domain;
  const [conv] = await deps.db
    .insert(conversations)
    .values({ orgId: org.id, type: 'space', spaceId: space.id, name, createdBy: actorId })
    .returning();
  try {
    await deps.db.insert(federationConversations).values({
      conversationId: conv!.id,
      peerId: peer.id,
      orgId: org.id,
      remoteConversationId: share.remoteConversationId,
      homeDomain: peer.domain,
    });
    await postActivity(
      deps,
      org.id,
      peer.domain,
      newActivity('channel.share.accept', {
        shareId: share.hostShareId,
        conversationId: conv!.id,
      }),
    );
  } catch (err) {
    await deps.db.delete(conversations).where(eq(conversations.id, conv!.id));
    throw err;
  }
  const row = await setStatus(deps.db, share.id, 'active', {
    conversationId: conv!.id,
    acceptedById: actorId,
  });
  const line = await appendSystem(deps.db, conv!, { type: 'created', actorId, name });
  await publishMessage(deps, conv!, 'message.created', line);
  await audit(deps.db, {
    orgId: org.id,
    actorId,
    action: 'federation.share.accept',
    targetType: 'conversation',
    targetId: conv!.id,
    meta: { domain: peer.domain, shareId: share.id },
  });
  return row;
}

export async function acceptSharedChannel(
  deps: FedJobDeps,
  a: ChatActor,
  shareId: string,
  input: AcceptSharedChannel,
): Promise<SharedChannel> {
  requireAdmin(a);
  requireShared(a.org);
  const { share, peer } = await loadShare(deps.db, a.org.id, shareId);
  const row = await acceptShare(deps, a.org, share, peer, input, a.userId);
  return toShare(row, peer);
}

export async function declineSharedChannel(
  deps: FedJobDeps,
  a: ChatActor,
  shareId: string,
): Promise<SharedChannel> {
  requireAdmin(a);
  const { share, peer } = await loadShare(deps.db, a.org.id, shareId);
  if (share.role !== 'guest' || share.status !== 'pending') {
    throw new AppError('federation_share_closed');
  }
  const row = await setStatus(deps.db, share.id, 'declined');
  await tell(deps, a.org.id, peer, 'channel.share.decline', share.hostShareId);
  await audit(deps.db, {
    orgId: a.org.id,
    actorId: a.userId,
    action: 'federation.share.decline',
    targetType: 'federation_share',
    targetId: share.id,
    meta: { domain: peer.domain },
  });
  return toShare(row, peer);
}

async function tell(deps: FedJobDeps, orgId: string, peer: PeerRow, type: string, shareId: string) {
  await deps.jobs.send('federation.deliver', {
    orgId,
    domain: peer.domain,
    activity: newActivity(type, { shareId }),
  });
}

/**
 * Host: takes the organization out (or withdraws the invite); guest: leaves (or declines).
 * The side that loses the channel keeps it as a read-only archive.
 */
export async function endSharedChannel(
  deps: FedJobDeps,
  a: ChatActor,
  shareId: string,
): Promise<SharedChannel> {
  const { share, peer } = await loadShare(deps.db, a.org.id, shareId);
  if (share.role === 'host') {
    if (!isAdmin(a)) {
      if (!share.conversationId) throw new AppError('forbidden');
      requireInviter(a, await requireMember(deps.db, a, share.conversationId), a.org);
    }
  } else {
    requireAdmin(a);
  }
  if (share.role === 'guest' && share.status === 'pending') {
    return declineSharedChannel(deps, a, shareId);
  }
  if (share.status !== 'invited' && share.status !== 'active') {
    throw new AppError('federation_share_closed');
  }
  const status = share.role === 'host' ? 'removed' : 'left';
  const row = await setStatus(deps.db, share.id, status);
  if (share.conversationId) await unlink(deps.db, share.conversationId, peer.id);
  if (share.role === 'guest' && share.conversationId) {
    await endGuestFolders(deps.db, a.org.id, share.conversationId);
    await archiveCopy(deps, a.org.id, share.conversationId);
  }
  await tell(
    deps,
    a.org.id,
    peer,
    share.role === 'host' ? 'channel.share.remove' : 'channel.share.leave',
    share.hostShareId,
  );
  await audit(deps.db, {
    orgId: a.org.id,
    actorId: a.userId,
    action: `federation.share.${status === 'removed' ? 'remove' : 'leave'}`,
    targetType: 'federation_share',
    targetId: share.id,
    meta: { domain: peer.domain },
  });
  return toShare(row, peer);
}

/** Host channel archived or deleted: every share of it ends (called by the chat service). */
export async function endSharesOf(deps: FedJobDeps, orgId: string, conversationId: string) {
  const rows = await deps.db
    .select({ share: federationSharedChannels, peer: federationPeers })
    .from(federationSharedChannels)
    .innerJoin(federationPeers, eq(federationPeers.id, federationSharedChannels.peerId))
    .where(
      and(
        eq(federationSharedChannels.orgId, orgId),
        eq(federationSharedChannels.conversationId, conversationId),
        eq(federationSharedChannels.role, 'host'),
        inArray(federationSharedChannels.status, ['invited', 'active']),
      ),
    );
  for (const { share, peer } of rows) {
    await setStatus(deps.db, share.id, 'ended');
    await unlink(deps.db, conversationId, peer.id);
    await tell(deps, orgId, peer, 'channel.share.end', share.hostShareId);
  }
}

/** Blocks (or unblocks) a remote person in a channel: their messages and reactions stop here. */
export async function blockRemoteMember(
  deps: FedJobDeps,
  a: ChatActor,
  conversationId: string,
  address: string,
  blocked: boolean,
) {
  const m = await requireMember(deps.db, a, conversationId);
  requirePermission(a, m, 'manage');
  const at = address.lastIndexOf('@');
  const [member] = await deps.db
    .select({ remoteUserId: federationMembers.remoteUserId })
    .from(federationMembers)
    .innerJoin(federationUsers, eq(federationUsers.id, federationMembers.remoteUserId))
    .innerJoin(federationPeers, eq(federationPeers.id, federationUsers.peerId))
    .where(
      and(
        eq(federationMembers.conversationId, conversationId),
        eq(federationUsers.handle, address.slice(0, at)),
        eq(federationPeers.domain, address.slice(at + 1)),
      ),
    );
  if (!member) throw new AppError('federation_user_not_found');
  await deps.db
    .update(federationMembers)
    .set({ blockedAt: blocked ? new Date() : null })
    .where(
      and(
        eq(federationMembers.conversationId, conversationId),
        eq(federationMembers.remoteUserId, member.remoteUserId),
      ),
    );
  await audit(deps.db, {
    orgId: a.org.id,
    actorId: a.userId,
    action: blocked ? 'federation.member.block' : 'federation.member.unblock',
    targetType: 'conversation',
    targetId: conversationId,
    meta: { address },
  });
  return m.conv;
}

// ---- Inbound ----

const InviteShape = z.object({
  id: z.uuid(),
  conversationId: z.uuid(),
  name: z.string().max(200),
  invitedBy: z.string().max(200).nullable(),
  expiresAt: z.string().max(40).nullable(),
});

export const ShareInviteActivity = z.object({ share: InviteShape });
export const ShareRefActivity = z.object({ shareId: z.uuid() });
export const ShareAcceptActivity = z.object({ shareId: z.uuid(), conversationId: z.uuid() });

const autoAccepts = (deps: FedJobDeps, peer: PeerRow) =>
  deps.env.FEDERATION_AUTO_ACCEPT_DOMAINS.includes(peer.domain);

/** Guest side: an invite waits for an admin (or is accepted at once for trusted test peers). */
async function storeInvite(
  deps: FedJobDeps,
  org: FedOrg,
  peer: PeerRow,
  invite: z.infer<typeof InviteShape>,
) {
  const [known] = await deps.db
    .select()
    .from(federationSharedChannels)
    .where(
      and(
        eq(federationSharedChannels.orgId, org.id),
        eq(federationSharedChannels.peerId, peer.id),
        eq(federationSharedChannels.hostShareId, invite.id),
      ),
    );
  if (known && (known.status === 'active' || known.status === 'pending')) return known;
  if (!known && (await openInvites(deps.db, org.id, peer.id)) >= MAX_OPEN_INVITES) {
    throw new AppError('rate_limited', { reason: 'shared_channel_invites' });
  }
  const expires = invite.expiresAt ? new Date(invite.expiresAt) : inviteExpiry();
  const values = {
    status: 'pending' as const,
    remoteConversationId: invite.conversationId,
    channelName: invite.name.slice(0, 200),
    invitedBy: invite.invitedBy?.slice(0, 200) ?? null,
    expiresAt:
      Number.isNaN(expires.getTime()) || expires > inviteExpiry() ? inviteExpiry() : expires,
    updatedAt: new Date(),
  };
  const [row] = known
    ? await deps.db
        .update(federationSharedChannels)
        .set({ ...values, conversationId: null })
        .where(eq(federationSharedChannels.id, known.id))
        .returning()
    : await deps.db
        .insert(federationSharedChannels)
        .values({
          orgId: org.id,
          peerId: peer.id,
          role: 'guest',
          hostShareId: invite.id,
          ...values,
        })
        .returning();
  return row!;
}

/** The org's default space takes automatically accepted channels. */
async function defaultSpaceId(db: DbOrTx, orgId: string) {
  const [s] = await db
    .select({ id: spaces.id })
    .from(spaces)
    .where(and(eq(spaces.orgId, orgId), eq(spaces.isDefault, true)))
    .limit(1);
  return s?.id ?? null;
}

export async function receiveShareInvite(
  deps: FedJobDeps,
  org: FedOrg,
  peer: PeerRow,
  input: z.infer<typeof ShareInviteActivity>,
) {
  requireShared(org);
  const row = await storeInvite(deps, org, peer, input.share);
  if (row.status === 'pending' && autoAccepts(deps, peer)) {
    await deps.jobs.send('federation.share_accept', { orgId: org.id, shareId: row.id });
  }
  return { status: row.status };
}

/** federation.share_accept: the automatic accept, after the invite was answered. */
export async function autoAcceptShare(deps: FedJobDeps, data: { orgId: string; shareId: string }) {
  const [row] = await sharesWhere(
    deps.db,
    and(
      eq(federationSharedChannels.orgId, data.orgId),
      eq(federationSharedChannels.id, data.shareId),
    ),
  );
  if (!row || row.share.status !== 'pending') return;
  const [org] = await deps.db
    .select({ id: organizations.id, name: organizations.name, settings: organizations.settings })
    .from(organizations)
    .where(eq(organizations.id, data.orgId));
  if (!org) return;
  const spaceId = await defaultSpaceId(deps.db, org.id);
  if (!spaceId) return;
  await acceptShare(deps, org, row.share, row.peer, { spaceId }, null);
}

async function hostShare(deps: FedJobDeps, org: FedOrg, peer: PeerRow, shareId: string) {
  const [row] = await deps.db
    .select()
    .from(federationSharedChannels)
    .where(
      and(
        eq(federationSharedChannels.orgId, org.id),
        eq(federationSharedChannels.peerId, peer.id),
        eq(federationSharedChannels.id, shareId),
        eq(federationSharedChannels.role, 'host'),
      ),
    );
  if (!row) throw new AppError('not_found');
  return row;
}

async function guestShare(deps: FedJobDeps, org: FedOrg, peer: PeerRow, hostShareId: string) {
  const [row] = await deps.db
    .select()
    .from(federationSharedChannels)
    .where(
      and(
        eq(federationSharedChannels.orgId, org.id),
        eq(federationSharedChannels.peerId, peer.id),
        eq(federationSharedChannels.hostShareId, hostShareId),
        eq(federationSharedChannels.role, 'guest'),
      ),
    );
  return row ?? null;
}

/** Host side: the guest accepted; messages flow from now on. */
export async function receiveShareAccept(
  deps: FedJobDeps,
  org: FedOrg,
  peer: PeerRow,
  input: z.infer<typeof ShareAcceptActivity>,
) {
  const share = await hostShare(deps, org, peer, input.shareId);
  if (share.status === 'active') return {};
  if (share.status !== 'invited' || !share.conversationId) {
    throw new AppError('federation_share_closed');
  }
  if (share.expiresAt && share.expiresAt < new Date()) {
    await setStatus(deps.db, share.id, 'expired');
    throw new AppError('federation_share_closed');
  }
  await deps.db
    .insert(federationConversations)
    .values({
      conversationId: share.conversationId,
      peerId: peer.id,
      orgId: org.id,
      remoteConversationId: input.conversationId,
      homeDomain: ownDomain(deps.env),
    })
    .onConflictDoUpdate({
      target: [federationConversations.conversationId, federationConversations.peerId],
      set: { remoteConversationId: input.conversationId },
    });
  await setStatus(deps.db, share.id, 'active');
  // Shared folders and a meeting going on reach the new organization too.
  await deps.jobs.send('federation.share_joined', { orgId: org.id, shareId: share.id });
  await audit(deps.db, {
    orgId: org.id,
    actorId: null,
    action: 'federation.share.accepted',
    targetType: 'conversation',
    targetId: share.conversationId,
    meta: { domain: peer.domain, shareId: share.id },
  });
  return {};
}

/** Host side: `channel.share.decline` and `channel.share.leave`. */
export async function receiveShareClosed(
  deps: FedJobDeps,
  org: FedOrg,
  peer: PeerRow,
  shareId: string,
  status: 'declined' | 'left',
) {
  const share = await hostShare(deps, org, peer, shareId);
  if (!open(share) && share.status !== 'active') return {};
  await setStatus(deps.db, share.id, status);
  if (share.conversationId) await unlink(deps.db, share.conversationId, peer.id);
  return {};
}

/** Guest side: `channel.share.remove` and `channel.share.end`. */
export async function receiveShareEnded(
  deps: FedJobDeps,
  org: FedOrg,
  peer: PeerRow,
  shareId: string,
  status: 'removed' | 'ended',
) {
  const share = await guestShare(deps, org, peer, shareId);
  if (!share || (share.status !== 'pending' && share.status !== 'active')) return {};
  await setStatus(deps.db, share.id, status);
  if (share.conversationId) {
    await unlink(deps.db, share.conversationId, peer.id);
    await endGuestFolders(deps.db, org.id, share.conversationId);
    await archiveCopy(deps, org.id, share.conversationId);
  }
  return {};
}

/**
 * `channel.share.sync`: a peer that came back (a reset demo, a restored install) asks for the
 * invites still open for it; they are answered as invites would be.
 */
export async function receiveShareSync(deps: FedJobDeps, org: FedOrg, peer: PeerRow) {
  await expireInvites(deps.db, org.id);
  const rows = await deps.db
    .select({ share: federationSharedChannels, conv: conversations })
    .from(federationSharedChannels)
    .innerJoin(conversations, eq(conversations.id, federationSharedChannels.conversationId))
    .where(
      and(
        eq(federationSharedChannels.orgId, org.id),
        eq(federationSharedChannels.peerId, peer.id),
        eq(federationSharedChannels.role, 'host'),
        eq(federationSharedChannels.status, 'invited'),
      ),
    );
  return {
    invites: rows.map((r) => (inviteActivity(r.share, r.conv) as { share: unknown }).share),
  };
}

/** After a peer becomes active: fetch the invites it holds for us. */
export async function syncShares(deps: FedJobDeps, org: FedOrg, peer: PeerRow) {
  if (!sharedSettings(org).enabled || !peerActive(org, peer)) return;
  const answer = await postActivity(
    deps,
    org.id,
    peer.domain,
    newActivity('channel.share.sync', {}),
  );
  const parsed = z
    .object({ invites: z.array(InviteShape).max(MAX_OPEN_INVITES) })
    .safeParse(answer);
  if (!parsed.success) return;
  for (const invite of parsed.data.invites) {
    const row = await storeInvite(deps, org, peer, invite);
    if (row.status === 'pending' && autoAccepts(deps, peer)) {
      await autoAcceptShare(deps, { orgId: org.id, shareId: row.id });
    }
  }
}

// ---- Instance identity (demo reset, restored install) ----

export async function ownInstanceId(db: DbOrTx, orgId: string) {
  const [row] = await db
    .select({ id: federationKeys.instanceId })
    .from(federationKeys)
    .where(eq(federationKeys.orgId, orgId));
  return row?.id ?? null;
}

/**
 * A peer told us a new instance id: its database is not the one our links point at. Direct
 * links go; channels we host wait to be invited again (`channel.share.sync`); copies of
 * channels it hosted become archives.
 */
export async function peerInstanceChanged(
  deps: FedJobDeps,
  org: FedOrg,
  peer: PeerRow,
  instanceId: string,
) {
  const before = peer.remoteInstanceId;
  await deps.db
    .update(federationPeers)
    .set({ remoteInstanceId: instanceId })
    .where(eq(federationPeers.id, peer.id));
  if (!before || before === instanceId) return;
  deps.logger.info({ domain: peer.domain }, 'federation peer was reset');
  const shares = await deps.db
    .select()
    .from(federationSharedChannels)
    .where(
      and(
        eq(federationSharedChannels.orgId, org.id),
        eq(federationSharedChannels.peerId, peer.id),
        inArray(federationSharedChannels.status, ['invited', 'pending', 'active']),
      ),
    );
  for (const s of shares) {
    if (s.role === 'host') {
      await setStatus(deps.db, s.id, 'invited', { expiresAt: inviteExpiry() });
      if (s.conversationId) await unlink(deps.db, s.conversationId, peer.id);
    } else {
      await setStatus(deps.db, s.id, 'ended');
      if (s.conversationId) {
        await unlink(deps.db, s.conversationId, peer.id);
        await endGuestFolders(deps.db, org.id, s.conversationId);
        await archiveCopy(deps, org.id, s.conversationId);
      }
    }
  }
  await deps.db.delete(federationConversations).where(eq(federationConversations.peerId, peer.id));
}

// ---- Views ----

/** Conversation.federation.shared for a page of conversations. */
export async function sharesOf(db: DbOrTx, ids: string[]) {
  const out = new Map<string, ConversationShare>();
  if (ids.length === 0) return out;
  const rows = await db
    .select({ share: federationSharedChannels, peer: federationPeers })
    .from(federationSharedChannels)
    .innerJoin(federationPeers, eq(federationPeers.id, federationSharedChannels.peerId))
    .where(
      and(
        inArray(federationSharedChannels.conversationId, ids),
        inArray(federationSharedChannels.status, ['invited', 'active', 'removed', 'left', 'ended']),
      ),
    )
    .orderBy(federationSharedChannels.createdAt);
  for (const { share, peer } of rows) {
    const id = share.conversationId!;
    const s = out.get(id) ?? { role: share.role, active: false, orgs: [] };
    s.orgs.push({ domain: peer.domain, name: peer.name, status: share.status });
    s.active = s.active || share.status === 'active';
    out.set(id, s);
  }
  return out;
}

/** Remote people blocked in these conversations, by address. */
export async function blockedOf(db: DbOrTx, ids: string[]) {
  const out = new Map<string, string[]>();
  if (ids.length === 0) return out;
  const rows = await db
    .select({
      conversationId: federationMembers.conversationId,
      handle: federationUsers.handle,
      domain: federationPeers.domain,
    })
    .from(federationMembers)
    .innerJoin(federationUsers, eq(federationUsers.id, federationMembers.remoteUserId))
    .innerJoin(federationPeers, eq(federationPeers.id, federationUsers.peerId))
    .where(
      and(
        inArray(federationMembers.conversationId, ids),
        sql`${federationMembers.blockedAt} is not null`,
      ),
    );
  for (const r of rows) {
    out.set(r.conversationId, [...(out.get(r.conversationId) ?? []), `${r.handle}@${r.domain}`]);
  }
  return out;
}

/** An active share of this conversation with the peer (the host accepts all its people). */
export async function activeShareWith(db: DbOrTx, conversationId: string, peerId: string) {
  const [row] = await db
    .select({ id: federationSharedChannels.id })
    .from(federationSharedChannels)
    .where(
      and(
        eq(federationSharedChannels.conversationId, conversationId),
        eq(federationSharedChannels.peerId, peerId),
        eq(federationSharedChannels.status, 'active'),
      ),
    );
  return !!row;
}

/** federation.share_joined: a guest just accepted; it gets the shared folders and meeting. */
export async function shareJoined(deps: FedJobDeps, data: { orgId: string; shareId: string }) {
  const [row] = await sharesWhere(
    deps.db,
    and(
      eq(federationSharedChannels.orgId, data.orgId),
      eq(federationSharedChannels.id, data.shareId),
    ),
  );
  if (!row || row.share.status !== 'active' || !row.share.conversationId) return;
  const [org] = await deps.db
    .select({ id: organizations.id, name: organizations.name, settings: organizations.settings })
    .from(organizations)
    .where(eq(organizations.id, data.orgId));
  if (!org) return;
  await offerFoldersTo(deps, org, row.share.conversationId, row.peer);
  await meetingStatusTo(deps, org, row.share.conversationId, row.peer);
}
