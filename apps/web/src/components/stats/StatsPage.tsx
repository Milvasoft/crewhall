import { STATS_RANGES, type ActiveUsersPoint, type AdminStats } from '@crewhall/shared';
import {
  Avatar,
  Button,
  EmptyState,
  Icon,
  Segmented,
  Skeleton,
  Table,
  Td,
  Th,
  Tr,
} from '@crewhall/ui';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { PageHeader } from '@/components/admin/Settings';
import { Workspace } from '@/components/shell/Workspace';
import { SpaceAvatar } from '@/components/spaces/SpaceAvatar';
import { api } from '@/lib/api';
import { formatBytes, formatDate, formatNumber, formatTime } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';

/**
 * Yönetim › İstatistikler (roadmap 21). Reads the daily rollup only. Charts stay neutral (design
 * 16: "Grafik ve depolama kullanımı nötr"): ink tones from the theme, the three activity lines
 * told apart by dash pattern as well, a legend, hover tooltips and a table view.
 */

type Range = (typeof STATS_RANGES)[number];

export const statsQuery = (days: Range) => ({
  queryKey: ['admin', 'stats', days] as const,
  queryFn: () => api.call('adminStats', { query: { days } }),
});

/** Theme tokens, so light and dark mode both read (no fixed hex in charts). */
const INK = { strong: 'var(--fg)', mid: 'var(--fg2)', soft: 'var(--fg3)', grid: 'var(--line)' };

const SERIES = [
  { key: 'dau', color: INK.strong, dash: undefined },
  { key: 'wau', color: INK.mid, dash: '6 4' },
  { key: 'mau', color: INK.soft, dash: '2 3' },
] as const;

export function StatsPage() {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const [days, setDays] = useState<Range>(30);
  // The previous range stays on screen while the next one loads (no skeleton flash).
  const stats = useQuery({ ...statsQuery(days), placeholderData: keepPreviousData });
  const refresh = useMutation({
    mutationFn: () => api.call('adminStatsRefresh', { query: { days } }),
    onSuccess: (data) => {
      qc.setQueryData(statsQuery(days).queryKey, data);
      void qc.invalidateQueries({ queryKey: ['admin', 'stats'] });
    },
  });
  const s = stats.data;

  return (
    <Workspace crumbs={[{ label: t('admin.title') }, { label: t('stats.nav') }]}>
      <PageHeader
        title={t('stats.title')}
        subtitle={
          s?.computedAt
            ? t('stats.updated', {
                time: `${formatDate(s.computedAt, locale)} ${formatTime(s.computedAt, locale)}`,
              })
            : undefined
        }
        actions={
          <>
            <Segmented
              aria-label={t('stats.range')}
              size="sm"
              value={String(days)}
              onValueChange={(v) => setDays(Number(v) as Range)}
              options={STATS_RANGES.map((d) => ({
                value: String(d),
                label: t('stats.days', { count: d }),
              }))}
            />
            <Button
              size="sm"
              variant="out"
              loading={refresh.isPending}
              onClick={() => refresh.mutate()}
            >
              <Icon name="history" size={15} />
              {t('stats.refresh')}
            </Button>
          </>
        }
      />
      {!s ? (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-[84px] rounded-2xl" />
          ))}
        </div>
      ) : (
        <>
          {!s.computedAt ? (
            <p role="note" className="rounded-xl bg-bg2 px-4 py-3 text-sm text-fg2">
              {t('stats.never')}
            </p>
          ) : null}
          <Tiles s={s} />
          <Card title={t('stats.active.title')}>
            <ActiveUsers points={s.activeUsers} />
          </Card>
          {/* Two independent columns (like the settings pages): the short storage chart and the
              two lists fill the left one next to the tall module card, without row alignment. */}
          <div className="grid items-start gap-4 lg:grid-cols-2">
            <div className="flex min-w-0 flex-col gap-4">
              <Card title={t('stats.storage.title')}>
                <Storage s={s} />
              </Card>
              <Card title={t('stats.spaces.title')}>
                <Spaces s={s} />
              </Card>
              <Card title={t('stats.users.title')}>
                <People s={s} />
              </Card>
            </div>
            <div className="flex min-w-0 flex-col gap-4">
              <Card title={t('stats.modules.title')} hint={t('stats.modules.hint')}>
                <Modules s={s} />
              </Card>
            </div>
          </div>
          <p className="text-xs text-fg3">{t('stats.source')}</p>
        </>
      )}
    </Workspace>
  );
}

function Tiles({ s }: { s: AdminStats }) {
  const { t, locale } = useI18n();
  const pct = (n: number) => (s.totals.members ? Math.round((n / s.totals.members) * 100) : 0);
  const tile = (label: string, value: string, hint: string) => (
    <div className="flex flex-col gap-1 rounded-2xl bg-surface px-4 py-3.5 shadow-line">
      <span className="text-cap text-fg2">{label}</span>
      <span className="text-num font-bold tn">{value}</span>
      <span className="truncate text-xs text-fg3">{hint}</span>
    </div>
  );
  const members = (n: number) =>
    t('stats.tile.ofMembers', { members: s.totals.members, pct: pct(n) });
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {tile(t('stats.tile.dau'), formatNumber(s.totals.dau, locale), members(s.totals.dau))}
      {tile(t('stats.tile.wau'), formatNumber(s.totals.wau, locale), members(s.totals.wau))}
      {tile(t('stats.tile.mau'), formatNumber(s.totals.mau, locale), members(s.totals.mau))}
      {tile(
        t('stats.tile.storage'),
        formatBytes(s.totals.storageBytes, locale),
        s.totals.quotaBytes
          ? t('stats.tile.quota', { size: formatBytes(s.totals.quotaBytes, locale) })
          : t('stats.tile.noQuota'),
      )}
    </div>
  );
}

function Card({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section
      aria-label={title}
      className="flex min-w-0 flex-col gap-3 rounded-2xl bg-surface p-4 shadow-line sm:p-5"
    >
      <div className="flex flex-col">
        <h2 className="text-h font-semibold">{title}</h2>
        {hint ? <span className="text-xs text-fg2">{hint}</span> : null}
      </div>
      {children}
    </section>
  );
}

const axis = { stroke: INK.grid, tick: { fill: INK.mid, fontSize: 11 }, tickLine: false } as const;

function TooltipBox({ title, rows }: { title: string; rows: [string, string, ReactNode?][] }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg bg-surface px-3 py-2 text-xs shadow-overlay">
      <span className="font-semibold text-fg">{title}</span>
      {rows.map(([label, value, swatch]) => (
        <span key={label} className="flex items-center gap-2 text-fg2">
          {swatch}
          {label}
          <b className="ml-auto pl-3 text-fg tn">{value}</b>
        </span>
      ))}
    </div>
  );
}

function Swatch({ color, dash }: { color: string; dash?: string }) {
  return (
    <svg width="18" height="8" aria-hidden className="shrink-0">
      <line x1="1" y1="4" x2="17" y2="4" stroke={color} strokeWidth="2" strokeDasharray={dash} />
    </svg>
  );
}

/** Daily, weekly and monthly active people; a table view for screen readers and exact values. */
function ActiveUsers({ points }: { points: ActiveUsersPoint[] }) {
  const { t, locale } = useI18n();
  const [table, setTable] = useState(false);
  const short = (day: string) => formatDate(day, locale, { day: 'numeric', month: 'short' });
  const label = (k: (typeof SERIES)[number]['key']) => t(`stats.active.${k}`);
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg2">
        {SERIES.map((x) => (
          <span key={x.key} className="flex items-center gap-1.5">
            <Swatch color={x.color} dash={x.dash} />
            {label(x.key)}
          </span>
        ))}
        <Button size="xs" variant="gh" className="ml-auto" onClick={() => setTable((v) => !v)}>
          {table ? t('stats.view.chart') : t('stats.view.table')}
        </Button>
      </div>
      {table ? (
        <div className="max-h-[320px] overflow-auto">
          <Table className="min-w-[360px]">
            <thead>
              <tr>
                <Th>{t('stats.view.day')}</Th>
                {SERIES.map((x) => (
                  <Th key={x.key} className="text-right">
                    {label(x.key)}
                  </Th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...points].reverse().map((p) => (
                <Tr key={p.day}>
                  <Td className="text-sm">{formatDate(p.day, locale)}</Td>
                  {SERIES.map((x) => (
                    <Td key={x.key} className="text-right text-sm tn">
                      {formatNumber(p[x.key], locale)}
                    </Td>
                  ))}
                </Tr>
              ))}
            </tbody>
          </Table>
        </div>
      ) : (
        <div className="h-[260px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
              <CartesianGrid vertical={false} stroke={INK.grid} />
              <XAxis dataKey="day" tickFormatter={short} minTickGap={24} {...axis} />
              <YAxis allowDecimals={false} axisLine={false} {...axis} />
              <Tooltip
                cursor={{ stroke: INK.soft, strokeWidth: 1 }}
                content={({ active, label: day }) =>
                  active && typeof day === 'string' ? (
                    <TooltipBox
                      title={formatDate(day, locale)}
                      rows={SERIES.map((x) => [
                        label(x.key),
                        formatNumber(points.find((p) => p.day === day)?.[x.key] ?? 0, locale),
                        <Swatch key={x.key} color={x.color} dash={x.dash} />,
                      ])}
                    />
                  ) : null
                }
              />
              {SERIES.map((x) => (
                <Line
                  key={x.key}
                  type="monotone"
                  dataKey={x.key}
                  name={label(x.key)}
                  stroke={x.color}
                  strokeWidth={2}
                  strokeDasharray={x.dash}
                  dot={false}
                  activeDot={{ r: 4, stroke: 'var(--surface)', strokeWidth: 2 }}
                  isAnimationActive={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </>
  );
}

function Storage({ s }: { s: AdminStats }) {
  const { t, locale } = useI18n();
  if (!s.storage.length) return <p className="text-sm text-fg3">{t('stats.storage.empty')}</p>;
  const short = (day: string) => formatDate(day, locale, { day: 'numeric', month: 'short' });
  return (
    <div className="h-[220px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={s.storage} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
          <CartesianGrid vertical={false} stroke={INK.grid} />
          <XAxis dataKey="day" tickFormatter={short} minTickGap={24} {...axis} />
          <YAxis
            axisLine={false}
            width={64}
            tickFormatter={(v: number) => formatBytes(v, locale)}
            {...axis}
          />
          <Tooltip
            cursor={{ stroke: INK.soft, strokeWidth: 1 }}
            content={({ active, payload, label: day }) =>
              active && typeof day === 'string' ? (
                <TooltipBox
                  title={formatDate(day, locale)}
                  rows={[
                    [
                      t('stats.tile.storage'),
                      formatBytes(Number(payload?.[0]?.value ?? 0), locale),
                    ],
                  ]}
                />
              ) : null
            }
          />
          <Area
            type="monotone"
            dataKey="bytes"
            stroke={INK.mid}
            strokeWidth={2}
            fill={INK.strong}
            fillOpacity={0.07}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function Modules({ s }: { s: AdminStats }) {
  const { t, locale } = useI18n();
  const name = (area: AdminStats['modules'][number]['area']) => t(`stats.area.${area}`);
  const data = s.modules.map((m) => ({ ...m, label: name(m.area) }));
  return (
    <>
      <div className="w-full" style={{ height: Math.max(120, data.length * 28 + 16) }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={data}
            layout="vertical"
            margin={{ top: 0, right: 16, bottom: 0, left: 0 }}
          >
            <CartesianGrid horizontal={false} stroke={INK.grid} />
            <XAxis type="number" allowDecimals={false} {...axis} />
            <YAxis type="category" dataKey="label" width={96} axisLine={false} {...axis} />
            <Tooltip
              cursor={{ fill: 'var(--bg2)' }}
              content={({ active, payload }) => {
                const m = payload?.[0]?.payload as (typeof data)[number] | undefined;
                return active && m ? (
                  <TooltipBox
                    title={m.label}
                    rows={[
                      [t('stats.modules.avg'), formatNumber(m.avgDailyUsers, locale, 1)],
                      [t('stats.modules.peak'), formatNumber(m.peakUsers, locale)],
                      [t('stats.modules.actions'), formatNumber(m.actions, locale)],
                    ]}
                  />
                ) : null;
              }}
            />
            <Bar
              dataKey="avgDailyUsers"
              fill={INK.mid}
              radius={[0, 4, 4, 0]}
              barSize={14}
              isAnimationActive={false}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="overflow-x-auto">
        <Table className="min-w-[360px]">
          <thead>
            <tr>
              <Th>{t('stats.modules.module')}</Th>
              <Th className="text-right">{t('stats.modules.avg')}</Th>
              <Th className="text-right">{t('stats.modules.peak')}</Th>
              <Th className="text-right" title={t('stats.modules.actionsHint')}>
                {t('stats.modules.actions')}
              </Th>
            </tr>
          </thead>
          <tbody>
            {data.map((m) => (
              <Tr key={m.area}>
                <Td className="text-sm">{m.label}</Td>
                <Td className="text-right text-sm tn">
                  {formatNumber(m.avgDailyUsers, locale, 1)}
                </Td>
                <Td className="text-right text-sm tn">{formatNumber(m.peakUsers, locale)}</Td>
                <Td className="text-right text-sm tn">{formatNumber(m.actions, locale)}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </div>
    </>
  );
}

function Spaces({ s }: { s: AdminStats }) {
  const { t, locale } = useI18n();
  if (!s.growingSpaces.length) {
    return <EmptyState icon="space" title={t('stats.spaces.empty')} />;
  }
  const signed = (n: number, text: string) => (n > 0 ? `+${text}` : text);
  return (
    <div className="overflow-x-auto">
      <Table className="min-w-[360px]">
        <thead>
          <tr>
            <Th>{t('stats.spaces.space')}</Th>
            <Th className="text-right">{t('stats.spaces.size')}</Th>
            <Th className="text-right">{t('stats.spaces.growth')}</Th>
            <Th className="text-right">{t('stats.spaces.items')}</Th>
          </tr>
        </thead>
        <tbody>
          {s.growingSpaces.map((g) => (
            <Tr key={g.space.id}>
              <Td>
                <span className="flex min-w-0 items-center gap-2">
                  <SpaceAvatar space={g.space} size="sm" />
                  <span className="truncate text-sm font-semibold">{g.space.name}</span>
                </span>
              </Td>
              <Td className="text-right text-sm tn">{formatBytes(g.bytes, locale)}</Td>
              <Td className="text-right text-sm font-semibold tn">
                {signed(g.growthBytes, formatBytes(g.growthBytes, locale))}
              </Td>
              <Td className="text-right text-sm tn">
                {formatNumber(g.items, locale)}
                {g.growthItems ? (
                  <span className="text-fg3">
                    {' '}
                    ({signed(g.growthItems, formatNumber(g.growthItems, locale))})
                  </span>
                ) : null}
              </Td>
            </Tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}

function People({ s }: { s: AdminStats }) {
  const { t, locale } = useI18n();
  if (!s.topUsers.length) return <EmptyState icon="users" title={t('stats.users.empty')} />;
  return (
    <div className="overflow-x-auto">
      <Table className="min-w-[360px]">
        <thead>
          <tr>
            <Th>{t('stats.users.person')}</Th>
            <Th className="text-right">{t('stats.users.size')}</Th>
          </tr>
        </thead>
        <tbody>
          {s.topUsers.map((u) => (
            <Tr key={u.user.id}>
              <Td>
                <span className="flex min-w-0 items-center gap-2">
                  <Avatar name={u.user.name} src={u.user.imageUrl} size="sm" />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-sm font-semibold">{u.user.name}</span>
                    <span className="truncate text-xs text-fg3">{u.user.email}</span>
                  </span>
                </span>
              </Td>
              <Td className="text-right text-sm tn">{formatBytes(u.bytes, locale)}</Td>
            </Tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}
