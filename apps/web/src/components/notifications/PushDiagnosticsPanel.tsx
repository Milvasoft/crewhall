import { type PushDiagnostics } from '@crewhall/shared';
import { Badge, Button, Skeleton } from '@crewhall/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { formatRelative } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';

/** "Why didn't this person get a push?": asked for on demand, not on every member open. */
export function PushDiagnosticsPanel({ userId }: { userId: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const { data, refetch, isFetching } = useQuery({
    queryKey: ['pushDiagnostics', userId],
    queryFn: () => api.call('getPushDiagnostics', { params: { userId }, query: {} }),
    enabled: open,
    staleTime: 0,
  });
  return (
    <section
      aria-label={t('admin.members.push.title')}
      className="mt-2 flex flex-col gap-3 rounded-xl p-3.5 shadow-line2"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col">
          <span className="text-cap font-semibold">{t('admin.members.push.title')}</span>
          <span className="text-xs text-fg2">{t('admin.members.push.hint')}</span>
        </div>
        <Button
          size="sm"
          variant="out"
          loading={open && isFetching}
          onClick={() => (open ? void refetch() : setOpen(true))}
        >
          {t(open ? 'admin.members.push.refresh' : 'admin.members.push.show')}
        </Button>
      </div>
      {open ? data ? <Details d={data} /> : <Skeleton className="h-32 w-full" /> : null}
    </section>
  );
}

function Details({ d }: { d: PushDiagnostics }) {
  const { t, locale } = useI18n();
  return (
    <div className="flex flex-col gap-3 text-xs">
      <p className="m-0 text-fg2">
        {t(`chat.status.visibilities.${d.visibility}`)}
        {d.inQuietHours ? ` · ${t('admin.members.push.inQuietHours')}` : ''}
      </p>
      <Group title={t('admin.members.push.sessions')} empty={d.sessions.length === 0}>
        {d.sessions.map((s, i) => (
          <li key={i} className="flex flex-wrap items-center gap-1.5">
            <span className="font-semibold">{s.client ?? '—'}</span>
            <Badge tone={s.attending ? 'warn' : 'default'}>
              {t(s.attending ? 'admin.members.push.attending' : 'admin.members.push.notAttending')}
            </Badge>
            {s.idleSeconds !== null ? (
              <span className="text-fg2">
                {t('admin.members.push.idle', { seconds: s.idleSeconds })}
              </span>
            ) : null}
          </li>
        ))}
      </Group>
      <Group title={t('admin.members.push.devices')} empty={d.devices.length === 0}>
        {d.devices.map((v) => {
          const muted = v.mutedUntil && new Date(v.mutedUntil) > new Date(d.now);
          return (
            <li key={v.id} className="flex flex-wrap items-center gap-1.5">
              <span className="font-semibold">
                {v.platform} · {v.provider}
              </span>
              {v.appVersion ? <span className="text-fg2">{v.appVersion}</span> : null}
              {v.disabledAt ? (
                <Badge tone="danger">
                  {t('admin.members.push.disabled', { reason: v.disabledReason ?? '—' })}
                </Badge>
              ) : muted ? (
                <Badge tone="warn">{t('admin.members.push.muted')}</Badge>
              ) : (
                <Badge tone="ok">{t('admin.members.push.active')}</Badge>
              )}
              <span className="text-fg2">{formatRelative(v.lastSeenAt, locale)}</span>
            </li>
          );
        })}
      </Group>
      <Group title={t('admin.members.push.recent')} empty={d.recent.length === 0}>
        {d.recent.map((r) => (
          <li key={r.id} className="flex flex-col">
            <span className="flex flex-wrap items-center gap-1.5">
              <span className="font-semibold">{r.type}</span>
              <span className="text-fg2">{formatRelative(r.updatedAt, locale)}</span>
            </span>
            <span className="text-fg2">{outcomeText(r, t)}</span>
          </li>
        ))}
      </Group>
    </div>
  );
}

function outcomeText(
  r: PushDiagnostics['recent'][number],
  t: ReturnType<typeof useI18n>['t'],
): string {
  if (r.pushSkip) return t(`admin.members.push.skip.${r.pushSkip}`);
  if (!r.wantsPush) return t('admin.members.push.noPush');
  if (!r.pushedAt) return t('admin.members.push.waiting');
  const failed = (r.outcome ?? []).filter((o) => !o.ok);
  if (failed.length) {
    return t('admin.members.push.failed', {
      errors: failed.map((o) => `${o.provider}: ${o.error ?? '?'}`).join(', '),
    });
  }
  return t('admin.members.push.sent', { count: r.outcome?.length ?? 0 });
}

function Group({
  title,
  empty,
  children,
}: {
  title: string;
  empty: boolean;
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-1">
      <span className="eyebrow">{title}</span>
      {empty ? (
        <span className="text-fg2">{t('admin.members.push.none')}</span>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">{children}</ul>
      )}
    </div>
  );
}
