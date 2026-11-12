import { type OidcClient, type OidcProviderInfo } from '@crewhall/shared';
import {
  Badge,
  Button,
  EmptyState,
  Icon,
  IconButton,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  Skeleton,
  SpaceDot,
  Switch,
  Table,
  Tag,
  Td,
  Th,
  toast,
} from '@crewhall/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { PageHeader } from '@/components/admin/Settings';
import { Notice } from '@/components/auth/AuthLayout';
import { ClientSecretDialog, OidcClientDialog } from '@/components/identity/OidcClientDialog';
import { useIdentityReauth } from '@/components/identity/ReauthDialog';
import { AppMark, ConfirmDialog, CopyValue, ToggleRow } from '@/components/identity/parts';
import { Workspace } from '@/components/shell/Workspace';
import { api, isApiError } from '@/lib/api';
import { formatRelative } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { clientHost, daysUntil, secretState } from '@/lib/identity/oidcClients';
import { identityKeys, oidcProviderQuery } from '@/lib/identity/queries';
import { orgSpacesQuery } from '@/lib/queries';

type SecretView = {
  client: OidcClient;
  secret: string | null;
  expiresAt: string | null;
  rotated: boolean;
};

/** Yönetim › SSO uygulamaları (design 9.12, 9.13): Crewhall as an OpenID Connect provider. */
export function SsoAppsPage() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const info = useQuery(oidcProviderQuery);
  const [editing, setEditing] = useState<OidcClient | 'new' | null>(null);
  const [secret, setSecret] = useState<SecretView | null>(null);

  const refresh = () => qc.invalidateQueries({ queryKey: identityKeys.oidc });

  return (
    <Workspace crumbs={[{ label: t('admin.title') }, { label: t('identity.nav.sso') }]}>
      <PageHeader
        title={t('identity.sso.title')}
        subtitle={t('identity.sso.subtitle')}
        actions={
          <Button variant="pri" size="sm" onClick={() => setEditing('new')}>
            <Icon name="plus" size={16} />
            {t('identity.sso.add')}
          </Button>
        }
      />
      {info.isError ? (
        <Notice tone="error">
          {isApiError(info.error) ? t(`errors.${info.error.code}`) : t('errors.internal')}
        </Notice>
      ) : !info.data ? (
        <Skeleton className="h-96 w-full rounded-2xl" />
      ) : (
        <>
          <ProviderStrip info={info.data} />
          <ClientsTable
            clients={info.data.clients}
            onEdit={setEditing}
            onSecret={setSecret}
            onAdd={() => setEditing('new')}
          />
          <div className="grid items-start gap-5 pb-6 xl:grid-cols-2">
            <ProviderSettings info={info.data} />
            <LoginsCard clients={info.data.clients} />
          </div>
        </>
      )}
      <OidcClientDialog
        open={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)}
        client={editing && editing !== 'new' ? editing : undefined}
        onSaved={({ created }) => {
          setEditing(null);
          void refresh();
          if (created) {
            setSecret({
              client: created.client,
              secret: created.clientSecret,
              expiresAt: created.client.secretExpiresAt,
              rotated: false,
            });
          } else {
            toast(t('ui.saved'));
          }
        }}
      />
      <ClientSecretDialog
        open={secret !== null}
        onClose={() => setSecret(null)}
        client={secret?.client ?? null}
        secret={secret?.secret ?? null}
        expiresAt={secret?.expiresAt ?? null}
        rotated={secret?.rotated}
      />
    </Workspace>
  );
}

/** Issuer, discovery and signing key (9.12 header block). */
function ProviderStrip({ info }: { info: OidcProviderInfo }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const rotate = useMutation({
    mutationFn: () => api.call('rotateOidcSigningKey'),
    onSuccess: (next) => {
      setConfirm(false);
      qc.setQueryData(identityKeys.oidc, next);
      toast(t('identity.sso.keyRotatedToast'));
    },
    onError: (e) => toast(isApiError(e) ? t(`errors.${e.code}`) : t('errors.internal')),
  });
  const key = info.signingKey;
  const discoveryPath = (() => {
    try {
      return new URL(info.discoveryUrl).pathname;
    } catch {
      return info.discoveryUrl;
    }
  })();
  return (
    <section className="grid gap-4 rounded-2xl bg-surface px-5 py-3.5 shadow-line md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-xs text-fg2">{t('identity.sso.issuer')}</span>
        <CopyValue value={info.issuer} />
      </div>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-xs text-fg2">{t('identity.sso.discovery')}</span>
        <span className="flex min-w-0 items-center" title={info.discoveryUrl}>
          <span className="truncate font-mono text-[13px] font-semibold">{discoveryPath}</span>
          <CopyButtonOnly value={info.discoveryUrl} />
        </span>
      </div>
      <div className="flex items-center gap-3">
        <div className="flex flex-col gap-0.5 md:items-end">
          <span className="text-xs text-fg2">{t('identity.sso.signingKey')}</span>
          <span className="font-mono text-[13px] font-semibold">
            {key
              ? `${key.alg} · ${t('identity.sso.rotatedAgo', { count: Math.max(0, -daysUntil(key.createdAt)) })}`
              : t('identity.sso.noKey')}
          </span>
        </div>
        <IconButton
          aria-label={t('identity.sso.rotateKey')}
          onClick={() => setConfirm(true)}
          size="sm"
        >
          <Icon name="refresh" size={16} />
        </IconButton>
      </div>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={t('identity.sso.rotateKeyTitle')}
        body={t('identity.sso.rotateKeyBody')}
        confirm={t('identity.sso.rotateKey')}
        danger={false}
        pending={rotate.isPending}
        onConfirm={() => rotate.mutate()}
      />
    </section>
  );
}

function CopyButtonOnly({ value }: { value: string }) {
  const { t } = useI18n();
  return (
    <IconButton
      size="xs"
      tone="plain"
      aria-label={t('identity.common.copy')}
      onClick={() => {
        void navigator.clipboard
          .writeText(value)
          .then(() => toast(t('identity.common.copied')))
          .catch(() => undefined);
      }}
    >
      <Icon name="copy" size={14} />
    </IconButton>
  );
}

function ClientsTable({
  clients,
  onEdit,
  onSecret,
  onAdd,
}: {
  clients: OidcClient[];
  onEdit: (c: OidcClient) => void;
  onSecret: (v: SecretView) => void;
  onAdd: () => void;
}) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const reauth = useIdentityReauth();
  const spaces = useQuery(orgSpacesQuery());
  const [deleting, setDeleting] = useState<OidcClient | null>(null);
  const [rotating, setRotating] = useState<OidcClient | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: identityKeys.oidc });
  const fail = (e: unknown) => toast(isApiError(e) ? t(`errors.${e.code}`) : t('errors.internal'));

  const toggle = useMutation({
    mutationFn: (c: OidcClient) =>
      api.call('updateOidcClient', {
        params: { oidcClientId: c.id },
        body: { enabled: !c.enabled },
      }),
    onSuccess: (c) => {
      void refresh();
      toast(c.enabled ? t('identity.sso.enabledToast') : t('identity.sso.disabledToast'));
    },
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: (c: OidcClient) => api.call('deleteOidcClient', { params: { oidcClientId: c.id } }),
    onSuccess: () => {
      setDeleting(null);
      void refresh();
      toast(t('identity.sso.deletedToast'));
    },
    onError: fail,
  });
  const rotate = useMutation({
    mutationFn: (c: OidcClient) =>
      api.call('rotateOidcClientSecret', { params: { oidcClientId: c.id } }),
    onSuccess: (res, c) => {
      setRotating(null);
      void refresh();
      onSecret({ client: c, secret: res.clientSecret, expiresAt: res.expiresAt, rotated: true });
    },
    onError: (e, c) => {
      if (reauth.handle(e, () => rotate.mutate(c))) return;
      fail(e);
    },
  });

  const spaceColor = (id: string) => spaces.data?.items.find((s) => s.id === id)?.color;

  return (
    <div className="overflow-x-auto rounded-2xl bg-surface shadow-line">
      <Table>
        <thead>
          <tr>
            <Th>{t('identity.sso.cols.app')}</Th>
            <Th>{t('identity.sso.cols.clientId')}</Th>
            <Th>{t('identity.sso.cols.type')}</Th>
            <Th>{t('identity.sso.cols.access')}</Th>
            <Th>{t('identity.sso.cols.lastLogin')}</Th>
            <Th>{t('identity.sso.cols.status')}</Th>
            <Th />
          </tr>
        </thead>
        <tbody>
          {clients.length === 0 ? (
            <tr>
              <Td colSpan={7}>
                <EmptyState
                  icon="key"
                  title={t('identity.sso.emptyTitle')}
                  description={t('identity.sso.emptyBody')}
                >
                  <Button variant="inv" size="sm" onClick={onAdd}>
                    {t('identity.sso.add')}
                  </Button>
                </EmptyState>
              </Td>
            </tr>
          ) : (
            clients.map((c) => {
              const s = secretState(c);
              const color = c.access.kind === 'space' ? spaceColor(c.access.spaceId) : undefined;
              return (
                <tr key={c.id} className={c.enabled ? undefined : 'opacity-60'}>
                  <Td>
                    <span className="flex items-center gap-2.5">
                      <AppMark name={c.name} logoUrl={c.logoUrl} />
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate text-cap font-semibold">{c.name}</span>
                        <span className="truncate text-xs text-fg2">{clientHost(c)}</span>
                      </span>
                    </span>
                  </Td>
                  <Td>
                    <span className="font-mono text-[13px] font-semibold">{c.clientId}</span>
                  </Td>
                  <Td className="text-cap whitespace-nowrap text-fg2">
                    {t(`identity.sso.typeShort.${c.type}`)}
                  </Td>
                  <Td className="text-cap whitespace-nowrap">
                    {c.access.kind === 'all' ? (
                      <span className="font-semibold">{t('identity.sso.accessAll')}</span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 font-semibold">
                        {color ? <SpaceDot color={color} /> : null}
                        {c.access.spaceName}
                      </span>
                    )}
                  </Td>
                  <Td className="text-cap whitespace-nowrap text-fg2">
                    {c.lastLoginAt
                      ? [formatRelative(c.lastLoginAt, locale), c.lastLoginUser?.name]
                          .filter(Boolean)
                          .join(' · ')
                      : t('identity.sso.neverUsed')}
                  </Td>
                  <Td>
                    <span className="flex flex-wrap gap-1">
                      {!c.enabled ? (
                        <Badge>{t('identity.sso.status.disabled')}</Badge>
                      ) : s.kind === 'expired' ? (
                        <Badge tone="danger">{t('identity.sso.status.expired')}</Badge>
                      ) : s.kind === 'expiring' ? (
                        <Badge tone="warn">
                          {t('identity.sso.status.expiring', { count: s.days })}
                        </Badge>
                      ) : (
                        <Badge tone="ok">{t('identity.sso.status.active')}</Badge>
                      )}
                      {c.guestsAllowed ? <Tag>{t('identity.sso.guestsTag')}</Tag> : null}
                    </span>
                  </Td>
                  <Td className="text-right">
                    <Menu>
                      <MenuTrigger asChild>
                        <IconButton
                          size="sm"
                          tone="plain"
                          aria-label={t('identity.sso.actions', { name: c.name })}
                        >
                          <Icon name="dots" size={18} />
                        </IconButton>
                      </MenuTrigger>
                      <MenuContent align="end" className="w-56">
                        <MenuItem icon="edit" onSelect={() => onEdit(c)}>
                          {t('identity.sso.edit')}
                        </MenuItem>
                        {c.type === 'web' ? (
                          <MenuItem icon="refresh" onSelect={() => setRotating(c)}>
                            {t('identity.sso.rotateSecret')}
                          </MenuItem>
                        ) : null}
                        <MenuItem
                          icon={c.enabled ? 'lock' : 'unlock'}
                          onSelect={() => toggle.mutate(c)}
                        >
                          {c.enabled ? t('identity.sso.disable') : t('identity.sso.enable')}
                        </MenuItem>
                        <MenuSeparator />
                        <MenuItem icon="trash" danger onSelect={() => setDeleting(c)}>
                          {t('identity.sso.delete')}
                        </MenuItem>
                      </MenuContent>
                    </Menu>
                  </Td>
                </tr>
              );
            })
          )}
        </tbody>
      </Table>
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={t('identity.sso.deleteTitle', { name: deleting?.name ?? '' })}
        body={t('identity.sso.deleteBody')}
        confirm={t('identity.sso.delete')}
        pending={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
      <ConfirmDialog
        open={rotating !== null}
        onOpenChange={(o) => !o && setRotating(null)}
        title={t('identity.sso.rotateTitle', { name: rotating?.name ?? '' })}
        body={t('identity.sso.rotateBody')}
        confirm={t('identity.sso.rotateSecret')}
        pending={rotate.isPending}
        onConfirm={() => rotating && rotate.mutate(rotating)}
      />
      {reauth.dialog}
    </div>
  );
}

function ProviderSettings({ info }: { info: OidcProviderInfo }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const id = useId();
  const update = useMutation({
    mutationFn: (body: Partial<OidcProviderInfo['settings']>) =>
      api.call('updateOidcProviderSettings', { body }),
    onSuccess: (next) => {
      qc.setQueryData(identityKeys.oidc, next);
      toast(t('ui.saved'));
    },
    onError: (e) => toast(isApiError(e) ? t(`errors.${e.code}`) : t('errors.internal')),
  });
  return (
    <section className="flex flex-col rounded-2xl bg-surface px-5 py-2 shadow-line">
      <ToggleRow
        id={`${id}-skip`}
        label={t('identity.sso.skipConsent')}
        hint={t('identity.sso.skipConsentHint')}
      >
        <Switch
          id={`${id}-skip`}
          checked={info.settings.skipConsentForInternal}
          onCheckedChange={(v) => update.mutate({ skipConsentForInternal: v })}
        />
      </ToggleRow>
      <ToggleRow
        id={`${id}-guests`}
        label={t('identity.sso.guests')}
        hint={t('identity.sso.guestsHint')}
      >
        <Switch
          id={`${id}-guests`}
          checked={info.settings.guestsAllowed}
          onCheckedChange={(v) => update.mutate({ guestsAllowed: v })}
        />
      </ToggleRow>
    </section>
  );
}

/** "Son 7 gün SSO girişleri" bars per app (9.12). */
function LoginsCard({ clients }: { clients: OidcClient[] }) {
  const { t } = useI18n();
  const rows = [...clients].sort((a, b) => b.logins7d - a.logins7d);
  const max = Math.max(1, ...rows.map((c) => c.logins7d));
  return (
    <section className="flex flex-col gap-2.5 rounded-2xl bg-surface p-5 shadow-line">
      <div className="flex items-center justify-between">
        <h2 className="m-0 text-sm font-semibold">{t('identity.sso.loginsTitle')}</h2>
        <span className="text-xs text-fg3">{t('identity.sso.loginsAside')}</span>
      </div>
      {rows.length === 0 ? (
        <p className="m-0 text-xs text-fg2">{t('identity.sso.noLogins')}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {rows.map((c) => (
            <li
              key={c.id}
              className="grid grid-cols-[minmax(0,1fr)_40px_minmax(0,1.4fr)] items-center gap-3"
            >
              <span className="truncate text-cap font-semibold">{c.name}</span>
              <span className="text-right text-cap tn text-fg2">{c.logins7d}</span>
              <span className="h-1.5 overflow-hidden rounded-full bg-bg2">
                <span
                  className="block h-full rounded-full bg-fg"
                  style={{ width: `${(c.logins7d / max) * 100}%` }}
                />
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
