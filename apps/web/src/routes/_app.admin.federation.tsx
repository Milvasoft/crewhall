import {
  FederationDomain,
  FederationDomainPattern,
  type FederationPeer,
  type UpdateFederation,
} from '@crewhall/shared';
import { Badge, Button, Icon, IconButton, Input, Skeleton, Switch, toast } from '@crewhall/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { PageHeader, SettingsCard, SettingsRow } from '@/components/admin/Settings';
import { Notice } from '@/components/auth/AuthLayout';
import { ConfirmDialog, CopyButton, useConfirm } from '@/components/mcp/parts';
import { SharedChannelsCard } from '@/components/federation/SharedChannelsCard';
import { Workspace } from '@/components/shell/Workspace';
import { api, isApiError } from '@/lib/api';
import { errorKey } from '@/lib/errors';
import { federationKeys, federationSettingsQuery } from '@/lib/federation/queries';
import { formatRelative } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';

export const Route = createFileRoute('/_app/admin/federation')({
  component: FederationPage,
});

/**
 * Yönetim › Güvenlik › Federasyon (roadmap 26): the switch, this installation's domain and
 * key fingerprint, allowed domains and peers. A peer turns active once both sides add it.
 */
function FederationPage() {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const settings = useQuery(federationSettingsQuery);
  const [domain, setDomain] = useState('');
  const [pattern, setPattern] = useState('');
  const removing = useConfirm<FederationPeer>();

  const refresh = (next?: Awaited<ReturnType<typeof api.call<'getFederation'>>>) => {
    if (next) qc.setQueryData(federationKeys.settings, next);
    void qc.invalidateQueries({ queryKey: federationKeys.all });
  };
  const fail = (e: unknown) => toast.error(t(errorKey(e)));

  const update = useMutation({
    mutationFn: (body: UpdateFederation) => api.call('updateFederation', { body }),
    onSuccess: (next) => {
      refresh(next);
      toast(t('federation.admin.saved'));
    },
    onError: fail,
  });
  const add = useMutation({
    mutationFn: (value: string) => api.call('addFederationPeer', { body: { domain: value } }),
    onSuccess: (peer) => {
      setDomain('');
      refresh();
      toast(t('federation.admin.added', { domain: peer.domain }));
    },
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: (peer: FederationPeer) =>
      api.call('removeFederationPeer', { params: { peerId: peer.id } }),
    onSuccess: (_, peer) => {
      removing.close();
      refresh();
      toast(t('federation.admin.removed', { domain: peer.domain }));
    },
    onError: fail,
  });

  const s = settings.data;
  const domainOk = FederationDomain.safeParse(domain).success;
  const patternOk = FederationDomainPattern.safeParse(pattern).success;

  const onAddPeer = (e: FormEvent) => {
    e.preventDefault();
    if (domainOk) add.mutate(domain.trim().toLowerCase());
  };
  const onAddPattern = (e: FormEvent) => {
    e.preventDefault();
    if (!s || !patternOk) return;
    update.mutate({ allowedDomains: [...s.allowedDomains, pattern.trim().toLowerCase()] });
    setPattern('');
  };

  return (
    <Workspace crumbs={[{ label: t('admin.title') }, { label: t('federation.nav') }]}>
      <PageHeader title={t('federation.admin.title')} subtitle={t('federation.admin.subtitle')} />
      {!s ? (
        settings.isError ? (
          <Notice tone="error">
            {isApiError(settings.error) ? t(`errors.${settings.error.code}`) : t('errors.internal')}
          </Notice>
        ) : (
          <Skeleton className="h-96 w-full rounded-2xl" />
        )
      ) : (
        <div className="grid items-start gap-5 xl:grid-cols-2">
          <SettingsCard>
            <SettingsRow
              label={t('federation.admin.enable')}
              description={t('federation.admin.enableHint')}
            >
              <Switch
                aria-label={t('federation.admin.enable')}
                checked={s.enabled}
                disabled={update.isPending}
                onCheckedChange={(enabled) => update.mutate({ enabled })}
              />
            </SettingsRow>
            <SettingsRow
              label={t('federation.admin.domain')}
              description={t('federation.admin.domainHint', { domain: s.domain })}
            >
              <code className="rounded-xs bg-bg2 px-2 py-1 font-mono text-xs">{s.domain}</code>
            </SettingsRow>
            {s.fingerprint ? (
              <SettingsRow
                label={t('federation.admin.fingerprint')}
                description={t('federation.admin.fingerprintHint')}
              >
                <span className="flex items-center gap-1">
                  <code className="rounded-xs bg-bg2 px-2 py-1 font-mono text-xs">
                    {s.fingerprint}
                  </code>
                  <CopyButton value={s.fingerprint} />
                </span>
              </SettingsRow>
            ) : null}
          </SettingsCard>

          <SettingsCard title={t('federation.admin.allowed')}>
            <p className="m-0 text-cap text-fg2">{t('federation.admin.allowedHint')}</p>
            <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
              {s.allowedDomains.map((d) => (
                <li key={d}>
                  <Badge plain className="h-7 gap-1 pr-1 font-mono text-xs">
                    {d}
                    <IconButton
                      size="xs"
                      tone="plain"
                      className="size-5"
                      aria-label={t('federation.admin.removeAllowed', { domain: d })}
                      disabled={update.isPending}
                      onClick={() =>
                        update.mutate({ allowedDomains: s.allowedDomains.filter((x) => x !== d) })
                      }
                    >
                      <Icon name="x" size={11} />
                    </IconButton>
                  </Badge>
                </li>
              ))}
            </ul>
            <form className="flex gap-2" onSubmit={onAddPattern}>
              <Input
                value={pattern}
                onChange={(e) => setPattern(e.target.value)}
                placeholder={t('federation.admin.allowedPlaceholder')}
                aria-label={t('federation.admin.allowed')}
                className="font-mono"
              />
              <Button type="submit" variant="out" disabled={!patternOk || update.isPending}>
                {t('federation.admin.addAllowed')}
              </Button>
            </form>
          </SettingsCard>

          <SettingsCard title={t('federation.admin.peers')} className="xl:col-span-2">
            {!s.enabled ? (
              <p className="m-0 text-cap text-fg2">{t('federation.admin.off')}</p>
            ) : (
              <form className="flex flex-wrap items-center gap-2" onSubmit={onAddPeer}>
                <Input
                  value={domain}
                  onChange={(e) => setDomain(e.target.value)}
                  placeholder="hub.ornek.com"
                  aria-label={t('federation.admin.peerDomain')}
                  className="max-w-[320px] font-mono"
                />
                <Button type="submit" variant="pri" loading={add.isPending} disabled={!domainOk}>
                  <Icon name="plus" size={15} />
                  {t('federation.admin.addPeer')}
                </Button>
                <span className="text-xs text-fg2">{t('federation.admin.addPeerHint')}</span>
              </form>
            )}
            {s.peers.length === 0 ? (
              <p className="m-0 text-cap text-fg2">{t('federation.admin.empty')}</p>
            ) : (
              <ul className="m-0 flex list-none flex-col p-0">
                {s.peers.map((p) => (
                  <li
                    key={p.id}
                    className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line py-3 first:border-t-0"
                  >
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="flex items-center gap-2">
                        <span className="font-mono text-cap font-semibold">{p.domain}</span>
                        <Badge tone={p.status === 'active' ? 'ok' : 'warn'}>
                          {t(`federation.admin.status.${p.status}`)}
                        </Badge>
                      </span>
                      <span className="text-xs text-fg2">
                        {[
                          p.name,
                          p.status === 'active'
                            ? p.lastSeenAt
                              ? t('federation.admin.lastSeen', {
                                  time: formatRelative(p.lastSeenAt, locale),
                                })
                              : null
                            : p.requested
                              ? t('federation.admin.requested')
                              : t('federation.admin.waiting'),
                          p.fingerprint,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    </span>
                    {p.requested && s.enabled ? (
                      <Button
                        size="sm"
                        variant="pri"
                        loading={add.isPending && add.variables === p.domain}
                        onClick={() => add.mutate(p.domain)}
                      >
                        {t('federation.admin.accept')}
                      </Button>
                    ) : null}
                    <Button size="sm" variant="dng" onClick={() => removing.ask(p)}>
                      {t('federation.admin.remove')}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </SettingsCard>
          {s.enabled && s.sharedChannels ? (
            <SharedChannelsCard
              settings={s.sharedChannels}
              saving={update.isPending}
              onSave={(sharedChannels) => update.mutate({ sharedChannels })}
            />
          ) : null}
        </div>
      )}
      <ConfirmDialog
        open={removing.target !== null}
        onOpenChange={(o) => !o && removing.close()}
        title={t('federation.admin.remove')}
        body={t('federation.admin.removeConfirm', { domain: removing.target?.domain ?? '' })}
        confirm={t('federation.admin.remove')}
        pending={remove.isPending}
        onConfirm={() => removing.target && remove.mutate(removing.target)}
      />
    </Workspace>
  );
}
