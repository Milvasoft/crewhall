import { Badge, EmptyState, Icon, Skeleton, Table, Td, Th } from '@crewhall/ui';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { formatBytes, formatNumber } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { importsQuery } from '@/lib/portal/api';
import { usePortalSite } from '@/lib/portal/context';
import { Kpi, PageHeader, useDuration, useWhen } from './common';
import { PortalPage } from './PortalPage';

/**
 * 10.16 Import report (read only). Imports run from the CLI (`pnpm portal:import`); the wizard
 * of 10.15 is out of scope for the Hub UI.
 */
export function ImportReport() {
  const { t, locale } = useI18n();
  const { site } = usePortalSite();
  const imports = useQuery(importsQuery(site.id));
  const when = useWhen();
  const duration = useDuration();
  const report = imports.data?.items[0];
  const n = (v: number) => formatNumber(v, locale);

  return (
    <PortalPage crumbs={[{ label: t('portal.nav.settings') }, { label: t('portal.nav.import') }]}>
      <PageHeader
        title={t('portal.import.title')}
        subtitle={
          report
            ? [
                report.source,
                when(report.finishedAt, true),
                duration(report.durationMs),
                report.actor?.name,
              ]
                .filter(Boolean)
                .join(' · ')
            : undefined
        }
      />
      <p className="flex items-center gap-2 rounded-xl bg-bg2 px-4 py-3 text-[13px] text-fg2">
        <Icon name="terminal" size={16} className="shrink-0" />
        {t('portal.import.cliHint')}
        <code className="rounded-xs bg-surface px-1.5 py-0.5 font-mono text-xs text-fg">
          {'pnpm portal:import --from <docusaurus-repo>'}
        </code>
      </p>
      {imports.isPending ? (
        <Skeleton className="h-40 rounded-2xl" />
      ) : !report ? (
        <EmptyState
          icon="download"
          title={t('portal.import.empty')}
          description={t('portal.import.emptyHint')}
        />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            <Kpi
              label={t('portal.import.content')}
              value={n(report.counts.docs + report.counts.posts + report.counts.categories)}
              hint={t('portal.import.contentHint', {
                count: report.counts.docs,
                n: report.counts.posts,
                total: report.counts.categories,
              })}
            />
            <Kpi
              label={t('portal.import.media')}
              value={n(report.counts.media)}
              hint={formatBytes(report.counts.mediaBytes, locale)}
            />
            <Kpi
              label={t('portal.import.warnings')}
              value={n(report.counts.warnings)}
              hint={t('portal.import.warningsHint')}
            />
            <Kpi
              label={t('portal.import.skipped')}
              value={n(report.counts.skipped)}
              hint={t('portal.import.files', { count: report.counts.files })}
            />
          </div>
          <div
            className={
              report.urls.matched === report.urls.expected
                ? 'flex gap-3 rounded-xl bg-[color-mix(in_srgb,var(--success)_10%,transparent)] px-4 py-3 text-[13.5px]'
                : 'flex gap-3 rounded-xl bg-[color-mix(in_srgb,var(--warning)_12%,transparent)] px-4 py-3 text-[13.5px]'
            }
          >
            <Icon
              name={report.urls.matched === report.urls.expected ? 'checkC' : 'alert'}
              size={18}
              className={
                report.urls.matched === report.urls.expected
                  ? 'shrink-0 text-success'
                  : 'shrink-0 text-warning'
              }
            />
            <div className="flex flex-col gap-1">
              <b>
                {t('portal.import.urls', {
                  done: report.urls.matched,
                  total: report.urls.expected,
                })}
              </b>
              <span className="text-fg2">
                {report.urls.missing.length
                  ? t('portal.import.urlsMissing', { count: report.urls.missing.length })
                  : t('portal.import.urlsOk')}
              </span>
              {report.urls.missing.length ? (
                <span className="font-mono text-xs">
                  {report.urls.missing.slice(0, 8).join(' · ')}
                </span>
              ) : null}
            </div>
          </div>
          <div className="overflow-hidden rounded-2xl bg-surface shadow-line">
            <Table aria-label={t('portal.import.entries')}>
              <thead>
                <tr>
                  <Th>{t('portal.import.col.type')}</Th>
                  <Th>{t('portal.import.col.source')}</Th>
                  <Th>{t('portal.import.col.action')}</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {report.entries.map((e, i) => (
                  <tr key={i}>
                    <Td>
                      <Badge
                        tone={e.type === 'skipped' || e.type === 'unsupported' ? 'default' : 'warn'}
                        plain
                      >
                        {t(`portal.import.types.${e.type}`)}
                      </Badge>
                    </Td>
                    <Td className="max-w-[340px] truncate font-mono text-xs">{e.source}</Td>
                    <Td className="max-w-[420px] truncate text-fg2">{e.action}</Td>
                    <Td className="text-right">
                      {e.targetId && e.targetKind === 'doc' ? (
                        <Link
                          to="/portal/$siteSlug/docs"
                          params={{ siteSlug: site.slug }}
                          search={{ doc: e.targetId }}
                          className="text-xs font-semibold hover:underline"
                        >
                          {t('portal.import.show')}
                        </Link>
                      ) : e.targetId && e.targetKind === 'post' ? (
                        <Link
                          to="/portal/$siteSlug/blog/$postId"
                          params={{ siteSlug: site.slug, postId: e.targetId }}
                          className="text-xs font-semibold hover:underline"
                        >
                          {t('portal.import.show')}
                        </Link>
                      ) : null}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        </>
      )}
    </PortalPage>
  );
}
