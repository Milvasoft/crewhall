import { FORMS_RAW_PATHS, type Form } from '@crewhall/shared';
import { infiniteQueryOptions, queryOptions, type QueryClient } from '@tanstack/react-query';
import { config } from '@/config';
import { api } from '@/lib/api';

/** Forms queries (roadmap 16). */

export const formKeys = {
  all: ['forms'] as const,
  list: (spaceId: string) => ['forms', 'list', spaceId] as const,
  form: (formId: string) => ['forms', 'form', formId] as const,
  fill: (formId: string) => ['forms', 'fill', formId] as const,
  publicForm: (token: string) => ['forms', 'public', token] as const,
  responses: (formId: string) => ['forms', 'responses', formId] as const,
  stats: (formId: string) => ['forms', 'stats', formId] as const,
};

export const formsQuery = (spaceId: string) =>
  queryOptions({
    queryKey: formKeys.list(spaceId),
    queryFn: ({ signal }) => api.call('listForms', { params: { spaceId }, signal }),
    staleTime: 30_000,
  });

export const formQuery = (formId: string) =>
  queryOptions({
    queryKey: formKeys.form(formId),
    queryFn: ({ signal }) => api.call('getForm', { params: { formId }, signal }),
    staleTime: 10_000,
    retry: false,
  });

export const fillQuery = (formId: string) =>
  queryOptions({
    queryKey: formKeys.fill(formId),
    queryFn: ({ signal }) => api.call('getFormToFill', { params: { formId }, signal }),
    retry: false,
  });

export const publicFormQuery = (token: string) =>
  queryOptions({
    queryKey: formKeys.publicForm(token),
    queryFn: ({ signal }) => api.call('getPublicForm', { params: { token }, signal }),
    retry: false,
  });

export const statsQuery = (formId: string) =>
  queryOptions({
    queryKey: formKeys.stats(formId),
    queryFn: ({ signal }) => api.call('getFormStats', { params: { formId }, signal }),
    staleTime: 10_000,
  });

export const responsesQuery = (formId: string) =>
  infiniteQueryOptions({
    queryKey: formKeys.responses(formId),
    queryFn: ({ pageParam, signal }) =>
      api.call('listFormResponses', {
        params: { formId },
        query: { limit: 50, ...(pageParam ? { cursor: pageParam } : {}) },
        signal,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });

/** After a save: the form, its space list and anything derived from it. */
export function setFormCache(qc: QueryClient, form: Form) {
  qc.setQueryData(formKeys.form(form.id), form);
  void qc.invalidateQueries({ queryKey: formKeys.list(form.spaceId) });
  void qc.invalidateQueries({ queryKey: formKeys.fill(form.id) });
}

/** Browser download of all answers (session cookie, outside the JSON contract). */
export const csvUrl = (formId: string) =>
  `${config.apiUrl.replace(/\/$/, '')}${FORMS_RAW_PATHS.csv.replace(':formId', formId)}`;
