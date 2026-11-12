import { type PortalPublish, type PortalPublishSummary } from '@crewhall/shared';
import {
  Avatar,
  Badge,
  Button,
  EmptyState,
  Icon,
  IconButton,
  Skeleton,
  Spinner,
  Table,
  Td,
  Th,
  toast,
  Tr,
} from '@crewhall/ui';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useState } from 'react';
import { api } from '@/lib/api';
import { errorKey } from '@/lib/errors';
import { formatDate, formatTime } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { invalidatePortal, publishesQuery, publishQuery } from '@/lib/portal/api';
import { usePortalSite } from '@/lib/portal/context';
import { useNow } from '@/lib/useNow';
import { CHANGE_ICON, useChangeText } from './changes';
import { ConfirmDialog, LocaleTag, PageHeader, Person, useDuration, useWhen } from './common';
import { PortalPage } from './PortalPage';
import { ResizablePane } from '@/components/shell/ResizablePane';

/** 10.12 Publish history: immutable records, per-item or whole reverts, job retries. */
export function PublishHistory() {
  const { t } = useI18n();
  const { site } = usePortalSite();
  const navigate = useNavigate();
  const search = useSearch({ from: '/_app/portal/$siteSlug/publishes' });
  const list = useInfiniteQuery(publishesQuery(site.id));
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];
  const when = useWhen();
  const select = (sel?: string) =>
    void navigate({
      to: '/portal/$siteSlug/publishes',
      params: { siteSlug: site.slug },
      search: sel ? { sel } : {},
    });

  return (
    <PortalPage
      crumbs={[{ label: t('portal.nav.publishes') }]}
      panel={
        search.sel ? (
          <PublishPanel
            key={search.sel}
            publishId={search.sel}
            onClose={() => select()}
            onOpen={select}
          />
        ) : null
      }
    >
      <PageHeader title={t('portal.nav.publishes')} subtitle={t('portal.history.subtitle')} />
      <div className="overflow-hidden rounded-2xl bg-surface shadow-line">
        <Table aria-label={t('portal.nav.publishes')}>
          <thead>
            <tr>
              <Th>{t('portal.history.col.number')}</Th>
              <Th>{t('portal.history.col.content')}</Th>
              <Th>{t('portal.history.col.who')}</Th>
              <Th className="text-right">{t('portal.history.col.urls')}</Th>
              <Th>{t('portal.history.col.result')}</Th>
            </tr>
          </thead>
          <tbody>
            {list.isPending ? (
              <tr>
                <Td colSpan={5}>
                  <Skeleton className="h-5" />
                </Td>
              </tr>
            ) : !rows.length ? (
              <tr>
                <Td colSpan={5}>
                  <EmptyState icon="history" title={t('portal.history.empty')} />
                </Td>
              </tr>
            ) : (
              rows.map((p) => (
                <Tr
                  key={p.id}
                  selected={p.id === search.sel}
                  tabIndex={0}
                  className="cursor-pointer hover:[&>td]:bg-bg2"
                  onClick={() => select(p.id)}
                  onKeyDown={(e) => e.key === 'Enter' && select(p.id)}
                >
                  <Td className="font-semibold tn">#{p.number}</Td>
                  <Td className="max-w-[360px] truncate">
                    {p.revertOf
                      ? t('portal.history.revertOf', { n: p.revertOf, text: p.titles.join(', ') })
                      : p.titles.join(', ')}
                  </Td>
                  <Td>
                    <span className="flex items-center gap-2">
                      <Person user={p.actor} />
                      <span className="text-fg2">{when(p.createdAt)}</span>
                    </span>
                  </Td>
                  <Td className="text-right tn">{p.pathCount}</Td>
                  <Td>
                    <ResultBadge p={p} />
                  </Td>
                </Tr>
              ))
            )}
          </tbody>
        </Table>
      </div>
      {list.hasNextPage ? (
        <Button
          variant="out"
          size="sm"
          className="self-center"
          loading={list.isFetchingNextPage}
          onClick={() => void list.fetchNextPage()}
        >
          {t('portal.history.more')}
        </Button>
      ) : null}
    </PortalPage>
  );
}

function ResultBadge({ p }: { p: PortalPublishSummary }) {
  const { t } = useI18n();
  const duration = useDuration();
  if (p.revertedBy) return <Badge plain>{t('portal.history.reverted', { n: p.revertedBy })}</Badge>;
  if (p.status === 'running' || p.status === 'queued') {
    return <Badge tone="info">{t('portal.history.running')}</Badge>;
  }
  if (p.status === 'failed') return <Badge tone="danger">{t('portal.history.failed')}</Badge>;
  if (p.status === 'partial') return <Badge tone="warn">{t('portal.history.partial')}</Badge>;
  return <Badge tone="ok">{duration(p.durationMs)}</Badge>;
}

const itemKey = (siteId: string, i: PortalPublish['items'][number]) =>
  `${i.kind}:${i.id ?? siteId}`;

function PublishPanel({
  publishId,
  onClose,
  onOpen,
}: {
  publishId: string;
  onClose: () => void;
  onOpen: (id: string) => void;
}) {
  const { t, locale } = useI18n();
  const { site } = usePortalSite();
  const qc = useQueryClient();
  const duration = useDuration();
  const when = useWhen();
  const text = useChangeText();
  const q = useQuery({
    ...publishQuery(publishId),
    refetchInterval: (query) =>
      query.state.data?.jobs.some((j) => j.status === 'running') ? 1000 : false,
  });
  const [confirmAll, setConfirmAll] = useState(false);
  const now = useNow(60_000);
  const p = q.data;
  const canPublish = site.capabilities.publish;

  const revert = useMutation({
    mutationFn: (keys?: string[]) =>
      api.call('revertPortalPublish', { params: { publishId }, body: { keys } }),
    onSuccess: (r) => {
      invalidatePortal(qc, { editors: true });
      toast(t('portal.history.revertedToast', { n: r.number }));
      onOpen(r.id);
    },
    onError: (e) => toast(t(errorKey(e))),
  });
  const retry = useMutation({
    mutationFn: (jobId: string) => api.call('retryPortalPublishJob', { params: { jobId } }),
    onSuccess: () => {
      invalidatePortal(qc);
      void q.refetch();
    },
    onError: (e) => toast(t(errorKey(e))),
  });

  return (
    <ResizablePane id="portal-history" side="right" defaultWidth={360}>
      <aside
        aria-label={p ? t('portal.history.panelTitle', { n: p.number }) : t('portal.nav.publishes')}
        className="flex w-full min-w-0 flex-col gap-4 overflow-y-auto border-l border-line px-5 py-4"
      >
        <div className="flex items-center gap-2">
          <h2 className="m-0 flex-1 text-sub font-semibold">
            {p ? t('portal.history.panelTitle', { n: p.number }) : ''}
          </h2>
          <IconButton
            aria-label={t('portal.common.close')}
            size="sm"
            tone="plain"
            onClick={onClose}
          >
            <Icon name="x" size={16} />
          </IconButton>
        </div>
        {!p ? (
          <Skeleton className="h-40" />
        ) : (
          <>
            <div className="flex items-center gap-2.5">
              {p.actor ? <Avatar name={p.actor.name} src={p.actor.imageUrl} size="md" /> : null}
              <div className="flex min-w-0 flex-col">
                <span className="truncate text-[13.5px] font-semibold">{p.actor?.name}</span>
                <span className="text-xs text-fg2">
                  {`${formatDate(p.createdAt, locale)} ${formatTime(p.createdAt, locale)}`}
                  {p.durationMs
                    ? ` · ${t('portal.history.took', { value: duration(p.durationMs) })}`
                    : ''}
                </span>
              </div>
            </div>
            {p.note ? <p className="rounded-lg bg-bg2 px-3 py-2 text-[13px]">“{p.note}”</p> : null}
            {p.revertOf ? (
              <p className="text-xs text-fg2">
                {t('portal.history.revertOfNote', { n: p.revertOf })}
              </p>
            ) : null}
            <section className="flex flex-col gap-1.5">
              <span className="eyebrow">{t('portal.history.items')}</span>
              {p.items.map((i) => (
                <div key={itemKey(site.id, i)} className="flex items-center gap-2 py-1 text-[13px]">
                  <Icon name={CHANGE_ICON[i.kind]} size={14} className="shrink-0 text-fg2" />
                  {i.kind === 'doc' && i.id ? (
                    <Link
                      to="/portal/$siteSlug/docs"
                      params={{ siteSlug: site.slug }}
                      search={{ doc: i.id }}
                      className="min-w-0 flex-1 truncate font-semibold hover:underline"
                    >
                      {text.title(i)}
                    </Link>
                  ) : (
                    <span className="min-w-0 flex-1 truncate font-semibold">{text.title(i)}</span>
                  )}
                  {i.locale ? <LocaleTag code={i.locale} /> : null}
                  {i.scheduledAt ? (
                    <span className="text-xs text-fg2">{when(i.scheduledAt)}</span>
                  ) : null}
                  {canPublish && !p.revertedBy ? (
                    <Button
                      size="xs"
                      variant="gh"
                      disabled={revert.isPending}
                      onClick={() => revert.mutate([itemKey(site.id, i)])}
                    >
                      {i.scheduledAt && new Date(i.scheduledAt).getTime() > now
                        ? t('portal.history.cancelSchedule')
                        : t('portal.history.revertItem')}
                    </Button>
                  ) : null}
                </div>
              ))}
            </section>
            <section className="flex flex-col gap-1.5">
              <span className="eyebrow">{t('portal.history.jobs')}</span>
              {p.jobs.map((j) => (
                <div key={j.id} className="flex flex-col gap-1 rounded-lg bg-bg2 px-3 py-2 text-xs">
                  <div className="flex items-center gap-2">
                    {j.status === 'running' ? (
                      <Spinner size={12} />
                    ) : (
                      <span
                        className={
                          j.status === 'done'
                            ? 'size-2 rounded-full bg-success'
                            : j.status === 'failed'
                              ? 'size-2 rounded-full bg-danger'
                              : 'size-2 rounded-full bg-fg3'
                        }
                      />
                    )}
                    <span className="min-w-0 flex-1 truncate font-mono">{j.paths.join(' · ')}</span>
                    <span className="shrink-0 text-fg2">
                      {j.status === 'queued' ? when(j.runAt) : duration(j.durationMs)}
                    </span>
                  </div>
                  {j.attempts > 1 || j.error ? (
                    <div className="flex items-center gap-2 text-fg2">
                      {j.attempts > 1 ? (
                        <span>{t('portal.history.attempts', { count: j.attempts })}</span>
                      ) : null}
                      {j.error ? (
                        <span className="text-danger">
                          {`${j.httpStatus ?? ''} ${j.error}`.trim()}
                        </span>
                      ) : null}
                      {j.status === 'failed' && canPublish ? (
                        <Button
                          size="xs"
                          variant="out"
                          className="ml-auto"
                          loading={retry.isPending}
                          onClick={() => retry.mutate(j.id)}
                        >
                          {t('portal.history.retry')}
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ))}
            </section>
            {canPublish && !p.revertedBy ? (
              <Button variant="out" size="sm" onClick={() => setConfirmAll(true)}>
                <Icon name="undo" size={16} />
                {t('portal.history.revertAll')}
              </Button>
            ) : null}
            <p className="text-xs text-fg2">{t('portal.history.revertHint')}</p>
            <ConfirmDialog
              open={confirmAll}
              onOpenChange={setConfirmAll}
              title={t('portal.history.revertAllTitle', { n: p.number })}
              description={t('portal.history.revertAllBody')}
              confirm={t('portal.history.revertAll')}
              onConfirm={() => revert.mutateAsync(undefined)}
            />
          </>
        )}
      </aside>
    </ResizablePane>
  );
}
