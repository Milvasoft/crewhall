import { type ChatReport, type ChatReportStatus } from '@crewhall/shared';
import { Avatar, Badge, Button, EmptyState, Icon, Segmented, Skeleton, toast } from '@crewhall/ui';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { PageHeader } from '@/components/admin/Settings';
import { NavItem } from '@/components/spaces/SpaceSidebar';
import { Workspace } from '@/components/shell/Workspace';
import { api } from '@/lib/api';
import { errorKey } from '@/lib/errors';
import { formatRelative } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { usePermissions } from '@/lib/session';
import { useReportsEnabled } from './report';

/** Yönetim › Bildirilen içerik: chat reports for the org's owners and admins (API 54). */

type Filter = ChatReportStatus | 'all';

export const chatReportKeys = {
  all: ['chatReports'] as const,
  list: (filter: Filter) => ['chatReports', filter] as const,
};

/** Sidebar entry: owners and admins, on a server that takes reports. */
export function ChatReportsAdminNav() {
  const { t } = useI18n();
  const { canOrg } = usePermissions();
  const on = useReportsEnabled();
  if (!on || !canOrg('chat.review_reports')) return null;
  return <NavItem icon="flag" to="/admin/reports" label={t('chat.reports.nav')} />;
}

export function ChatReportsPage() {
  const { t } = useI18n();
  const [filter, setFilter] = useState<Filter>('open');
  const list = useInfiniteQuery({
    queryKey: chatReportKeys.list(filter),
    queryFn: ({ pageParam }) =>
      api.call('listChatReports', {
        query: {
          ...(filter === 'all' ? {} : { status: filter }),
          ...(pageParam ? { cursor: pageParam } : {}),
          limit: 30,
        },
      }),
    initialPageParam: '' as string,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <Workspace crumbs={[{ label: t('admin.title') }, { label: t('chat.reports.title') }]}>
      <PageHeader
        title={t('chat.reports.title')}
        subtitle={t('chat.reports.subtitle')}
        actions={
          <Segmented
            aria-label={t('chat.reports.title')}
            value={filter}
            onValueChange={setFilter}
            options={[
              { value: 'open', label: t('chat.reports.status.open') },
              { value: 'resolved', label: t('chat.reports.status.resolved') },
              { value: 'dismissed', label: t('chat.reports.status.dismissed') },
              { value: 'all', label: t('chat.reports.filter.all') },
            ]}
          />
        }
      />
      <div className="mt-5 flex flex-col gap-3">
        {list.isPending ? (
          <div className="flex flex-col gap-3" aria-busy="true">
            <Skeleton className="h-28 w-full rounded-xl" />
            <Skeleton className="h-28 w-full rounded-xl" />
          </div>
        ) : list.isError ? (
          <p role="alert" className="m-0 text-cap text-danger">
            {t(errorKey(list.error))}
          </p>
        ) : items.length === 0 ? (
          <EmptyState
            icon="flag"
            title={filter === 'open' ? t('chat.reports.emptyOpen') : t('chat.reports.empty')}
          />
        ) : (
          <ul className="m-0 flex list-none flex-col gap-3 p-0" aria-label={t('chat.reports.title')}>
            {items.map((r) => (
              <ReportRow key={r.id} report={r} />
            ))}
          </ul>
        )}
        {list.hasNextPage ? (
          <Button
            variant="out"
            className="self-center"
            loading={list.isFetchingNextPage}
            onClick={() => void list.fetchNextPage()}
          >
            {t('chat.reports.loadMore')}
          </Button>
        ) : null}
      </div>
    </Workspace>
  );
}

const STATUS_TONE = { open: 'warn', resolved: 'ok', dismissed: 'default' } as const;

function ReportRow({ report: r }: { report: ChatReport }) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const resolve = useMutation({
    mutationFn: (status: ChatReportStatus) =>
      api.call('resolveChatReport', { params: { reportId: r.id }, body: { status } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: chatReportKeys.all }),
    onError: (e) => toast.error(t(errorKey(e))),
  });
  const nameOf = (u: ChatReport['reporter']) => u?.name ?? t('chat.reports.unknownUser');
  const m = r.message;

  return (
    <li
      className="flex flex-col gap-3 rounded-xl p-4 shadow-line"
      data-report={r.id}
      aria-label={t(`chat.reports.kind.${r.kind}`)}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={STATUS_TONE[r.status]}>{t(`chat.reports.status.${r.status}`)}</Badge>
        <Badge plain>{t(`chat.reports.kind.${r.kind}`)}</Badge>
        <span className="text-cap font-semibold">{t(`chat.reports.reason.${r.reason}`)}</span>
        <span className="ml-auto text-xs text-fg2">
          {t('chat.reports.reportedBy', {
            name: nameOf(r.reporter),
            time: formatRelative(r.createdAt, locale),
          })}
        </span>
      </div>

      <div className="flex items-center gap-2.5">
        <Avatar
          name={nameOf(r.reportedUser)}
          src={r.reportedUser?.imageUrl ?? null}
          size="sm"
        />
        <span className="text-cap">
          {m
            ? t('chat.reports.author', { name: nameOf(r.reportedUser) })
            : t('chat.reports.reportedUser', { name: nameOf(r.reportedUser) })}
        </span>
        {r.reportedUser ? (
          <Link
            to="/people/$userId"
            params={{ userId: r.reportedUser.id }}
            className="text-xs font-semibold text-fg2 hover:text-fg hover:underline"
          >
            {t('chat.person.profile')}
          </Link>
        ) : null}
      </div>

      {m ? (
        <figure className="m-0 flex flex-col gap-1.5 rounded-lg bg-bg2 px-3 py-2.5">
          <figcaption className="text-xs text-fg2">
            {m.conversationTitle
              ? t('chat.reports.inConversation', { name: m.conversationTitle })
              : t('chat.reports.inDirect')}
          </figcaption>
          <blockquote className="m-0 line-clamp-6 text-cap whitespace-pre-wrap">
            {m.excerpt}
          </blockquote>
          {m.url ? (
            <a
              href={m.url}
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                e.preventDefault();
                void navigate({ href: m.url! });
              }}
              className="inline-flex items-center gap-1 self-start text-xs font-semibold text-fg2 hover:text-fg hover:underline"
            >
              <Icon name="arrowR" size={13} />
              {t('chat.reports.openMessage')}
            </a>
          ) : m.deleted ? (
            <span className="text-xs text-fg3 italic">{t('chat.reports.deleted')}</span>
          ) : null}
        </figure>
      ) : null}

      {r.note ? <p className="m-0 text-cap whitespace-pre-wrap text-fg2">“{r.note}”</p> : null}

      <div className="flex flex-wrap items-center gap-2">
        {r.status !== 'open' && r.resolvedAt ? (
          <span className="mr-auto text-xs text-fg2">
            {t('chat.reports.closedBy', {
              status: t(`chat.reports.status.${r.status}`),
              name: nameOf(r.resolvedBy),
              time: formatRelative(r.resolvedAt, locale),
            })}
          </span>
        ) : (
          <span className="mr-auto" />
        )}
        {r.status === 'open' ? (
          <>
            <Button
              size="sm"
              variant="gh"
              disabled={resolve.isPending}
              onClick={() => resolve.mutate('dismissed')}
            >
              {t('chat.reports.dismiss')}
            </Button>
            <Button
              size="sm"
              variant="inv"
              disabled={resolve.isPending}
              onClick={() => resolve.mutate('resolved')}
            >
              <Icon name="check" size={15} />
              {t('chat.reports.resolve')}
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant="out"
            disabled={resolve.isPending}
            onClick={() => resolve.mutate('open')}
          >
            {t('chat.reports.reopen')}
          </Button>
        )}
      </div>
    </li>
  );
}
