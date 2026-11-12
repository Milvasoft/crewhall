import { Empty, def } from '../endpoint-def';
import { Conversation } from '../schemas/chat';
import {
  AcceptSharedChannel,
  AddFederationPeer,
  BlockRemoteMember,
  FederationPeer,
  FederationSettings,
  MyFederationAddress,
  RemoteAddressBody,
  RemoteAddressQuery,
  RemoteUser,
  ShareChannel,
  ShareFolder,
  SharedFolder,
  SharedFolderList,
  SharedMeetingJoin,
  ShareNodeRemote,
  SharedChannel,
  SharedChannelList,
  SharedRemote,
  UpdateFederation,
} from '../schemas/federation';

/**
 * Federation (roadmap 26, docs/contracts/federasyon.md). Installations talk to each other on
 * /api/federation/v1/inbox with signed requests; that is not part of this client contract.
 */
export const federationEndpoints = {
  // ---- Yönetim › Güvenlik › Federasyon (org owner and admins) ----
  getFederation: def({
    method: 'GET',
    path: '/api/v1/federation',
    auth: 'session',
    response: FederationSettings,
  }),
  /** Turning it on creates the installation key; allowed domains gate incoming requests. */
  updateFederation: def({
    method: 'PATCH',
    path: '/api/v1/federation',
    auth: 'session',
    body: UpdateFederation,
    response: FederationSettings,
  }),
  /**
   * Adds the domain to the allowed list, fetches its discovery document and asks it to
   * federate; active at once when they already added us, else pending. Also "Kabul et".
   */
  addFederationPeer: def({
    method: 'POST',
    path: '/api/v1/federation/peers',
    auth: 'session',
    body: AddFederationPeer,
    response: FederationPeer,
  }),
  /** Stops federation with the domain (they are told); conversations stay read-only. */
  removeFederationPeer: def({
    method: 'DELETE',
    path: '/api/v1/federation/peers/:peerId',
    auth: 'session',
    response: Empty,
  }),

  // ---- People ----
  /** My `handle@domain`, to give to people on other installations. */
  getMyFederationAddress: def({
    method: 'GET',
    path: '/api/v1/federation/me',
    auth: 'session',
    response: MyFederationAddress,
  }),
  /** Asks the person's installation who they are (an active peer only). */
  lookupRemoteUser: def({
    method: 'GET',
    path: '/api/v1/federation/users',
    auth: 'session',
    query: RemoteAddressQuery,
    response: RemoteUser,
  }),
  /** Direct chat with a remote person; the existing one when there is one. */
  createRemoteConversation: def({
    method: 'POST',
    path: '/api/v1/chat/remote-conversations',
    auth: 'session',
    body: RemoteAddressBody,
    response: Conversation,
  }),
  /** Adds a remote person to a group or space conversation (needs `manage`). */
  addRemoteConversationMember: def({
    method: 'POST',
    path: '/api/v1/chat/conversations/:conversationId/remote-members',
    auth: 'session',
    body: RemoteAddressBody,
    response: Conversation,
  }),
  /** A link share of a page or file sent to a remote person as a direct chat message. */
  shareNodeRemote: def({
    method: 'POST',
    path: '/api/v1/nodes/:nodeId/remote-shares',
    auth: 'session',
    body: ShareNodeRemote,
    response: SharedRemote,
  }),

  // ---- Shared channels (federasyon.md › Paylaşılan kanallar) ----
  /** Yönetim › Federasyon › Paylaşılan kanallar: every share and invite (org owner and admins). */
  listSharedChannels: def({
    method: 'GET',
    path: '/api/v1/federation/shared-channels',
    auth: 'session',
    response: SharedChannelList,
  }),
  /**
   * "Kurumla paylaş": invites an active peer organization into a space channel. Org admins, or
   * the channel's managers when `whoCanInvite` is `managers`.
   */
  shareChannel: def({
    method: 'POST',
    path: '/api/v1/chat/conversations/:conversationId/shares',
    auth: 'session',
    body: ShareChannel,
    response: SharedChannel,
  }),
  /** The organizations a channel is shared with (members of the channel). */
  listConversationShares: def({
    method: 'GET',
    path: '/api/v1/chat/conversations/:conversationId/shares',
    auth: 'session',
    response: SharedChannelList,
  }),
  /** A pending invite becomes a channel of the chosen space (org owner and admins). */
  acceptSharedChannel: def({
    method: 'POST',
    path: '/api/v1/federation/shared-channels/:shareId/accept',
    auth: 'session',
    body: AcceptSharedChannel,
    response: SharedChannel,
  }),
  declineSharedChannel: def({
    method: 'POST',
    path: '/api/v1/federation/shared-channels/:shareId/decline',
    auth: 'session',
    response: SharedChannel,
  }),
  /**
   * Host: takes the organization out of the channel (or withdraws the invite); guest: leaves.
   * The channel stays as a read-only archive on the side that loses it.
   */
  endSharedChannel: def({
    method: 'DELETE',
    path: '/api/v1/federation/shared-channels/:shareId',
    auth: 'session',
    response: SharedChannel,
  }),
  /** Blocks (or unblocks) a remote person in a shared channel (needs `manage`). */
  blockRemoteMember: def({
    method: 'POST',
    path: '/api/v1/chat/conversations/:conversationId/remote-members/block',
    auth: 'session',
    body: BlockRemoteMember,
    response: Conversation,
  }),

  // ---- Shared channels 2: folders and meetings ----
  /** The folders kept in step with a shared channel's organizations (channel members). */
  listSharedFolders: def({
    method: 'GET',
    path: '/api/v1/chat/conversations/:conversationId/shared-folders',
    auth: 'session',
    response: SharedFolderList,
  }),
  /**
   * "Klasör paylaş" on the host: a folder of the channel's space goes to every organization the
   * channel is shared with (channel managers and org admins; at most 10 per channel).
   */
  shareFolder: def({
    method: 'POST',
    path: '/api/v1/chat/conversations/:conversationId/shared-folders',
    auth: 'session',
    body: ShareFolder,
    response: SharedFolder,
  }),
  /** Stops keeping the folder in step; every copy stays as a plain folder. */
  endSharedFolder: def({
    method: 'DELETE',
    path: '/api/v1/chat/conversations/:conversationId/shared-folders/:folderId',
    auth: 'session',
    response: SharedFolder,
  }),
  /** Guest copy: joins the host's channel meeting (Conversation.federation.meeting) as a guest. */
  joinSharedMeeting: def({
    method: 'POST',
    path: '/api/v1/chat/conversations/:conversationId/shared-meeting/join',
    auth: 'session',
    response: SharedMeetingJoin,
  }),
};
