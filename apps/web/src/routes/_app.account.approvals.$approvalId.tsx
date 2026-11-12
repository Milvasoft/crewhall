import {
  Badge,
  Button,
  EmptyState,
  Icon,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  toast,
} from '@crewhall/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useEffect } from 'react';
import { Notice } from '@/components/auth/AuthLayout';
import { ACTION_ICON, approvalTitle, STATUS_TONE } from '@/components/mcp/approvals';
import { useReauth } from '@/components/mcp/ReauthDialog';
import { api, isApiError } from '@/lib/api';
import { formatDate, formatTime } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { approvalQuery, mcpKeys } from '@/lib/mcp/queries';
import { useMe } from '@/lib/session';
import { useNow } from '@/lib/useNow';

export const Route = createFileRoute('/_app/account/approvals/$approvalId')({
  component: ApprovalDetailPage,
});

function remaining(until: string, now: Date, locale: 'tr' | 'en') {
  const ms = Math.max(0, new Date(until).getTime() - now.getTime());
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return locale === 'tr' ? `${h} sa ${m} dk` : `${h} h ${m} min`;
}

/**
 * One request (18.7): what exactly would happen, frozen; the client's note is shown as
 * unverified text. Approving needs a passkey or password check in the last 10 minutes.
 */
function ApprovalDetailPage() {
  const { approvalId } = Route.useParams();
  const { t, locale } = useI18n();
  const me = useMe();
  const now = useNow(30_000);
  const qc = useQueryClient();
  const detail = useQuery({
    ...approvalQuery(approvalId),
    // Approved requests are applied by the worker; follow until the outcome is known.
    refetchInterval: (q) => (q.state.data?.status === 'approved' ? 1500 : false),
  });
  const status = detail.data?.status;
  useEffect(() => {
    // The outcome changes the queue, the activity and the counts in the menu.
    if (status && status !== 'pending' && status !== 'approved') {
      void qc.invalidateQueries({ queryKey: mcpKeys.all, refetchType: 'active' });
    }
  }, [status, qc]);
  const reauth = useReauth();

  const refresh = () => qc.invalidateQueries({ queryKey: mcpKeys.all });
  const approve = useMutation({
    mutationFn: () => api.call('approveMcpApproval', { params: { approvalId } }),
    onSuccess: async (res) => {
      toast(
        res.status === 'applied'
          ? t('mcp.approvals.approved')
          : t(`mcp.approvals.status.${res.status}`),
      );
      await refresh();
    },
    onError: async (e) => {
      if (reauth.handle(e, () => approve.mutate())) return;
      toast(isApiError(e) ? t(`errors.${e.code}`) : t('errors.internal'));
      await refresh();
    },
  });
  const reject = useMutation({
    mutationFn: () => api.call('rejectMcpApproval', { params: { approvalId }, body: {} }),
    onSuccess: async () => {
      toast(t('mcp.approvals.rejectedToast'));
      await refresh();
    },
    onError: (e) => toast(isApiError(e) ? t(`errors.${e.code}`) : t('errors.internal')),
  });

  if (detail.isError) {
    return <EmptyState icon="shield" title={t('errors.not_found')} className="mt-16" />;
  }
  const a = detail.data;
  if (!a) return <Skeleton className="h-96 rounded-2xl" />;
  const pending = a.status === 'pending';
  const action = approvalTitle(t, a);

  return (
    <div className="flex max-w-[860px] flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="m-0 text-wtitle font-bold">
            {t('mcp.approvals.headline', {
              client: a.via.name,
              action,
            })}
          </h1>
          <span className="text-cap text-fg2">
            {t('mcp.approvals.via', {
              client: a.via.name,
              name: me?.user.name ?? '',
              time: formatTime(a.createdAt, locale),
            })}
            {pending
              ? ` · ${t('mcp.approvals.expiresIn', { time: remaining(a.expiresAt, new Date(now), locale) })}`
              : ''}
          </span>
        </div>
        <Badge tone={STATUS_TONE[a.status]}>{t(`mcp.approvals.status.${a.status}`)}</Badge>
      </div>

      {a.clientNote ? (
        <div className="flex flex-col gap-1 rounded-lg bg-bg2 px-3.5 py-3">
          <span className="text-xs font-semibold">
            {t('mcp.approvals.clientNote')}{' '}
            <span className="font-normal text-fg3">· {t('mcp.approvals.unverified')}</span>
          </span>
          <span className="text-cap text-fg2 italic">{a.clientNote}</span>
        </div>
      ) : null}

      <div className="flex flex-col overflow-hidden rounded-xl shadow-line2">
        {a.items.map((item, i) => (
          <div
            key={i}
            className="flex items-center gap-2.5 border-t border-line px-3.5 py-2.5 first:border-t-0"
          >
            <Icon
              name={item.kind === 'folder' ? 'grid' : item.kind === 'page' ? 'page' : 'file'}
              size={16}
              className="text-fg2"
            />
            <span className="min-w-0 flex-1 truncate text-cap font-semibold">{item.label}</span>
            {item.location ? (
              <span className="truncate text-xs text-fg3">{item.location}</span>
            ) : null}
          </div>
        ))}
        <div className="flex items-center gap-2 border-t border-line bg-bg2 px-3.5 py-2 text-xs text-fg2">
          <Icon name={ACTION_ICON[a.action] ?? 'shield'} size={14} />
          {action} · {t('mcp.approvals.count', { count: a.itemCount })}
        </div>
      </div>

      {a.status === 'stale' ? <Notice tone="warn">{t('mcp.approvals.staleBody')}</Notice> : null}
      {a.status === 'failed' ? (
        <Notice tone="error">{t('mcp.approvals.failedBody', { code: a.errorCode ?? '—' })}</Notice>
      ) : null}
      {a.decidedBy && a.decidedAt ? (
        <span className="text-xs text-fg2">
          {t(`mcp.approvals.status.${a.status}`)} ·{' '}
          {t('mcp.approvals.decidedBy', {
            name: a.decidedBy.name,
            time: formatDate(a.decidedAt, locale, {
              day: 'numeric',
              month: 'short',
              hour: '2-digit',
              minute: '2-digit',
            }),
          })}
        </span>
      ) : null}

      <Tabs defaultValue="preview" className="flex flex-col gap-3">
        <TabsList>
          <TabsTrigger value="preview">{t('mcp.approvals.tabs.preview')}</TabsTrigger>
          <TabsTrigger value="payload">{t('mcp.approvals.tabs.payload')}</TabsTrigger>
        </TabsList>
        <TabsContent
          value="preview"
          className="rounded-xl bg-surface p-4 text-sm text-fg2 shadow-line"
        >
          {t('mcp.approvals.frozen')}
        </TabsContent>
        <TabsContent value="payload">
          <pre className="m-0 overflow-auto rounded-xl bg-bg2 p-4 font-mono text-xs leading-5">
            {JSON.stringify({ tool: a.tool, ...a.payload }, null, 2)}
          </pre>
        </TabsContent>
      </Tabs>

      {pending ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
          <span className="inline-flex items-center gap-1.5 text-xs text-fg2">
            <Icon name="key" size={14} />
            {t('mcp.approvals.approveNote')}
          </span>
          <div className="flex gap-2">
            <Button variant="dng" loading={reject.isPending} onClick={() => reject.mutate()}>
              {t('mcp.approvals.reject')}
            </Button>
            <Button
              variant="pri"
              loading={approve.isPending}
              onClick={() =>
                a.needsReauth ? reauth.ask(() => approve.mutate()) : approve.mutate()
              }
            >
              {t('mcp.approvals.approve')}
            </Button>
          </div>
        </div>
      ) : null}
      {reauth.dialog}
    </div>
  );
}
