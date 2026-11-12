import { type HealthIssue } from '@crewhall/crypto';
import { Button, cn, EmptyState, Spinner, Table, Tag, Td, Th, Tr } from '@crewhall/ui';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useMemo } from 'react';
import { Workspace } from '@/components/shell/Workspace';
import { formatDate, formatNumber, formatTime } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { vaultsQuery } from '@/lib/vault/api';
import { rescanHealth, useVaultHealth } from '@/lib/vault/health';
import { ItemAvatar } from './ItemDetail';
import { vaultName, VaultSidebar } from './VaultSidebar';

/**
 * Vault health (design 8.15), computed entirely on this device: the server cannot see
 * passwords, so it cannot know which are weak, reused or old.
 */
export function HealthPage() {
  const { t, locale } = useI18n();
  const vaults = useQuery(vaultsQuery);
  const list = useMemo(() => vaults.data ?? [], [vaults.data]);
  // The scan runs in the vault worker, gradually; this page only shows its result.
  const { report, scanning, at, items, breach } = useVaultHealth(list);
  const live = useMemo(() => items.filter((d) => d.summary && !d.item.deletedAt), [items]);
  const byId = new Map(live.map((d) => [d.item.id, d]));
  const issueText = (i: HealthIssue) => {
    switch (i.kind) {
      case 'expired':
        return t('vault.health.issue.expired', { date: formatDate(i.date, locale) });
      case 'expiring':
        return t('vault.health.issue.expiring', { days: i.days });
      case 'breached':
        return t('vault.health.issue.breached', { count: formatNumber(i.count, locale) });
      case 'reused':
        return t('vault.health.issue.reused', {
          names: i.with.map((id) => byId.get(id)?.summary?.name ?? '?').join(', '),
        });
      case 'weak':
        return t('vault.health.issue.weak');
      case 'old':
        return t('vault.health.issue.old', { date: formatDate(i.since, locale) });
    }
  };
  if (!report) {
    return (
      <Workspace
        sidebar={<VaultSidebar vaults={list} />}
        crumbs={[{ label: t('vault.title') }, { label: t('vault.health.title') }]}
      >
        <div className="m-auto flex flex-col items-center gap-3 text-sm text-fg2">
          <Spinner />
          {scanning ? t('vault.health.scanning') : null}
        </div>
      </Workspace>
    );
  }
  const tone =
    report.score >= 80 ? 'text-success' : report.score >= 50 ? 'text-warning' : 'text-danger';
  const r = 34;
  const c = 2 * Math.PI * r;

  return (
    <Workspace
      sidebar={<VaultSidebar vaults={list} healthCount={report.rows.length} />}
      crumbs={[{ label: t('vault.title') }, { label: t('vault.health.title') }]}
    >
      {report ? (
        <>
          <div className="flex flex-wrap items-center gap-6 rounded-4xl bg-surface p-6 shadow-line">
            <span className={cn('relative flex size-[84px] items-center justify-center', tone)}>
              <svg viewBox="0 0 80 80" className="absolute inset-0 -rotate-90">
                <circle
                  cx="40"
                  cy="40"
                  r={r}
                  fill="none"
                  strokeWidth="7"
                  className="stroke-line2"
                />
                <circle
                  cx="40"
                  cy="40"
                  r={r}
                  fill="none"
                  strokeWidth="7"
                  strokeLinecap="round"
                  strokeDasharray={c}
                  strokeDashoffset={c * (1 - report.score / 100)}
                  className="stroke-current"
                />
              </svg>
              <span className="flex flex-col items-center leading-none">
                <b className="text-[22px] font-bold tn">{report.score}</b>
                <span className="text-[10px] text-fg3">/ 100</span>
              </span>
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <h1 className="text-h font-semibold">
                {report.rows.length
                  ? t('vault.health.summary', { count: report.rows.length })
                  : t('vault.health.allGood')}
              </h1>
              <span className="text-sm text-fg2">
                {t('vault.health.checked', {
                  ok: report.checked - report.rows.length,
                  total: report.checked,
                })}
              </span>
              <span className="text-xs text-fg3">
                {t('vault.health.computed', {
                  time: at ? formatTime(new Date(at), locale) : '—',
                })}
              </span>
            </div>
            <Button size="sm" variant="out" disabled={scanning} onClick={rescanHealth}>
              {t('vault.health.rescan')}
            </Button>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            {(
              [
                [
                  'expired',
                  report.counts.expired + report.counts.expiring,
                  t('vault.health.kind.expiry', {
                    expired: report.counts.expired,
                    soon: report.counts.expiring,
                  }),
                ],
                ['breached', report.counts.breached, t('vault.health.kind.breached')],
                ['reused', report.counts.reused, t('vault.health.kind.reused')],
                ['weak', report.counts.weak, t('vault.health.kind.weak')],
                ['old', report.counts.old, t('vault.health.kind.old')],
              ] as const
            ).map(([k, n, label]) => (
              <div key={k} className="flex flex-col gap-1 rounded-xl p-4 shadow-line">
                <b
                  className={cn(
                    'text-h font-semibold tn',
                    !n ? 'text-success' : k === 'breached' ? 'text-danger' : 'text-warning',
                  )}
                >
                  {n}
                </b>
                <span className="text-xs text-fg2">{label}</span>
              </div>
            ))}
          </div>
          {breach !== 'ok' ? (
            <p role="note" className="text-xs text-fg2">
              {t(breach === 'off' ? 'vault.health.breachOff' : 'vault.health.breachFailed')}
            </p>
          ) : null}
          {report.rows.length ? (
            <Table>
              <thead>
                <tr>
                  <Th>{t('vault.log.item')}</Th>
                  <Th>{t('vault.health.vault')}</Th>
                  <Th>{t('vault.health.issueCol')}</Th>
                  <Th>{t('vault.health.lastChange')}</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {report.rows.map((row) => {
                  const d = byId.get(row.id);
                  if (!d?.summary) return null;
                  const first = row.issues[0]!;
                  return (
                    <Tr key={row.id}>
                      <Td>
                        <span className="flex items-center gap-2.5">
                          <ItemAvatar name={d.summary.name} type={d.item.type} />
                          <span className="text-sm font-semibold">{d.summary.name}</span>
                          {d.summary.env ? (
                            <Tag tone={d.summary.env}>{t(`vault.env.${d.summary.env}`)}</Tag>
                          ) : null}
                        </span>
                      </Td>
                      <Td className="text-sm">{vaultName(d.vault, t)}</Td>
                      <Td
                        className={cn(
                          'text-sm',
                          first.kind === 'expired' || first.kind === 'breached'
                            ? 'text-danger'
                            : 'text-fg',
                        )}
                      >
                        {row.issues.map(issueText).join(' · ')}
                      </Td>
                      <Td className="text-sm text-fg2">{formatDate(d.item.updatedAt, locale)}</Td>
                      <Td>
                        {d.vault.canEdit ? (
                          <Button size="xs" variant="out" asChild>
                            <Link
                              to="/vault/$vaultId/$category"
                              params={{ vaultId: d.vault.id, category: 'all' }}
                              search={{ item: d.item.id, edit: true }}
                            >
                              {first.kind === 'expired' || first.kind === 'expiring'
                                ? t('vault.health.renew')
                                : t('vault.health.newPassword')}
                            </Link>
                          </Button>
                        ) : null}
                      </Td>
                    </Tr>
                  );
                })}
              </tbody>
            </Table>
          ) : (
            <EmptyState icon="shield" title={t('vault.health.allGood')} />
          )}
          <p className="text-xs text-fg3">{t('vault.health.scope')}</p>
        </>
      ) : null}
    </Workspace>
  );
}
