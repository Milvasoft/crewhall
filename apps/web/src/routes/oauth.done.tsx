import { Button, Icon, Skeleton } from '@crewhall/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';
import { z } from 'zod';
import { AuthLayout, Notice, linkClass } from '@/components/auth/AuthLayout';
import { api } from '@/lib/api';
import { formatDateLong, formatTime } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { spacesLabel } from '@/lib/mcp/format';
import { grantQuery } from '@/lib/mcp/queries';

export const Route = createFileRoute('/oauth/done')({
  validateSearch: z.object({ grant: z.string().optional(), client: z.string().optional() }),
  component: DonePage,
});

/**
 * Connected (design 18.3): what was granted and until when, with a one-click way out when
 * the connection was not expected. The access ends within 30 s of disconnecting.
 */
function DonePage() {
  const i18n = useI18n();
  const { t, locale } = i18n;
  const { grant: grantId = '', client: clientName = '' } = Route.useSearch();
  const grant = useQuery({ ...grantQuery(grantId), enabled: Boolean(grantId) });
  const [cut, setCut] = useState(false);
  const revoke = useMutation({
    mutationFn: () => api.call('revokeMcpGrant', { params: { grantId } }),
    onSuccess: () => setCut(true),
  });
  const g = grant.data;
  const client = g?.client.name ?? clientName;

  const row = (label: string, value: ReactNode) => (
    <div className="flex items-center justify-between gap-3 border-t border-line px-3.5 py-2.5 first:border-t-0">
      <span className="text-xs text-fg2">{label}</span>
      <span className="text-right text-cap font-semibold">{value}</span>
    </div>
  );

  return (
    <AuthLayout wide>
      <span className="flex size-12 items-center justify-center rounded-[14px] bg-[color-mix(in_srgb,var(--success)_14%,transparent)] text-success">
        <Icon name="checkC" size={24} />
      </span>
      <div className="flex flex-col gap-1.5">
        <h1 className="m-0 text-[26px] leading-8 font-bold tracking-[-.02em]">
          {t('mcp.done.title', { client })}
        </h1>
        <p className="m-0 text-sm text-fg2">{t('mcp.done.body', { client })}</p>
      </div>
      {cut ? <Notice tone="warn">{t('mcp.done.cut', { client })}</Notice> : null}
      {!g ? (
        <Skeleton className="h-40" />
      ) : (
        <div className="flex flex-col overflow-hidden rounded-xl shadow-line2">
          {row(t('mcp.done.client'), g.label ? `${g.client.name} · ${g.label}` : g.client.name)}
          {row(t('mcp.done.scopes'), g.scopes.map((s) => t(`mcp.scopeShort.${s}`)).join(', '))}
          {row(t('mcp.done.spaces'), spacesLabel(i18n, g.spaces))}
          {row(
            t('mcp.done.validity'),
            g.expiresAt
              ? t('mcp.done.until', { date: formatDateLong(g.expiresAt, locale) })
              : t('mcp.done.never'),
          )}
        </div>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Button variant="out" asChild>
          <Link to="/account/mcp">{t('mcp.done.manage')}</Link>
        </Button>
        <Button variant="pri" onClick={() => window.close()}>
          {t('mcp.done.close')}
        </Button>
      </div>
      {!cut && g ? (
        <p className="m-0 text-center text-cap text-fg2">
          {t('mcp.done.notMe')}{' '}
          <button
            type="button"
            className={`${linkClass} text-danger`}
            disabled={revoke.isPending}
            onClick={() => revoke.mutate()}
          >
            {t('mcp.done.cutNow')}
          </button>
        </p>
      ) : null}
      {g ? (
        <p className="m-0 flex items-center justify-center gap-1.5 text-xs text-fg3">
          <Icon name="shield" size={13} />
          {t('mcp.done.audited', { time: formatTime(g.createdAt, locale) })}
        </p>
      ) : null}
    </AuthLayout>
  );
}
