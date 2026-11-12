import { ActivityFilter, type ToolCall } from '@crewhall/shared';
import {
  Button,
  Chip,
  cn,
  EmptyState,
  Icon,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Table,
  Td,
  Th,
  toast,
} from '@crewhall/ui';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { Fragment, useState } from 'react';
import { z } from 'zod';
import { PageHeader } from '@/components/admin/Settings';
import { ResultBadge } from '@/components/mcp/ResultBadge';
import { Workspace } from '@/components/shell/Workspace';
import { api, isApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n/I18nContext';
import { callState, callTime, operationLabel, operationOf } from '@/lib/mcp/format';
import { grantsQuery, mcpKeys, overviewQuery, tokensQuery } from '@/lib/mcp/queries';

const RANGES = { h24: 24, d7: 24 * 7, d30: 24 * 30 } as const;

export const Route = createFileRoute('/_app/account/mcp/activity')({
  validateSearch: z.object({
    filter: ActivityFilter.optional(),
    grant: z.string().optional(),
    token: z.string().optional(),
    range: z.enum(['h24', 'd7', 'd30']).optional(),
    row: z.string().optional(),
  }),
  component: ActivityPage,
});

/** MCP etkinlik günlüğü (design 18.6): writes by default, one row opens with its details. */
function ActivityPage() {
  const { t, locale } = useI18n();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const qc = useQueryClient();
  const filter = search.filter ?? 'write';
  const range = search.range ?? 'h24';
  const [q, setQ] = useState('');
  const overview = useQuery(overviewQuery);
  const grants = useQuery(grantsQuery);
  const tokens = useQuery(tokensQuery);

  const query = {
    filter,
    grantId: search.grant,
    tokenId: search.token,
    q: q.trim() || undefined,
    hours: RANGES[range],
  };
  const list = useInfiniteQuery({
    queryKey: mcpKeys.activity(query),
    queryFn: ({ pageParam, signal }) =>
      api.call('listMcpActivity', {
        query: { ...query, limit: 50, ...(pageParam ? { cursor: pageParam } : {}) },
        signal,
      }),
    initialPageParam: '' as string,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const undo = useMutation({
    mutationFn: (callNo: string) => api.call('undoMcpToolCall', { params: { callNo } }),
    onSuccess: async () => {
      toast(t('mcp.activity.undone'));
      await qc.invalidateQueries({ queryKey: mcpKeys.all });
    },
    onError: (e) => toast(isApiError(e) ? t(`errors.${e.code}`) : t('errors.internal')),
  });

  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];
  const set = (patch: Partial<typeof search>) =>
    void navigate({ search: (s) => ({ ...s, ...patch }), replace: true });
  const clientValue = search.grant
    ? `g:${search.grant}`
    : search.token
      ? `t:${search.token}`
      : 'all';
  const o = overview.data;

  return (
    <Workspace crumbs={[{ label: t('account.title') }, { label: t('mcp.nav.activity') }]}>
      <PageHeader
        title={t('mcp.activity.title')}
        subtitle={
          o
            ? t('mcp.activity.subtitle', {
                calls: o.todayCalls,
                writes: o.todayWrites,
                pending: o.pendingApprovals,
                errors: o.todayErrors,
              })
            : undefined
        }
        actions={
          <Button
            size="sm"
            variant="out"
            disabled={rows.length === 0}
            onClick={() => downloadJson(rows)}
          >
            <Icon name="arrowUR" size={15} />
            {t('mcp.activity.export')}
          </Button>
        }
      />
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-[240px]">
          <Icon
            name="search"
            size={15}
            className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-fg3"
          />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('mcp.activity.search')}
            aria-label={t('mcp.activity.search')}
            className="h-9 pl-9"
          />
        </div>
        <Select value={range} onValueChange={(v) => set({ range: v as typeof range })}>
          <SelectTrigger
            className="h-9 w-auto min-w-[150px]"
            aria-label={t('mcp.activity.range.h24')}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(RANGES) as (keyof typeof RANGES)[]).map((r) => (
              <SelectItem key={r} value={r}>
                {t(`mcp.activity.range.${r}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={clientValue}
          onValueChange={(v) =>
            set({
              grant: v.startsWith('g:') ? v.slice(2) : undefined,
              token: v.startsWith('t:') ? v.slice(2) : undefined,
            })
          }
        >
          <SelectTrigger
            className="h-9 w-auto min-w-[170px]"
            aria-label={t('mcp.activity.cols.client')}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('mcp.activity.allClients')}</SelectItem>
            {grants.data?.items.map((g) => (
              <SelectItem key={g.id} value={`g:${g.id}`}>
                {g.label ? `${g.client.name} · ${g.label}` : g.client.name}
              </SelectItem>
            ))}
            {tokens.data?.items.map((k) => (
              <SelectItem key={k.id} value={`t:${k.id}`}>
                {k.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex flex-wrap gap-1.5">
          {ActivityFilter.options.map((f) => (
            <Chip key={f} size="sm" on={filter === f} onClick={() => set({ filter: f })}>
              {t(`mcp.activity.filters.${f}`)}
              {f === 'pending' && o?.pendingApprovals ? ` · ${o.pendingApprovals}` : ''}
            </Chip>
          ))}
        </div>
      </div>
      <div className="overflow-x-auto rounded-2xl bg-surface shadow-line">
        <Table>
          <thead>
            <tr>
              <Th>{t('mcp.activity.cols.time')}</Th>
              <Th>{t('mcp.activity.cols.client')}</Th>
              <Th>{t('mcp.activity.cols.tool')}</Th>
              <Th>{t('mcp.activity.cols.target')}</Th>
              <Th>{t('mcp.activity.cols.result')}</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {list.isPending ? (
              <tr>
                <Td colSpan={6}>
                  <Skeleton className="h-24" />
                </Td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <Td colSpan={6}>
                  <EmptyState icon="activity" title={t('mcp.activity.empty')} />
                </Td>
              </tr>
            ) : (
              rows.map((c) => {
                const open = search.row === c.id;
                const state = callState(c);
                return (
                  <Fragment key={c.id}>
                    <tr
                      className={cn('cursor-pointer hover:bg-bg2', open && 'bg-bg2')}
                      onClick={() => set({ row: open ? undefined : c.id })}
                    >
                      <Td className="font-mono text-xs whitespace-nowrap">
                        {callTime(c.at, locale)}
                      </Td>
                      <Td className="text-cap whitespace-nowrap">{c.via.name}</Td>
                      <Td className="font-mono text-xs">{c.tool}</Td>
                      <Td className="max-w-[320px] truncate text-cap">{callLabel(t, c) ?? '—'}</Td>
                      <Td>
                        {state === 'error' && c.errorCode ? (
                          <span className="font-mono text-xs text-danger">{c.errorCode}</span>
                        ) : (
                          <ResultBadge call={c} />
                        )}
                      </Td>
                      <Td
                        className="text-right whitespace-nowrap"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {state === 'pending' && c.approvalId ? (
                          <Button size="xs" variant="out" asChild>
                            <Link
                              to="/account/approvals/$approvalId"
                              params={{ approvalId: c.approvalId }}
                            >
                              {t('mcp.activity.review')}
                            </Link>
                          </Button>
                        ) : c.canUndo ? (
                          <Button
                            size="xs"
                            variant="gh"
                            loading={undo.isPending && undo.variables === c.id}
                            onClick={() => undo.mutate(c.id)}
                          >
                            <Icon name="undo" size={14} />
                            {t('mcp.activity.undo')}
                          </Button>
                        ) : null}
                      </Td>
                    </tr>
                    {open ? (
                      <tr>
                        <Td colSpan={6} className="bg-bg2">
                          <CallDetail call={c} />
                        </Td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })
            )}
          </tbody>
        </Table>
      </div>
      {list.hasNextPage ? (
        <Button
          size="sm"
          variant="out"
          className="self-center"
          loading={list.isFetchingNextPage}
          onClick={() => void list.fetchNextPage()}
        >
          {t('mcp.activity.more')}
        </Button>
      ) : null}
    </Workspace>
  );
}

/** What a row says it did: the operation of a bridge call, else the target or summary. */
function callLabel(t: ReturnType<typeof useI18n>['t'], call: ToolCall): string | null {
  const op = operationOf(call);
  if (op) return operationLabel(t, op);
  return call.target?.label ?? call.summary ?? null;
}

function CallDetail({ call }: { call: ToolCall }) {
  const { t } = useI18n();
  return (
    <div className="grid gap-4 py-2 md:grid-cols-2">
      <div className="flex min-w-0 flex-col gap-1.5">
        <span className="eyebrow">{t('mcp.activity.params')}</span>
        <pre className="m-0 max-h-72 overflow-auto rounded-lg bg-surface p-3 font-mono text-xs leading-5 shadow-line">
          {JSON.stringify(call.params, null, 2)}
        </pre>
      </div>
      <div className="flex min-w-0 flex-col gap-1.5">
        <span className="eyebrow">{t('mcp.activity.summary')}</span>
        <div className="flex flex-col gap-1 rounded-lg bg-surface p-3 text-cap shadow-line">
          <span className="font-semibold">{callLabel(t, call) ?? call.tool}</span>
          {call.errorCode ? (
            <span className="font-mono text-xs text-danger">{call.errorCode}</span>
          ) : null}
          <span className="font-mono text-xs text-fg3">
            {t('mcp.activity.meta', {
              requestId: call.requestId ?? '—',
              ms: call.durationMs ?? 0,
              ip: call.ip ?? '—',
            })}
          </span>
        </div>
      </div>
    </div>
  );
}

function downloadJson(rows: ToolCall[]) {
  const blob = new Blob([JSON.stringify(rows, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `mcp-activity-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
