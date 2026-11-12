import { Badge, Button, Icon, Progress, Skeleton } from '@crewhall/ui';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { formatNumber, formatTime } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { changesQuery, overviewQuery } from '@/lib/portal/api';
import { setPublishOpen, usePortalSite } from '@/lib/portal/context';
import { localeName, siteHref } from '@/lib/portal/format';
import { CHANGE_ICON, useChangeText } from './changes';
import {
  Card,
  Kpi,
  LocaleTag,
  PageHeader,
  Person,
  StatusChip,
  useDuration,
  useWhen,
} from './common';
import { PortalPage } from './PortalPage';

/** 10.1 Overview: site status, the publish queue, drafts and translation gaps. */
export function Overview() {
  const { t, locale } = useI18n();
  const { site } = usePortalSite();
  const overview = useQuery(overviewQuery(site.id));
  const changes = useQuery(changesQuery(site.id));
  const when = useWhen();
  const duration = useDuration();
  const text = useChangeText();
  const o = overview.data;
  const href = siteHref(site);
  const n = (v: number) => formatNumber(v, locale);

  const subtitle = [
    site.domain ?? site.name,
    o?.lastPublish
      ? t('portal.overview.lastPublish', {
          when: when(o.lastPublish.createdAt),
          name: o.lastPublish.actor?.name ?? '',
        })
      : t('portal.overview.neverPublished'),
    site.currentVersion
      ? t('portal.overview.currentVersion', { version: site.currentVersion })
      : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <PortalPage crumbs={[{ label: t('portal.nav.overview') }]} previewPath="/">
      <PageHeader
        title={t('portal.nav.overview')}
        subtitle={subtitle}
        actions={
          href ? (
            <Button variant="out" size="sm" asChild>
              <a href={href} target="_blank" rel="noreferrer">
                <Icon name="ext" size={16} />
                {t('portal.nav.openSite')}
              </a>
            </Button>
          ) : null
        }
      />
      {!o ? (
        <div className="grid grid-cols-4 gap-3">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-24 rounded-2xl" />
          ))}
        </div>
      ) : (
        <>
          <div
            className="grid grid-cols-2 gap-3 xl:grid-cols-4"
            role="list"
            aria-label={t('portal.overview.kpis')}
          >
            <div role="listitem">
              <Kpi
                label={t('portal.overview.publishedUrls')}
                value={n(o.publishedUrlCount)}
                hint={t('portal.overview.publishedUrlsHint', {
                  count: o.publishedDocCount,
                  n: o.publishedPostCount,
                  total: site.locales.length,
                })}
              />
            </div>
            <div role="listitem">
              <Kpi
                label={t('portal.overview.pending')}
                value={n(o.pending.count)}
                hint={
                  o.pending.count
                    ? t('portal.overview.pendingHint', {
                        people: o.pending.people,
                        when: when(o.pending.oldestAt),
                      })
                    : t('portal.status.allPublished')
                }
              />
            </div>
            <div role="listitem">
              <Kpi
                label={t('portal.overview.drafts')}
                value={n(o.drafts.docs + o.drafts.posts)}
                hint={t('portal.overview.draftsHint', { count: o.drafts.docs, n: o.drafts.posts })}
              />
            </div>
            {o.translations.map((tr) => (
              <div role="listitem" key={tr.locale}>
                <Kpi
                  label={t('portal.overview.translation', {
                    language: localeName(tr.locale, locale),
                  })}
                  value={
                    <>
                      {n(tr.translated)}
                      <span className="text-sub font-semibold text-fg3"> / {n(tr.total)}</span>
                    </>
                  }
                  hint={t('portal.overview.translationHint', {
                    count: tr.total - tr.translated,
                    n: tr.outdated,
                  })}
                />
              </div>
            ))}
          </div>

          <div className="grid gap-3 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
            <Card
              title={t('portal.overview.queue')}
              aside={
                site.capabilities.publish && changes.data?.items.length ? (
                  <Button variant="out" size="xs" onClick={() => setPublishOpen(true)}>
                    {t('portal.overview.reviewAll')}
                  </Button>
                ) : null
              }
            >
              {!changes.data?.items.length ? (
                <p className="py-3 text-sm text-fg2">{t('portal.status.allPublished')}</p>
              ) : (
                <ul className="flex flex-col">
                  {changes.data.items.slice(0, 6).map((c) => (
                    <li
                      key={c.key}
                      className="flex items-center gap-3 border-b border-line py-2.5 last:border-b-0"
                    >
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-bg2 text-fg2">
                        <Icon name={CHANGE_ICON[c.kind]} size={16} />
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-[13.5px] font-semibold">
                          {text.title(c)}
                        </span>
                        <span className="truncate text-xs text-fg2">{text.detail(c)}</span>
                      </span>
                      {c.locale ? <LocaleTag code={c.locale} /> : null}
                      <StatusChip
                        status={
                          c.action === 'schedule'
                            ? 'scheduled'
                            : c.action === 'create'
                              ? 'draft'
                              : c.action === 'remove'
                                ? 'removed'
                                : 'changed'
                        }
                      />
                      <Person user={c.changedBy} />
                      <span className="w-[72px] shrink-0 text-right text-xs text-fg2">
                        {when(c.changedAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card
              title={t('portal.overview.publishStatus')}
              aside={
                <Badge tone={o.lastJob?.status === 'failed' ? 'danger' : 'ok'}>
                  {o.lastJob?.status === 'failed'
                    ? t('portal.overview.failing')
                    : t('portal.overview.working')}
                </Badge>
              }
            >
              <dl className="flex flex-col text-[13.5px]">
                <Row label={t('portal.overview.lastPublishRow')}>
                  {o.lastPublish
                    ? `#${o.lastPublish.number} · ${formatTime(o.lastPublish.createdAt, locale)} · ${duration(o.lastPublish.durationMs)}`
                    : '-'}
                </Row>
                <Row label={t('portal.overview.revalidate')}>
                  {o.lastJob
                    ? `${o.lastJob.httpStatus ?? '-'} · ${duration(o.lastJob.durationMs)}`
                    : '-'}
                </Row>
                <Row label={t('portal.overview.sitemap')}>
                  {t('portal.overview.urlCount', { count: o.publishedUrlCount })}
                </Row>
                <Row label={t('portal.overview.searchIndex')}>
                  {o.lastPublish
                    ? t('portal.overview.upToDate', {
                        time: formatTime(o.lastPublish.createdAt, locale),
                      })
                    : '-'}
                </Row>
              </dl>
            </Card>
          </div>

          <div className="grid gap-3 xl:grid-cols-3">
            <Card
              title={t('portal.overview.draftsList')}
              aside={<span className="text-xs text-fg3">{o.recentDrafts.length}</span>}
            >
              {!o.recentDrafts.length ? (
                <p className="py-2 text-sm text-fg2">{t('portal.overview.noDrafts')}</p>
              ) : (
                <ul className="flex flex-col">
                  {o.recentDrafts.map((d) => (
                    <li key={d.id} className="flex items-center gap-2.5 py-2">
                      <Link
                        to={
                          d.kind === 'doc'
                            ? '/portal/$siteSlug/docs'
                            : '/portal/$siteSlug/blog/$postId'
                        }
                        params={
                          d.kind === 'doc'
                            ? { siteSlug: site.slug }
                            : { siteSlug: site.slug, postId: d.id }
                        }
                        search={d.kind === 'doc' ? { doc: d.id } : undefined}
                        className="flex min-w-0 flex-1 flex-col hover:underline"
                      >
                        <span className="truncate text-[13.5px] font-semibold">{d.title}</span>
                        <span className="truncate text-xs text-fg2">
                          {[t(`portal.kind.${d.kind}`), d.version, d.locale.toUpperCase()]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      </Link>
                      <Person user={d.updatedBy} />
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            {o.translations.map((tr) => (
              <Card
                key={tr.locale}
                title={t('portal.overview.translationStatus', {
                  language: localeName(tr.locale, locale),
                })}
                aside={
                  <span className="text-xs text-fg3">{`${tr.locale} / ${site.defaultLocale}`}</span>
                }
              >
                <ul className="flex flex-col gap-3 pt-1">
                  {tr.sections.map((sec) => (
                    <li key={sec.groupId} className="flex flex-col gap-1.5">
                      <div className="flex items-center justify-between gap-2 text-[13px]">
                        <span className="truncate font-semibold">{sec.title}</span>
                        <span className="shrink-0 text-xs text-fg2 tn">
                          {`${sec.translated} / ${sec.total}`}
                          {sec.outdated ? (
                            <span className="text-warning">
                              {' '}
                              · {t('portal.overview.outdated', { count: sec.outdated })}
                            </span>
                          ) : null}
                        </span>
                      </div>
                      <Progress
                        neutral
                        value={sec.total ? (sec.translated / sec.total) * 100 : 0}
                        label={sec.title}
                      />
                    </li>
                  ))}
                </ul>
              </Card>
            ))}
            <Card
              title={t('portal.overview.recentPublishes')}
              aside={
                <Link
                  to="/portal/$siteSlug/publishes"
                  params={{ siteSlug: site.slug }}
                  className="text-xs font-semibold text-fg2 hover:text-fg"
                >
                  {t('portal.overview.all')}
                </Link>
              }
            >
              <ul className="flex flex-col">
                {o.recentPublishes.map((p) => (
                  <li key={p.id} className="flex items-center gap-2.5 py-2">
                    <Person user={p.actor} />
                    <Link
                      to="/portal/$siteSlug/publishes"
                      params={{ siteSlug: site.slug }}
                      search={{ sel: p.id }}
                      className="flex min-w-0 flex-1 flex-col hover:underline"
                    >
                      <span className="truncate text-[13.5px] font-semibold">
                        {p.titles.join(', ')}
                      </span>
                      <span className="truncate text-xs text-fg2">
                        {`#${p.number} · ${when(p.createdAt)} · ${t('portal.overview.urlCount', { count: p.pathCount })}`}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          </div>
        </>
      )}
    </PortalPage>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-line py-2.5 last:border-b-0">
      <dt className="text-fg2">{label}</dt>
      <dd className="m-0 truncate font-semibold tn">{children}</dd>
    </div>
  );
}
