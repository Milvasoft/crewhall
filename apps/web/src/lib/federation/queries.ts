import { FederatedAddress } from '@crewhall/shared';
import { queryOptions } from '@tanstack/react-query';
import { api } from '@/lib/api';

/** Federation (roadmap 26): admin settings and the signed-in person's own address. */
export const federationKeys = {
  all: ['federation'] as const,
  settings: ['federation', 'settings'] as const,
  me: ['federation', 'me'] as const,
  shares: ['federation', 'shares'] as const,
  conversationShares: (id: string) => ['federation', 'shares', id] as const,
  sharedFolders: (id: string) => ['federation', 'folders', id] as const,
};

export const federationSettingsQuery = queryOptions({
  queryKey: federationKeys.settings,
  queryFn: ({ signal }) => api.call('getFederation', { signal }),
});

/** Yönetim › Federasyon › Paylaşılan kanallar (admins). */
export const sharedChannelsQuery = queryOptions({
  queryKey: federationKeys.shares,
  queryFn: ({ signal }) => api.call('listSharedChannels', { signal }),
});

/** The organizations a channel is shared with (its members). */
export const conversationSharesQuery = (conversationId: string) =>
  queryOptions({
    queryKey: federationKeys.conversationShares(conversationId),
    queryFn: ({ signal }) =>
      api.call('listConversationShares', { params: { conversationId }, signal }),
  });

/** Shared channels 2: the folders kept in step with a channel's organizations. */
export const sharedFoldersQuery = (conversationId: string) =>
  queryOptions({
    queryKey: federationKeys.sharedFolders(conversationId),
    queryFn: ({ signal }) => api.call('listSharedFolders', { params: { conversationId }, signal }),
  });

/** Also tells whether federation is on for the org (people's screens hide it otherwise). */
export const myFederationAddressQuery = queryOptions({
  queryKey: federationKeys.me,
  queryFn: ({ signal }) => api.call('getMyFederationAddress', { signal }),
  staleTime: 5 * 60_000,
});

/** `handle@domain` as the contract accepts it. */
export function isFederatedAddress(value: string): boolean {
  return FederatedAddress.safeParse(value).success;
}

/** The part after @ of my own address: conversations homed here may take remote people. */
export const domainOf = (address: string | null | undefined) =>
  address ? address.slice(address.lastIndexOf('@') + 1) : null;
