import { type ApprovalSummary } from '@crewhall/shared';
import { cn, Count, IconBox, Skeleton } from '@crewhall/ui';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link, Outlet } from '@tanstack/react-router';
import { ACTION_ICON, approvalTitle } from '@/components/mcp/approvals';
import { Workspace } from '@/components/shell/Workspace';
import { formatDate, formatRelative } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { approvalsQuery } from '@/lib/mcp/queries';
import { useShownPath } from '@/lib/shell';
import { ResizablePane } from '@/components/shell/ResizablePane';

/** Onay bekleyenler (design 18.7): queue on the left, the chosen request on the right. */
export const Route = createFileRoute('/_app/account/approvals')({
  component: ApprovalsLayout,
});

function ApprovalsLayout() {
  const { t } = useI18n();
  const pending = useQuery(approvalsQuery('pending'));
  const history = useQuery(approvalsQuery('history'));
  // Phone (H10): the queue is the screen; a chosen request replaces it (back in the top bar).
  const atList = useShownPath() === '/account/approvals';
  return (
    <Workspace
      crumbs={[{ label: t('account.title') }, { label: t('mcp.approvals.title') }]}
      bodyClassName="flex-row gap-5 p-0"
    >
      <ResizablePane
        id="approvals-list"
        side="left"
        defaultWidth={320}
        className={atList ? 'max-md:w-full' : 'max-md:hidden'}
      >
        <aside
          className={cn(
            'flex w-full min-w-0 flex-col gap-1 overflow-y-auto border-r border-line px-3 py-4',
            atList ? 'max-md:w-full max-md:border-r-0' : 'max-md:hidden',
          )}
        >
          <div className="flex items-center justify-between px-2 pb-1">
            <span className="text-sm font-semibold">{t('mcp.approvals.pending')}</span>
            {pending.data?.items.length ? <Count>{pending.data.items.length}</Count> : null}
          </div>
          {pending.isPending ? <Skeleton className="h-16" /> : null}
          {pending.data?.items.length === 0 ? (
            <p className="m-0 px-2 text-xs text-fg2">{t('mcp.approvals.empty')}</p>
          ) : null}
          {pending.data?.items.map((a) => (
            <Row key={a.id} a={a} />
          ))}
          <div className="eyebrow px-2 pt-5 pb-1">{t('mcp.approvals.history')}</div>
          {history.data?.items.length === 0 ? (
            <p className="m-0 px-2 text-xs text-fg2">{t('mcp.approvals.emptyHistory')}</p>
          ) : null}
          {history.data?.items.map((a) => (
            <Row key={a.id} a={a} />
          ))}
        </aside>
      </ResizablePane>
      <div
        className={cn(
          'flex min-w-0 flex-1 flex-col overflow-y-auto px-2 py-6 pr-7 max-md:px-4',
          atList && 'max-md:hidden',
        )}
      >
        <Outlet />
      </div>
    </Workspace>
  );
}

function Row({ a }: { a: ApprovalSummary }) {
  const { t, locale } = useI18n();
  const when =
    a.status === 'pending'
      ? formatRelative(a.createdAt, locale)
      : formatDate(a.decidedAt ?? a.createdAt, locale, { day: 'numeric', month: 'short' });
  return (
    <Link
      to="/account/approvals/$approvalId"
      params={{ approvalId: a.id }}
      className={cn(
        'flex items-start gap-2.5 rounded-lg px-2 py-2.5 hover:bg-bg2',
        'data-[status=active]:bg-capsule',
      )}
    >
      <IconBox icon={ACTION_ICON[a.action] ?? 'shield'} size="sm" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-cap font-semibold">{approvalTitle(t, a)}</span>
        <span className="truncate text-xs text-fg">{a.target ?? a.title}</span>
        <span className="truncate text-xs text-fg3">
          {a.status === 'pending'
            ? `${a.via.name} · ${when}`
            : `${t(`mcp.approvals.status.${a.status}`)} · ${when}`}
        </span>
      </span>
    </Link>
  );
}
