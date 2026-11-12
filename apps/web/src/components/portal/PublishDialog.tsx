import { type PortalPublish } from '@crewhall/shared';
import {
  Button,
  Checkbox,
  CheckboxRow,
  cn,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  EmptyState,
  Icon,
  Skeleton,
  Spinner,
  Badge,
  toast,
} from '@crewhall/ui';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { errorKey } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/I18nContext';
import { changesQuery, invalidatePortal, portalKeys, publishQuery } from '@/lib/portal/api';
import { setPublishOpen, usePortalSite, usePublishOpen } from '@/lib/portal/context';
import { siteHref } from '@/lib/portal/format';
import { CHANGE_ICON, useChangeText } from './changes';
import { LocaleTag, Person, useDuration, useWhen } from './common';

/**
 * 10.11 Publish dialog: pick changes from the site's single queue, see the URLs the server will
 * revalidate (now and at scheduled times), add a note, publish, then follow the jobs.
 */
export function PublishDialog() {
  const open = usePublishOpen();
  return (
    <Dialog open={open} onOpenChange={setPublishOpen}>
      {open ? <PublishBody /> : null}
    </Dialog>
  );
}

function PublishBody() {
  const { t } = useI18n();
  const { site } = usePortalSite();
  const qc = useQueryClient();
  const text = useChangeText();
  const when = useWhen();
  const changes = useQuery(changesQuery(site.id));
  const items = useMemo(() => changes.data?.items ?? [], [changes.data]);
  const [excluded, setExcluded] = useState<Set<string>>(() => new Set());
  const [note, setNote] = useState('');
  const [publishId, setPublishId] = useState<string | null>(null);
  const keys = items.filter((c) => !excluded.has(c.key)).map((c) => c.key);
  const people = new Set(items.map((c) => c.changedBy?.id).filter(Boolean)).size;

  const preview = useQuery({
    queryKey: ['portal', 'publishPreview', site.id, keys],
    queryFn: ({ signal }) =>
      api.call('previewPortalPublish', { params: { siteId: site.id }, body: { keys }, signal }),
    enabled: keys.length > 0 && !publishId,
    placeholderData: keepPreviousData,
  });

  const publish = useMutation({
    mutationFn: () =>
      api.call('publishPortal', {
        params: { siteId: site.id },
        body: { keys, note: note.trim() || null },
      }),
    onSuccess: (p) => {
      qc.setQueryData(publishQuery(p.id).queryKey, p);
      setPublishId(p.id);
      invalidatePortal(qc, { editors: true });
    },
    onError: (e) => toast(t(errorKey(e))),
  });

  if (publishId) return <PublishResult publishId={publishId} />;

  const now = preview.data?.paths ?? [];
  const later = preview.data?.scheduled ?? [];
  const laterCount = later.reduce((a, x) => a + x.paths.length, 0);

  return (
    <DialogContent width={620} className="gap-5">
      <DialogHeader
        title={t('portal.publish.title')}
        description={
          items.length
            ? t('portal.publish.subtitle', {
                name: site.domain ?? site.name,
                count: items.length,
                people,
              })
            : (site.domain ?? site.name)
        }
      />
      {changes.isPending ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </div>
      ) : !items.length ? (
        <EmptyState
          icon="checkC"
          title={t('portal.publish.empty')}
          description={t('portal.publish.emptyHint')}
        />
      ) : (
        <>
          <CheckboxRow
            className="-mb-2 px-1"
            checked={
              excluded.size === 0 ? true : excluded.size === items.length ? false : 'indeterminate'
            }
            onCheckedChange={(v) =>
              setExcluded(v === true ? new Set() : new Set(items.map((c) => c.key)))
            }
          >
            {t('portal.publish.selectAll', { count: items.length })}
          </CheckboxRow>
          <ul
            aria-label={t('portal.publish.changes')}
            className="flex max-h-[300px] flex-col gap-px overflow-y-auto rounded-xl bg-bg2 p-1"
          >
            {items.map((c) => {
              const id = `pub-${c.key}`;
              return (
                <li
                  key={c.key}
                  className="flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-capsule"
                >
                  <Checkbox
                    id={id}
                    checked={!excluded.has(c.key)}
                    onCheckedChange={(v) =>
                      setExcluded((prev) => {
                        const n = new Set(prev);
                        if (v === true) n.delete(c.key);
                        else n.add(c.key);
                        return n;
                      })
                    }
                  />
                  <Icon name={CHANGE_ICON[c.kind]} size={16} className="shrink-0 text-fg2" />
                  <label htmlFor={id} className="flex min-w-0 flex-1 cursor-pointer flex-col">
                    <span className="flex items-center gap-1.5 text-[13.5px] font-semibold">
                      <span className="truncate">{text.title(c)}</span>
                      {c.locale ? <LocaleTag code={c.locale} /> : null}
                    </span>
                    <span className="truncate text-xs text-fg2">{text.detail(c)}</span>
                  </label>
                  {c.action === 'schedule' ? (
                    <Badge tone="info">{t('portal.status.scheduled')}</Badge>
                  ) : null}
                  <Person user={c.changedBy} />
                </li>
              );
            })}
          </ul>
          <section className="flex flex-col gap-2" aria-label={t('portal.publish.urls')}>
            <div className="flex items-center justify-between">
              <span className="text-cap font-semibold">{t('portal.publish.urls')}</span>
              <span className="text-xs text-fg2">
                {laterCount
                  ? t('portal.publish.urlCountLater', { count: now.length, n: laterCount })
                  : t('portal.publish.urlCount', { count: now.length })}
              </span>
            </div>
            <div
              className={cn(
                'flex max-h-40 flex-col gap-0.5 overflow-y-auto rounded-lg bg-bg2 px-3.5 py-2.5 font-mono text-xs',
                preview.isFetching && 'opacity-60',
              )}
            >
              {keys.length === 0 ? (
                <span className="font-sans text-fg2">{t('portal.publish.noneSelected')}</span>
              ) : (
                <>
                  {now.map((p) => (
                    <span key={p} className="truncate">
                      {p}
                    </span>
                  ))}
                  {later.map((x) => (
                    <span key={x.at} className="truncate text-fg2">
                      {when(x.at)} → {x.paths.join(' · ')}
                    </span>
                  ))}
                </>
              )}
            </div>
          </section>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-fg2">{t('portal.publish.note')}</span>
            <input
              value={note}
              maxLength={500}
              onChange={(e) => setNote(e.target.value)}
              placeholder={t('portal.publish.notePlaceholder')}
              className="h-10 rounded-md bg-bg2 px-3 text-sm outline-none focus:bg-surface focus:shadow-[inset_0_0_0_1.5px_var(--fg)]"
            />
          </label>
          <p className="flex gap-2 rounded-lg bg-bg2 px-3.5 py-2.5 text-xs text-fg2">
            <Icon name="bolt" size={16} className="shrink-0" />
            {t('portal.publish.hint')}
          </p>
        </>
      )}
      <DialogFooter>
        <Button variant="gh" size="sm" onClick={() => setPublishOpen(false)}>
          {t('portal.common.cancel')}
        </Button>
        {items.length ? (
          <Button
            variant="pri"
            size="sm"
            disabled={!keys.length}
            loading={publish.isPending}
            onClick={() => publish.mutate()}
          >
            <Icon name="upload" size={16} />
            {t('portal.publish.submit', { count: keys.length })}
          </Button>
        ) : null}
      </DialogFooter>
    </DialogContent>
  );
}

const isActive = (p: PortalPublish) =>
  p.jobs.some(
    (j) =>
      j.status === 'running' ||
      (j.status === 'queued' && new Date(j.runAt).getTime() <= Date.now()),
  );

function PublishResult({ publishId }: { publishId: string }) {
  const { t } = useI18n();
  const { site } = usePortalSite();
  const qc = useQueryClient();
  const when = useWhen();
  const duration = useDuration();
  const q = useQuery({
    ...publishQuery(publishId),
    refetchInterval: (query) => (query.state.data && isActive(query.state.data) ? 700 : false),
  });
  const p = q.data;
  const running = !p || isActive(p);
  const failed = p?.jobs.filter((j) => j.status === 'failed') ?? [];
  const scheduled = p?.jobs.filter((j) => j.status === 'queued') ?? [];
  const now =
    p?.jobs.filter((j) => j.status !== 'queued').reduce((a, j) => a + j.paths.length, 0) ?? 0;
  const href = siteHref(site);
  const finished = Boolean(p) && !running;
  useEffect(() => {
    // Job results show up in the history and overview.
    if (finished) {
      void qc.invalidateQueries({
        queryKey: portalKeys.all,
        predicate: (x) => x.queryKey[1] === 'publishes' || x.queryKey[1] === 'overview',
      });
    }
  }, [finished, qc]);

  return (
    <DialogContent width={520} className="gap-5">
      <DialogHeader
        icon={running ? 'upload' : failed.length ? 'alert' : 'checkC'}
        title={
          running
            ? t('portal.publish.running', { n: p?.number ?? 0 })
            : failed.length
              ? t('portal.publish.partial', { count: failed.length })
              : t('portal.publish.done', { count: now, value: duration(p?.durationMs ?? 0) })
        }
        description={
          scheduled.length
            ? t('portal.publish.scheduledNote', { when: when(scheduled[0]!.runAt) })
            : t('portal.publish.number', { n: p?.number ?? 0 })
        }
      />
      <ul aria-label={t('portal.history.jobs')} className="flex flex-col gap-1.5">
        {(p?.jobs ?? []).map((j) => (
          <li key={j.id} className="flex items-center gap-2.5 rounded-lg bg-bg2 px-3 py-2 text-xs">
            {j.status === 'running' ? (
              <Spinner size={14} />
            ) : (
              <Icon
                name={j.status === 'done' ? 'check' : j.status === 'failed' ? 'alert' : 'clock'}
                size={14}
                className={
                  j.status === 'failed'
                    ? 'text-danger'
                    : j.status === 'done'
                      ? 'text-success'
                      : 'text-fg2'
                }
              />
            )}
            <span className="min-w-0 flex-1 truncate font-mono">{j.paths.join(' · ')}</span>
            <span className="shrink-0 text-fg2">
              {j.status === 'queued' ? when(j.runAt) : duration(j.durationMs)}
            </span>
          </li>
        ))}
      </ul>
      <DialogFooter>
        <Button variant="gh" size="sm" asChild>
          <Link
            to="/portal/$siteSlug/publishes"
            params={{ siteSlug: site.slug }}
            search={{ sel: publishId }}
            onClick={() => setPublishOpen(false)}
          >
            {t('portal.publish.toHistory')}
          </Link>
        </Button>
        {href ? (
          <Button variant="inv" size="sm" asChild>
            <a href={href} target="_blank" rel="noreferrer">
              <Icon name="ext" size={16} />
              {t('portal.nav.openSite')}
            </a>
          </Button>
        ) : (
          <Button variant="inv" size="sm" onClick={() => setPublishOpen(false)}>
            {t('portal.common.close')}
          </Button>
        )}
      </DialogFooter>
    </DialogContent>
  );
}
