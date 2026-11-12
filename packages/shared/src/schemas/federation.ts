import { z } from 'zod';
import { Id, Timestamp } from './common';
import { MeetingConnection } from './meet';

/**
 * Federation (roadmap 26, docs/contracts/federasyon.md): chat and shares with other Crewhall
 * installations. A remote person is addressed as `handle@domain`, the domain being the
 * other installation's host (port included in development).
 */

/** host[:port], lower case; no scheme, path or user part. */
export const FederationDomain = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(253)
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/);
export type FederationDomain = z.infer<typeof FederationDomain>;

/** An allowed-domains entry: a domain, or `*.example.com` for its subdomains. */
export const FederationDomainPattern = z
  .string()
  .trim()
  .toLowerCase()
  .max(255)
  .regex(/^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/);

export const FederationHandle = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);

/** `handle@domain`. */
export const FederatedAddress = z
  .string()
  .trim()
  .toLowerCase()
  .max(320)
  .refine((v) => {
    const at = v.lastIndexOf('@');
    return (
      at > 0 &&
      FederationHandle.safeParse(v.slice(0, at)).success &&
      FederationDomain.safeParse(v.slice(at + 1)).success
    );
  }, 'handle@domain');
export type FederatedAddress = z.infer<typeof FederatedAddress>;

/** A person on another installation, as this one knows them. */
export const RemoteUser = z.object({
  address: z.string(),
  name: z.string(),
  domain: z.string(),
});
export type RemoteUser = z.infer<typeof RemoteUser>;

// ---- Shared channels (kararlar.md 2026-10-29, federasyon.md › Paylaşılan kanallar) ----

/**
 * `invited`: the host sent the invite, no answer yet; `pending`: an invite waiting for this
 * (guest) organization's admins; `active`: messages flow; `declined`, `expired`: the invite
 * closed unanswered; `removed`: the host took the organization out; `left`: the guest left;
 * `ended`: the host channel was archived or deleted. Closed shares keep the history read-only.
 */
export const SharedChannelStatus = z.enum([
  'invited',
  'pending',
  'active',
  'declined',
  'expired',
  'removed',
  'left',
  'ended',
]);
export type SharedChannelStatus = z.infer<typeof SharedChannelStatus>;

/** `host`: the channel is ours, shared out; `guest`: our copy of another organization's channel. */
export const SharedChannelRole = z.enum(['host', 'guest']);
export type SharedChannelRole = z.infer<typeof SharedChannelRole>;

export const SharedChannel = z.object({
  id: Id,
  role: SharedChannelRole,
  status: SharedChannelStatus,
  /** The other organization's domain and name. */
  domain: z.string(),
  orgName: z.string().nullable(),
  /** The local channel; null for a guest invite not accepted yet. */
  conversationId: Id.nullable(),
  /** The channel's name on the host. */
  channelName: z.string(),
  /** Host side: who shared it; guest side: who sent the invite (on the host). */
  invitedBy: z.string().nullable(),
  /** Until when an `invited` / `pending` invite can be accepted. */
  expiresAt: Timestamp.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type SharedChannel = z.infer<typeof SharedChannel>;

export const SharedChannelList = z.object({ items: z.array(SharedChannel) });
export type SharedChannelList = z.infer<typeof SharedChannelList>;

export const ShareChannel = z.object({ domain: FederationDomain });
export type ShareChannel = z.infer<typeof ShareChannel>;

/** Kabul et: the guest copy becomes a channel of `spaceId`, its members the space's members. */
export const AcceptSharedChannel = z.object({
  spaceId: Id,
  name: z.string().trim().min(1).max(80).optional(),
});
export type AcceptSharedChannel = z.infer<typeof AcceptSharedChannel>;

export const BlockRemoteMember = z.object({
  address: FederatedAddress,
  blocked: z.boolean(),
});
export type BlockRemoteMember = z.infer<typeof BlockRemoteMember>;

/** Who may share a channel with another organization. */
export const SharedChannelInviters = z.enum(['admins', 'managers']);
export type SharedChannelInviters = z.infer<typeof SharedChannelInviters>;

export const SharedChannelSettings = z.object({
  /** Off by default; both organizations must turn it on. */
  enabled: z.boolean(),
  /** `admins`: org owner and admins; `managers`: also the channel's managers. */
  whoCanInvite: SharedChannelInviters,
  /** Largest file sent to or taken from another organization, in MB. */
  maxFileMb: z.number().int().min(1).max(1024),
});
export type SharedChannelSettings = z.infer<typeof SharedChannelSettings>;

/** Conversation.federation.shared: the channel is shared at organization level. */
export const ConversationShare = z.object({
  role: SharedChannelRole,
  /** True while messages flow (guest: the host share is active; host: at least one org). */
  active: z.boolean(),
  /** The other organizations (host: every shared org; guest: the host). */
  orgs: z.array(
    z.object({ domain: z.string(), name: z.string().nullable(), status: SharedChannelStatus }),
  ),
});
export type ConversationShare = z.infer<typeof ConversationShare>;

// ---- Shared channels 2: folders and meetings (kararlar.md, federasyon.md) ----

/** `active`: kept in step with the other organizations; `ended`: a plain local folder now. */
export const SharedFolderStatus = z.enum(['active', 'ended']);
export type SharedFolderStatus = z.infer<typeof SharedFolderStatus>;

/** A Drive folder of a shared channel; each organization keeps its own copy. */
export const SharedFolder = z.object({
  id: Id,
  role: SharedChannelRole,
  status: SharedFolderStatus,
  name: z.string(),
  conversationId: Id,
  /** This organization's copy in Drive; null when it was deleted here. */
  nodeId: Id.nullable(),
  /** The host's domain (where the folder was shared from). */
  homeDomain: z.string(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type SharedFolder = z.infer<typeof SharedFolder>;

export const SharedFolderList = z.object({ items: z.array(SharedFolder) });
export type SharedFolderList = z.infer<typeof SharedFolderList>;

/** "Klasör paylaş": a folder of the channel's space (host side). */
export const ShareFolder = z.object({ nodeId: Id });
export type ShareFolder = z.infer<typeof ShareFolder>;

/** The host's channel meeting, seen from a guest copy while it is going on. */
export const SharedMeeting = z.object({
  title: z.string(),
  startedAt: Timestamp,
  /** The host's domain: the meeting runs on its servers. */
  domain: z.string(),
});
export type SharedMeeting = z.infer<typeof SharedMeeting>;

/** joinSharedMeeting: connect straight to the host's LiveKit as a guest of the meeting. */
export const SharedMeetingJoin = z.object({
  title: z.string(),
  domain: z.string(),
  connection: MeetingConnection,
});
export type SharedMeetingJoin = z.infer<typeof SharedMeetingJoin>;

/** A conversation shared with other installations. */
export const ConversationFederation = z.object({
  /** The installation the conversation started on; it relays messages to the others. */
  homeDomain: z.string(),
  /** Other installations taking part. */
  domains: z.array(z.string()),
  remoteMembers: z.array(RemoteUser),
  /** False while a peer is removed: the history stays, nothing new is sent. */
  active: z.boolean(),
  /** Set when the channel is shared with whole organizations (shared channels). */
  shared: ConversationShare.optional(),
  /** Remote people blocked in this channel (moderators only see the list). */
  blocked: z.array(z.string()).optional(),
  /** Guest copy of a shared channel: the host's channel meeting while it is going on. */
  meeting: SharedMeeting.nullable().optional(),
});
export type ConversationFederation = z.infer<typeof ConversationFederation>;

export const FederationPeerStatus = z.enum(['pending', 'active']);
export type FederationPeerStatus = z.infer<typeof FederationPeerStatus>;

export const FederationPeer = z.object({
  id: Id,
  domain: z.string(),
  /** The other organization's name from its discovery document. */
  name: z.string().nullable(),
  /**
   * `pending`: we added them, they have not added us yet (or removed us); `active`: both
   * added each other and messages flow.
   */
  status: FederationPeerStatus,
  /** SHA-256 of their public key, grouped for reading aloud on a call. */
  fingerprint: z.string().nullable(),
  /** They asked to federate and are not on our allowed list: an admin may add them. */
  requested: z.boolean(),
  lastSeenAt: Timestamp.nullable(),
  createdAt: Timestamp,
});
export type FederationPeer = z.infer<typeof FederationPeer>;

export const FederationSettings = z.object({
  enabled: z.boolean(),
  /** This installation's domain (the part after @ in its people's addresses). */
  domain: z.string(),
  /** SHA-256 of our public key; null until federation is first turned on. */
  fingerprint: z.string().nullable(),
  allowedDomains: z.array(z.string()),
  peers: z.array(FederationPeer),
  sharedChannels: SharedChannelSettings.optional(),
});
export type FederationSettings = z.infer<typeof FederationSettings>;

export const UpdateFederation = z.object({
  enabled: z.boolean().optional(),
  allowedDomains: z.array(FederationDomainPattern).max(200).optional(),
  sharedChannels: SharedChannelSettings.partial().optional(),
});
export type UpdateFederation = z.infer<typeof UpdateFederation>;

export const AddFederationPeer = z.object({ domain: FederationDomain });
export type AddFederationPeer = z.infer<typeof AddFederationPeer>;

export const MyFederationAddress = z.object({
  enabled: z.boolean(),
  /** null while federation is off or for guests. */
  address: z.string().nullable(),
});
export type MyFederationAddress = z.infer<typeof MyFederationAddress>;

export const RemoteAddressQuery = z.object({ address: FederatedAddress });
export const RemoteAddressBody = z.object({ address: FederatedAddress });

export const ShareNodeRemote = z.object({
  address: FederatedAddress,
  /** Shown above the link in the chat message. */
  note: z.string().trim().max(1000).optional(),
  /** Days the link stays valid; 30 by default. */
  expiresInDays: z.number().int().min(1).max(365).default(30),
});
export type ShareNodeRemote = z.infer<typeof ShareNodeRemote>;

export const SharedRemote = z.object({
  conversationId: Id,
  url: z.url(),
  expiresAt: Timestamp,
});
export type SharedRemote = z.infer<typeof SharedRemote>;
