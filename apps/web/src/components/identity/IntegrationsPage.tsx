import { type IdentityProvider } from '@crewhall/shared';
import {
  Badge,
  Button,
  cn,
  EmptyState,
  Icon,
  IconBox,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  Skeleton,
  Tag,
  toast,
} from '@crewhall/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { PageHeader } from '@/components/admin/Settings';
import { Notice } from '@/components/auth/AuthLayout';
import { InfoRow } from '@/components/identity/parts';
import { Workspace } from '@/components/shell/Workspace';
import { GifSettingsCard } from '@/components/chat/GifSettingsCard';
import { MicrosoftSummaryCard } from '@/components/microsoft/MicrosoftPage';
import { OfficeSettingsCard } from '@/components/office/OfficeSettingsCard';
import { api, isApiError } from '@/lib/api';
import { formatRelative } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import {
  KIND_ICON,
  PRESET_ORDER,
  PRESETS,
  providerHealth,
  type ProviderHealth,
} from '@/lib/identity/providers';
import { identityKeys, identityProvidersQuery } from '@/lib/identity/queries';

const HEALTH_TONE: Record<ProviderHealth, 'ok' | 'danger' | 'default' | 'info'> = {
  connected: 'ok',
  error: 'danger',
  off: 'default',
  untested: 'info',
};

/**
 * Yönetim › Entegrasyonlar (design 9.14). This module implements the identity part: one card
 * per external identity provider (OIDC, SAML, Active Directory / LDAP).
 */
export function IntegrationsPage() {
  const { t } = useI18n();
  const list = useQuery(identityProvidersQuery);
  const items = list.data?.items ?? [];
  const errors = items.filter((p) => providerHealth(p) === 'error').length;
  const connected = items.filter((p) => providerHealth(p) === 'connected').length;

  return (
    <Workspace crumbs={[{ label: t('admin.title') }, { label: t('identity.nav.integrations') }]}>
      <PageHeader
        title={t('identity.idp.pageTitle')}
        subtitle={
          list.data
            ? t('identity.idp.pageSummary', { count: connected, n: errors })
            : t('identity.idp.pageSubtitle')
        }
      />
      <div className="flex flex-col gap-3 pb-6">
        <div className="flex items-end justify-between gap-3">
          <div className="flex min-w-0 flex-col">
            <h2 className="m-0 text-sub font-semibold">{t('identity.idp.sectionTitle')}</h2>
            <span className="text-xs text-fg2">{t('identity.idp.sectionHint')}</span>
          </div>
          <AddProviderMenu />
        </div>
        {list.isError ? (
          <Notice tone="error">
            {isApiError(list.error) ? t(`errors.${list.error.code}`) : t('errors.internal')}
          </Notice>
        ) : !list.data ? (
          <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
            <Skeleton className="h-56 rounded-2xl" />
            <Skeleton className="h-56 rounded-2xl" />
          </div>
        ) : items.length === 0 ? (
          <div className="rounded-2xl bg-surface shadow-line">
            <EmptyState
              icon="key"
              title={t('identity.idp.emptyTitle')}
              description={t('identity.idp.emptyBody')}
            >
              <AddProviderMenu />
            </EmptyState>
          </div>
        ) : (
          <div className="grid items-start gap-4 lg:grid-cols-2 2xl:grid-cols-3">
            {items.map((p) => (
              <ProviderCard key={p.id} provider={p} />
            ))}
          </div>
        )}
      </div>
      {/* Microsoft 365: Entra provisioning, Outlook, Teams, SharePoint and OneDrive. */}
      <div className="flex flex-col gap-3 pb-6">
        <MicrosoftSummaryCard />
      </div>
      {/* Chat: GIFs through GIPHY with the org's own key. */}
      <div className="flex flex-col gap-3 pb-6">
        <GifSettingsCard />
        {/* Office: the WOPI document server Drive edits Word, Excel and PowerPoint with. */}
        <OfficeSettingsCard />
      </div>
    </Workspace>
  );
}

function AddProviderMenu() {
  const { t } = useI18n();
  const navigate = useNavigate();
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button variant="out" size="sm">
          <Icon name="plus" size={16} />
          {t('identity.idp.add')}
        </Button>
      </MenuTrigger>
      <MenuContent align="end" className="w-64">
        {PRESET_ORDER.map((preset) => (
          <MenuItem
            key={preset}
            icon={PRESETS[preset].icon}
            onSelect={() =>
              void navigate({ to: '/admin/integrations/identity/new', search: { preset } })
            }
          >
            <span className="flex flex-col">
              <span>{t(`identity.idp.presets.${preset}`)}</span>
              <span className="text-xs font-normal text-fg2">
                {t(`identity.idp.kinds.${PRESETS[preset].kind}`)}
              </span>
            </span>
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}

/** One integration card (9.14): status, linked people, last sign-in / sync, domains. */
function ProviderCard({ provider: p }: { provider: IdentityProvider }) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const health = providerHealth(p);
  const test = useMutation({
    mutationFn: () => api.call('testIdentityProvider', { body: { providerId: p.id } }),
    onSuccess: (res) => {
      toast(res.ok ? t('identity.idp.testOk') : t('identity.idp.testFailed'));
      void qc.invalidateQueries({ queryKey: identityKeys.providers });
    },
    onError: (e) => toast(isApiError(e) ? t(`errors.${e.code}`) : t('errors.internal')),
  });
  const s = p.status;
  return (
    <section
      className={cn(
        'flex flex-col gap-3 rounded-2xl bg-surface p-4 shadow-line',
        health === 'error' && 'shadow-[inset_0_0_0_1.5px_var(--danger)]',
      )}
    >
      <div className="flex items-start gap-3">
        <IconBox icon={KIND_ICON[p.kind]} />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-semibold">{p.name}</span>
          <span className="truncate text-xs text-fg2">
            {t(`identity.idp.presets.${p.preset}`)} · {t(`identity.idp.kinds.${p.kind}`)}
          </span>
        </div>
        <Badge tone={HEALTH_TONE[health]}>{t(`identity.idp.status.${health}`)}</Badge>
      </div>
      {health === 'error' && s.lastError ? (
        <div className="rounded-lg bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] px-3 py-2 text-cap">
          <span className="font-semibold text-danger">{s.lastError}</span>
          {s.lastTestAt ? (
            <span className="block text-xs text-fg2">
              {t('identity.idp.lastTest', { when: formatRelative(s.lastTestAt, locale) })}
            </span>
          ) : null}
        </div>
      ) : null}
      <div className="flex flex-col">
        <InfoRow label={t('identity.idp.linkedUsers')}>
          {t('identity.idp.people', { count: s.linkedUsers })}
        </InfoRow>
        <InfoRow label={t('identity.idp.lastLogin')}>
          {s.lastLoginAt ? formatRelative(s.lastLoginAt, locale) : t('identity.idp.never')}
        </InfoRow>
        {p.kind === 'ldap' ? (
          <InfoRow label={t('identity.idp.lastSync')}>
            {s.lastSyncAt
              ? `${formatRelative(s.lastSyncAt, locale)}${
                  s.lastSync
                    ? ` · ${t('identity.idp.syncShort', {
                        count: s.lastSync.checked,
                        n: s.lastSync.suspended,
                      })}`
                    : ''
                }`
              : t('identity.idp.never')}
          </InfoRow>
        ) : null}
        <InfoRow label={t('identity.idp.domains')}>
          <span className="inline-flex items-center gap-1.5">
            {p.domains.length ? p.domains.join(', ') : t('identity.idp.noDomains')}
            {p.enforceSso ? <Tag tone="inv">{t('identity.idp.enforced')}</Tag> : null}
          </span>
        </InfoRow>
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="default" loading={test.isPending} onClick={() => test.mutate()}>
          {t('identity.idp.test')}
        </Button>
        <Button size="sm" variant="gh" asChild>
          <Link to="/admin/integrations/identity/$providerId" params={{ providerId: p.id }}>
            {t('identity.idp.settings')}
          </Link>
        </Button>
      </div>
    </section>
  );
}
