import { type CompanyQuery, type ContactQuery, type DirectoryQuery } from '@crewhall/shared';
import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import { api } from '@/lib/api';

/** Query keys and fetchers of the contacts and directory module (roadmap 15). */
export const contactsKeys = {
  all: ['contacts'] as const,
  directory: (q: Omit<DirectoryQuery, 'cursor'>) => ['contacts', 'directory', q] as const,
  person: (userId: string) => ['contacts', 'person', userId] as const,
  facets: () => ['contacts', 'facets'] as const,
  chart: () => ['contacts', 'chart'] as const,
  contacts: (q: Omit<ContactQuery, 'cursor'>) => ['contacts', 'list', q] as const,
  contact: (id: string) => ['contacts', 'contact', id] as const,
  versions: (id: string) => ['contacts', 'versions', id] as const,
  companies: (q: Omit<CompanyQuery, 'cursor'>) => ['contacts', 'companies', q] as const,
  company: (id: string) => ['contacts', 'company', id] as const,
  tags: () => ['contacts', 'tags'] as const,
  carddav: () => ['contacts', 'carddav'] as const,
};

export const directoryQuery = (q: Omit<DirectoryQuery, 'cursor'>) =>
  infiniteQueryOptions({
    queryKey: contactsKeys.directory(q),
    queryFn: ({ pageParam, signal }) =>
      api.call('listDirectory', { query: { ...q, limit: 60, cursor: pageParam }, signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

export const personQuery = (userId: string) =>
  queryOptions({
    queryKey: contactsKeys.person(userId),
    queryFn: ({ signal }) => api.call('getDirectoryPerson', { params: { userId }, signal }),
  });

export const facetsQuery = () =>
  queryOptions({
    queryKey: contactsKeys.facets(),
    queryFn: ({ signal }) => api.call('getDirectoryFacets', { signal }),
    staleTime: 60_000,
  });

export const orgChartQuery = () =>
  queryOptions({
    queryKey: contactsKeys.chart(),
    queryFn: ({ signal }) => api.call('getOrgChart', { signal }),
    staleTime: 60_000,
  });

export const contactVersionsQuery = (contactId: string) =>
  queryOptions({
    queryKey: contactsKeys.versions(contactId),
    queryFn: ({ signal }) => api.call('listContactVersions', { params: { contactId }, signal }),
  });

export const contactsQuery = (q: Omit<ContactQuery, 'cursor'>) =>
  infiniteQueryOptions({
    queryKey: contactsKeys.contacts(q),
    queryFn: ({ pageParam, signal }) =>
      api.call('listContacts', { query: { ...q, limit: 60, cursor: pageParam }, signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

export const contactQuery = (contactId: string) =>
  queryOptions({
    queryKey: contactsKeys.contact(contactId),
    queryFn: ({ signal }) => api.call('getContact', { params: { contactId }, signal }),
  });

export const companiesQuery = (q: Omit<CompanyQuery, 'cursor'>) =>
  infiniteQueryOptions({
    queryKey: contactsKeys.companies(q),
    queryFn: ({ pageParam, signal }) =>
      api.call('listContactCompanies', { query: { ...q, limit: 60, cursor: pageParam }, signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

export const companyQuery = (companyId: string) =>
  queryOptions({
    queryKey: contactsKeys.company(companyId),
    queryFn: ({ signal }) => api.call('getContactCompany', { params: { companyId }, signal }),
  });

export const contactTagsQuery = () =>
  queryOptions({
    queryKey: contactsKeys.tags(),
    queryFn: ({ signal }) => api.call('listContactTags', { signal }),
    staleTime: 30_000,
  });

export const cardDavInfoQuery = () =>
  queryOptions({
    queryKey: contactsKeys.carddav(),
    queryFn: ({ signal }) => api.call('getCardDavInfo', { signal }),
    staleTime: 5 * 60_000,
  });
