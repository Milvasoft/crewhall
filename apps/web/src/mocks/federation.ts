import {
  type EndpointName,
  type FederationPeer,
  type RemoteUser,
  type SharedChannel,
  type SharedChannelSettings,
} from '@crewhall/shared';
import { actorOf, MockApiError, requireUser, type Resolvers } from './core';
import { db, newId } from './db';
import { type MockState } from './seed';

/**
 * Federation part of the contract mock (roadmap 26). Off by default like a new installation;
 * one peer (hub.acme.com) is already registered so turning it on shows a working pairing.
 */

interface FederationMockState {
  enabled: boolean;
  allowedDomains: string[];
  peers: FederationPeer[];
  /** People the peers answer `user.lookup` for. */
  directory: RemoteUser[];
  sharedChannels: SharedChannelSettings;
  shares: SharedChannel[];
}

export const MOCK_FEDERATION_DOMAIN = 'hub.milvasoft.com';
const FINGERPRINT = '3F2A 9C1D 77B0 E4A5 0C6D 18F3 A2B9 5E70';

function seed(): FederationMockState {
  return {
    enabled: false,
    allowedDomains: ['hub.acme.com'],
    peers: [
      {
        id: newId(),
        domain: 'hub.acme.com',
        name: 'Acme',
        status: 'active',
        fingerprint: '91C4 0B7E 2D58 F6A1 3E09 C7D2 84BB 1F65',
        requested: false,
        lastSeenAt: new Date(Date.now() - 3_600_000).toISOString(),
        createdAt: new Date(Date.now() - 86_400_000 * 12).toISOString(),
      },
    ],
    directory: [
      { address: 'ayse@hub.acme.com', name: 'Ayşe Demir', domain: 'hub.acme.com' },
      { address: 'kerem@hub.acme.com', name: 'Kerem Aydın', domain: 'hub.acme.com' },
    ],
    sharedChannels: { enabled: true, whoCanInvite: 'admins', maxFileMb: 25 },
    // One invite waiting, so Yönetim › Federasyon › Paylaşılan kanallar shows the flow.
    shares: [
      {
        id: newId(),
        role: 'guest',
        status: 'pending',
        domain: 'hub.acme.com',
        orgName: 'Acme',
        conversationId: null,
        channelName: 'acme-ortak-proje',
        invitedBy: 'Ayşe Demir',
        expiresAt: new Date(Date.now() + 86_400_000 * 6).toISOString(),
        createdAt: new Date(Date.now() - 86_400_000).toISOString(),
        updatedAt: new Date(Date.now() - 86_400_000).toISOString(),
      },
    ],
  };
}

export function federationState(s: MockState = db()): FederationMockState {
  const holder = s as MockState & { federation?: FederationMockState };
  holder.federation ??= seed();
  return holder.federation;
}

function requireAdmin(s: MockState) {
  const u = requireUser(s);
  const role = actorOf(s, u).orgRole;
  if (role !== 'owner' && role !== 'admin') throw new MockApiError('forbidden');
  return u;
}

function view(s: MockState) {
  const f = federationState(s);
  return {
    enabled: f.enabled,
    domain: MOCK_FEDERATION_DOMAIN,
    fingerprint: f.enabled ? FINGERPRINT : null,
    allowedDomains: [...f.allowedDomains].sort(),
    peers: f.peers,
    sharedChannels: f.sharedChannels,
  };
}

function shareOf(s: MockState, id: string) {
  const share = federationState(s).shares.find((x) => x.id === id);
  if (!share) throw new MockApiError('not_found');
  return share;
}

function touch(share: SharedChannel, status: SharedChannel['status']) {
  share.status = status;
  share.updatedAt = new Date().toISOString();
  if (status !== 'invited' && status !== 'pending') share.expiresAt = null;
  return share;
}

/** The remote person behind an address, as an active peer would answer. */
export function remoteLookup(s: MockState, address: string): RemoteUser {
  const f = federationState(s);
  if (!f.enabled) throw new MockApiError('federation_disabled');
  const domain = address.slice(address.lastIndexOf('@') + 1);
  if (domain === MOCK_FEDERATION_DOMAIN) throw new MockApiError('federation_domain_self');
  if (!f.allowedDomains.includes(domain)) throw new MockApiError('federation_domain_not_allowed');
  const peer = f.peers.find((p) => p.domain === domain);
  if (!peer || peer.status !== 'active') throw new MockApiError('federation_peer_not_active');
  const person = f.directory.find((p) => p.address === address);
  if (!person) throw new MockApiError('federation_user_not_found');
  return person;
}

const handleOf = (email: string) => email.slice(0, email.indexOf('@')).toLowerCase();

type FederationName = Extract<
  EndpointName,
  | 'getFederation'
  | 'updateFederation'
  | 'addFederationPeer'
  | 'removeFederationPeer'
  | 'getMyFederationAddress'
  | 'lookupRemoteUser'
  | 'listSharedChannels'
  | 'listConversationShares'
  | 'shareChannel'
  | 'acceptSharedChannel'
  | 'declineSharedChannel'
  | 'endSharedChannel'
  | 'listSharedFolders'
>;

export const federationResolvers: Resolvers<FederationName> = {
  // Shared channels 2: the mock peers share no folders.
  listSharedFolders: ({ s }) => {
    requireUser(s);
    return { items: [] };
  },
  getFederation: ({ s }) => {
    requireAdmin(s);
    return view(s);
  },
  updateFederation: ({ s, body }) => {
    requireAdmin(s);
    const f = federationState(s);
    if (body.enabled !== undefined) f.enabled = body.enabled;
    if (body.allowedDomains) f.allowedDomains = [...new Set(body.allowedDomains)];
    if (body.sharedChannels) f.sharedChannels = { ...f.sharedChannels, ...body.sharedChannels };
    return view(s);
  },
  addFederationPeer: ({ s, body }) => {
    requireAdmin(s);
    const f = federationState(s);
    if (!f.enabled) throw new MockApiError('federation_disabled');
    if (body.domain === MOCK_FEDERATION_DOMAIN) throw new MockApiError('federation_domain_self');
    if (!f.allowedDomains.includes(body.domain)) f.allowedDomains.push(body.domain);
    const known = f.peers.find((p) => p.domain === body.domain);
    if (known) {
      // "Kabul et": they had added us.
      known.status = 'active';
      known.requested = false;
      return known;
    }
    if (body.domain.endsWith('.invalid')) throw new MockApiError('federation_peer_unreachable');
    const peer: FederationPeer = {
      id: newId(),
      domain: body.domain,
      name: null,
      status: 'pending',
      fingerprint: 'A1B2 C3D4 E5F6 0718 293A 4B5C 6D7E 8F90',
      requested: false,
      lastSeenAt: null,
      createdAt: new Date().toISOString(),
    };
    f.peers.push(peer);
    return peer;
  },
  removeFederationPeer: ({ s, params }) => {
    requireAdmin(s);
    const f = federationState(s);
    if (!f.peers.some((p) => p.id === params.peerId)) throw new MockApiError('not_found');
    f.peers = f.peers.filter((p) => p.id !== params.peerId);
    return {};
  },
  getMyFederationAddress: ({ s }) => {
    const u = requireUser(s);
    const f = federationState(s);
    if (!f.enabled) return { enabled: false, address: null };
    const guest = actorOf(s, u).orgRole === 'guest';
    return {
      enabled: true,
      address: guest ? null : `${handleOf(u.email)}@${MOCK_FEDERATION_DOMAIN}`,
    };
  },
  lookupRemoteUser: ({ s, query }) => {
    requireUser(s);
    return remoteLookup(s, query.address);
  },
  listSharedChannels: ({ s }) => {
    requireAdmin(s);
    return { items: federationState(s).shares };
  },
  listConversationShares: ({ s, params }) => {
    requireUser(s);
    return {
      items: federationState(s).shares.filter((x) => x.conversationId === params.conversationId),
    };
  },
  shareChannel: ({ s, params, body }) => {
    const u = requireUser(s);
    const f = federationState(s);
    if (!f.enabled) throw new MockApiError('federation_disabled');
    if (!f.sharedChannels.enabled) throw new MockApiError('federation_shared_channels_disabled');
    const peer = f.peers.find((p) => p.domain === body.domain);
    if (!peer || peer.status !== 'active') throw new MockApiError('federation_peer_not_active');
    const now = new Date().toISOString();
    const share: SharedChannel = {
      id: newId(),
      role: 'host',
      status: 'invited',
      domain: peer.domain,
      orgName: peer.name,
      conversationId: params.conversationId ?? null,
      // The chat mock keeps conversations on the same state (mocks/chat.ts › chatState).
      channelName:
        (
          s as MockState & { chat?: { conversations: { id: string; name: string | null }[] } }
        ).chat?.conversations.find((c) => c.id === params.conversationId)?.name ?? '',
      invitedBy: u.name,
      expiresAt: new Date(Date.now() + 86_400_000 * 7).toISOString(),
      createdAt: now,
      updatedAt: now,
    };
    f.shares.unshift(share);
    return share;
  },
  acceptSharedChannel: ({ s, params }) => {
    requireAdmin(s);
    const share = shareOf(s, params.shareId ?? '');
    if (share.role !== 'guest' || share.status !== 'pending') {
      throw new MockApiError('federation_share_closed');
    }
    return touch(share, 'active');
  },
  declineSharedChannel: ({ s, params }) => {
    requireAdmin(s);
    const share = shareOf(s, params.shareId ?? '');
    if (share.status !== 'pending') throw new MockApiError('federation_share_closed');
    return touch(share, 'declined');
  },
  endSharedChannel: ({ s, params }) => {
    requireUser(s);
    const share = shareOf(s, params.shareId ?? '');
    if (share.status !== 'active' && share.status !== 'invited') {
      throw new MockApiError('federation_share_closed');
    }
    return touch(share, share.role === 'host' ? 'removed' : 'left');
  },
};
