import { queryKeys } from '@crewhall/api-client';
import { type Link, type LinkStatus } from '@crewhall/shared';
import {
  Badge,
  Button,
  cn,
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
  initials,
  Skeleton,
  StatusDot,
} from '@crewhall/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { api } from '@/lib/api';
import { formatPercent, formatRelative, formatTime } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { linkHistoryQuery } from './api';

/** Site icon with the initials fallback (2.4: "Favicon alınamazsa baş harfler"). */
export function Favicon({
  title,
  url,
  size = 'md',
  className,
  children,
}: {
  title: string;
  url: string | null | undefined;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'grid';
  className?: string;
  children?: ReactNode;
}) {
  const { locale } = useI18n();
  const [failed, setFailed] = useState(false);
  const box = {
    xs: 'size-[22px] rounded-[6px] text-[9.5px]',
    sm: 'size-[26px] rounded-[7px] text-[10.5px]',
    md: 'size-9 rounded-[10px] text-sm',
    grid: 'size-10 rounded-[11px] text-[13px]',
    lg: 'size-12 rounded-[14px] text-lg',
  }[size];
  return (
    // Not aria-hidden as a whole: a health dot inside it must stay reachable.
    <span
      className={cn(
        'relative flex shrink-0 items-center justify-center bg-bg2 leading-none font-bold text-fg',
        box,
        className,
      )}
    >
      {url && !failed ? (
        <img
          src={url}
          alt=""
          className="size-[60%] object-contain"
          onError={() => setFailed(true)}
        />
      ) : (
        <span aria-hidden="true">{initials(title, 2, locale)}</span>
      )}
      {children}
    </span>
  );
}

const DOT: Record<LinkStatus, 'up' | 'warn' | 'down' | 'none'> = {
  up: 'up',
  warn: 'warn',
  down: 'down',
  unknown: 'none',
};

/** Open a link in a new tab and count it for the "most opened" sort. */
export function openLink(link: Link): void {
  window.open(link.url, '_blank', 'noopener,noreferrer');
  void api.call('recordLinkOpen', { params: { linkId: link.id } }).catch(() => undefined);
}

/**
 * Health dot on a favicon; hovering shows the last answer, how long it has been so and the
 * last 24 hours (2.12). Green and unchecked links show no dot unless `always` (a group with
 * "Sağlık durumunu göster" on): then every link gets one, grey while it is not checked.
 */
export function HealthDot({
  link,
  title,
  context,
  always,
  className,
}: {
  link: Link;
  title: string;
  context?: string;
  always?: boolean;
  className?: string;
}) {
  const { t } = useI18n();
  const status = link.checkEnabled ? link.health.status : 'unknown';
  if (!always && (status === 'up' || status === 'unknown')) return null;
  return (
    <HoverCard openDelay={250} closeDelay={120}>
      <HoverCardTrigger asChild>
        <span
          role="img"
          tabIndex={0}
          aria-label={`${title}: ${t(statusLabelKey(link))}`}
          className={cn('absolute -top-0.5 -right-0.5 flex rounded-full', className)}
        >
          <StatusDot status={DOT[status]} className="shadow-[0_0_0_2px_var(--surface)]" />
        </span>
      </HoverCardTrigger>
      <HoverCardContent side="right" align="start" className="w-[320px]">
        <HealthDetails link={link} title={title} context={context} />
      </HoverCardContent>
    </HoverCard>
  );
}

/**
 * The server does not check addresses on internal networks (SSRF guard): status unknown with
 * reason 'internal'. That is a fact about the address, not an error, so it reads neutral.
 */
export const isInternal = (link: Link) =>
  link.health.status === 'unknown' && link.health.reason === 'internal';

export function statusLabelKey(link: Link) {
  if (!link.checkEnabled) return 'quick.health.unknown' as const;
  const h = link.health;
  if (isInternal(link)) return 'quick.health.internal' as const;
  if (h.status === 'unknown' && !h.checkedAt) return 'quick.health.notChecked' as const;
  if (h.status === 'warn') {
    return h.reason === 'slow' ? ('quick.health.slow' as const) : ('quick.health.tls' as const);
  }
  return `quick.health.${h.status}` as const;
}

function HealthDetails({ link, title, context }: { link: Link; title: string; context?: string }) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const history = useQuery(linkHistoryQuery(link.id));
  const recheck = useMutation({
    mutationFn: () => api.call('checkLinkNow', { params: { linkId: link.id } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['surfaces'] });
      void qc.invalidateQueries({ queryKey: queryKeys.linkHistory(link.id) });
    },
  });
  const enable = useMutation({
    mutationFn: () =>
      api.call('updateLink', { params: { linkId: link.id }, body: { checkEnabled: true } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['surfaces'] }),
  });
  const h = link.health;
  const tone = { up: 'ok', warn: 'warn', down: 'danger', unknown: 'default' } as const;
  const buckets = bucketize(history.data?.items ?? []);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2.5">
        <Favicon title={title} url={link.faviconUrl} />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-semibold">
            {title}
            {context ? <span className="font-normal text-fg2"> · {context}</span> : null}
          </span>
          <span className="truncate text-xs text-fg3">{link.host}</span>
        </div>
        <Badge tone={link.checkEnabled ? tone[h.status] : 'default'}>
          {t(statusLabelKey(link))}
        </Badge>
      </div>
      <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-cap">
        <dt className="text-fg2">{t('quick.health.lastResponse')}</dt>
        <dd className="m-0 font-medium">
          {h.httpStatus ? `HTTP ${h.httpStatus}` : isInternal(link) ? '—' : (h.reason ?? '—')}
          {h.latencyMs !== null ? ` · ${h.latencyMs} ms` : ''}
        </dd>
        {h.since && h.status !== 'up' ? (
          <>
            <dt className="text-fg2">{t('quick.health.duration')}</dt>
            <dd className="m-0 font-medium">
              {t('quick.health.since', {
                ago: formatRelative(h.since, locale),
                time: formatTime(h.since, locale),
              })}
            </dd>
          </>
        ) : null}
        <dt className="text-fg2">{t('quick.health.lastOk')}</dt>
        <dd className="m-0 font-medium">{h.lastUpAt ? formatTime(h.lastUpAt, locale) : '—'}</dd>
        <dt className="text-fg2">{t('quick.health.last24h')}</dt>
        <dd className="m-0 font-medium">
          {history.data?.availability != null
            ? t('quick.health.availability', {
                value: formatPercent(history.data.availability * 100, locale),
              })
            : '—'}
        </dd>
      </dl>
      <div className="flex flex-col gap-1">
        {history.isLoading ? (
          <Skeleton className="h-6 w-full" />
        ) : (
          <div className="flex h-6 items-stretch gap-[2px]" aria-hidden="true">
            {buckets.map((b, i) => (
              <i
                key={i}
                className={cn(
                  'flex-1 rounded-[2px]',
                  b === 'down'
                    ? 'bg-danger'
                    : b === 'warn'
                      ? 'bg-warning'
                      : b === 'up'
                        ? 'bg-success/70'
                        : 'bg-bg2',
                )}
              />
            ))}
          </div>
        )}
        <div className="flex justify-between text-[11px] text-fg3">
          <span>{t('quick.health.dayAgo')}</span>
          <span>{t('quick.health.now')}</span>
        </div>
      </div>
      {!link.checkEnabled ? (
        <p className="m-0 text-cap text-fg2">{t('quick.health.checkOff')}</p>
      ) : isInternal(link) ? (
        <p className="m-0 text-cap text-fg2">{t('quick.health.internalHint')}</p>
      ) : null}
      <div className="flex gap-2">
        <Button size="xs" variant="inv" onClick={() => openLink(link)}>
          {t('quick.health.openAnyway')}
        </Button>
        {isInternal(link) ? null : link.checkEnabled ? (
          <Button size="xs" loading={recheck.isPending} onClick={() => recheck.mutate()}>
            {t('quick.health.checkNow')}
          </Button>
        ) : (
          <Button size="xs" loading={enable.isPending} onClick={() => enable.mutate()}>
            {t('quick.health.enableCheck')}
          </Button>
        )}
      </div>
    </div>
  );
}

/** 48 half-hour buckets: the worst status in each. */
function bucketize(items: { at: string; status: LinkStatus }[]): LinkStatus[] {
  const rank: Record<LinkStatus, number> = { unknown: 0, up: 1, warn: 2, down: 3 };
  const end = Date.now();
  const span = 30 * 60_000;
  const out: LinkStatus[] = Array.from({ length: 48 }, () => 'unknown');
  for (const it of items) {
    const idx = 47 - Math.floor((end - new Date(it.at).getTime()) / span);
    if (idx < 0 || idx > 47) continue;
    if (rank[it.status] > rank[out[idx]!]) out[idx] = it.status;
  }
  return out;
}
