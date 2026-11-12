import { resources, type AppLocale } from '@crewhall/i18n';
import { type AutomationRule } from '@crewhall/shared';
import { infiniteQueryOptions, queryOptions, type QueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

/** Automations queries (roadmap 17). */

export const automationKeys = {
  catalog: ['automations', 'catalog'] as const,
  list: (spaceId: string) => ['automations', 'list', spaceId] as const,
  rule: (ruleId: string) => ['automations', 'rule', ruleId] as const,
  runs: (ruleId: string) => ['automations', 'runs', ruleId] as const,
};

export const catalogQuery = queryOptions({
  queryKey: automationKeys.catalog,
  queryFn: ({ signal }) => api.call('getAutomationCatalog', { signal }),
  staleTime: 5 * 60_000,
});

export const rulesQuery = (spaceId: string) =>
  queryOptions({
    queryKey: automationKeys.list(spaceId),
    queryFn: ({ signal }) => api.call('listAutomationRules', { params: { spaceId }, signal }),
    staleTime: 15_000,
  });

export const ruleQuery = (ruleId: string) =>
  queryOptions({
    queryKey: automationKeys.rule(ruleId),
    queryFn: ({ signal }) => api.call('getAutomationRule', { params: { ruleId }, signal }),
    retry: false,
  });

export const runsQuery = (ruleId: string) =>
  infiniteQueryOptions({
    queryKey: automationKeys.runs(ruleId),
    queryFn: ({ pageParam, signal }) =>
      api.call('listAutomationRuns', {
        params: { ruleId },
        query: { limit: 30, ...(pageParam ? { cursor: pageParam } : {}) },
        signal,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });

export function setRuleCache(qc: QueryClient, rule: AutomationRule) {
  qc.setQueryData(automationKeys.rule(rule.id), rule);
  void qc.invalidateQueries({ queryKey: automationKeys.list(rule.spaceId) });
}

/**
 * Labels of registry types and fields. Types are plugins (another module may register one the
 * web does not know yet), so a missing label falls back to the raw type instead of a typed key.
 */
function lookup(locale: AppLocale, path: string[]): string | null {
  let node: unknown = resources[locale].web.automations;
  for (const p of path) {
    if (!node || typeof node !== 'object' || !(p in node)) return null;
    node = (node as Record<string, unknown>)[p];
  }
  return typeof node === 'string' ? node : null;
}

export function kindName(locale: AppLocale, group: 'triggers' | 'actions', type: string) {
  return lookup(locale, [group, type, 'name']) ?? type;
}

export function kindDesc(locale: AppLocale, group: 'triggers' | 'actions', type: string) {
  return lookup(locale, [group, type, 'desc']);
}

export function fieldName(locale: AppLocale, key: string) {
  return lookup(locale, ['fields', key]) ?? key;
}

/** Readable name of an event path ("card.title" → "Kart başlığı"); unknown paths stay as they are. */
export function variableName(locale: AppLocale, path: string) {
  return lookup(locale, ['variables', ...path.split('.')]) ?? path;
}
