import type { CalendarIntegration, CalendarProvider } from '@crewhall/shared';
import {
  Badge,
  Button,
  Field,
  Icon,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Switch,
  toast,
} from '@crewhall/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { PageHeader, SettingsCard, SettingsRow } from '@/components/admin/Settings';
import { Notice } from '@/components/auth/AuthLayout';
import { CopyField } from '@/components/identity/parts';
import { Workspace } from '@/components/shell/Workspace';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n/I18nContext';
import {
  calendarAccountsKey,
  calendarIntegrationsKey,
  calendarIntegrationsQuery,
} from '@/lib/calendar/queries';
import { contactsKeys } from '@/lib/contacts/queries';
import { useFail } from './bits';

const SCOPES: Record<Exclude<CalendarProvider, 'exchange'>, string> = {
  google: 'calendar.events, calendar.calendarlist.readonly',
  microsoft: 'Calendars.ReadWrite, offline_access',
};

/** What the Workspace admin grants the service account's client id (domain-wide delegation). */
const WORKSPACE_SCOPES = [
  'https://www.googleapis.com/auth/admin.directory.user.readonly',
  'https://www.googleapis.com/auth/calendar',
].join(', ');

/** Yönetim › Takvim: the OAuth clients people connect Google and Microsoft calendars with. */
export function CalendarAdminPage() {
  const { t } = useI18n();
  const q = useQuery(calendarIntegrationsQuery());
  return (
    <Workspace crumbs={[{ label: t('admin.title') }, { label: t('calendar.admin.title') }]}>
      <div className="flex w-full max-w-[760px] flex-col gap-5">
        <PageHeader title={t('calendar.admin.title')} subtitle={t('calendar.admin.hint')} />
        {q.data ? (
          q.data.items.map((i) =>
            // A save returns a new updatedAt: the form starts over from it.
            i.provider === 'exchange' ? (
              <ExchangeCard key={`${i.provider}:${i.updatedAt ?? 'new'}`} initial={i} />
            ) : (
              <ProviderCard
                key={`${i.provider}:${i.updatedAt ?? 'new'}`}
                initial={i}
                provider={i.provider}
              />
            ),
          )
        ) : q.isError ? (
          <Notice tone="error">{t('errors.internal')}</Notice>
        ) : (
          <Skeleton className="h-96 w-full" />
        )}
      </div>
    </Workspace>
  );
}

/** On-premises Exchange: people sign in with their own account; here is only the server. */
function ExchangeCard({ initial }: { initial: CalendarIntegration }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const fail = useFail();
  const [enabled, setEnabled] = useState(initial.enabled);
  const [url, setUrl] = useState(initial.ewsUrl ?? '');
  const [auth, setAuth] = useState(initial.ewsAuth ?? 'ntlm');
  const [contactsSync, setContactsSync] = useState(initial.contactsSync ?? false);
  const invalid = url.trim() ? !/^https:\/\/\S+$/.test(url.trim()) : enabled;
  const save = useMutation({
    mutationFn: () =>
      api.call('updateCalendarIntegration', {
        params: { provider: 'exchange' },
        body: { enabled, ewsUrl: url.trim() || null, ewsAuth: auth, contactsSync },
      }),
    onSuccess: async () => {
      toast(t('calendar.admin.saved'));
      await qc.invalidateQueries({ queryKey: calendarIntegrationsKey });
      await qc.invalidateQueries({ queryKey: calendarAccountsKey });
      await qc.invalidateQueries({ queryKey: contactsKeys.all });
    },
    onError: fail,
  });
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <SettingsCard
        title={
          <span className="flex items-center gap-2">
            {t('calendar.admin.exchange.title')}
            {initial.accountCount ? (
              <Badge>{t('calendar.admin.accounts', { count: initial.accountCount })}</Badge>
            ) : null}
          </span>
        }
      >
        <SettingsRow
          label={t('calendar.admin.enabled')}
          description={t('calendar.admin.exchange.help')}
        >
          <Switch
            checked={enabled}
            onCheckedChange={setEnabled}
            aria-label={`${t('calendar.admin.enabled')} · ${t('calendar.admin.exchange.title')}`}
          />
        </SettingsRow>
        <div className="flex flex-col gap-3 border-t border-line py-3">
          <Field
            label={t('calendar.admin.exchange.url')}
            hint={t('calendar.admin.exchange.urlHint')}
          >
            <Input
              type="url"
              value={url}
              maxLength={500}
              placeholder="https://mail.example.com/EWS/Exchange.asmx"
              onChange={(e) => setUrl(e.target.value)}
              autoComplete="off"
            />
          </Field>
          <Field
            label={t('calendar.admin.exchange.auth')}
            hint={t('calendar.admin.exchange.authHint')}
          >
            <Select value={auth} onValueChange={(v) => setAuth(v as 'ntlm' | 'basic')}>
              <SelectTrigger aria-label={t('calendar.admin.exchange.auth')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ntlm">{t('calendar.admin.exchange.authNtlm')}</SelectItem>
                <SelectItem value="basic">{t('calendar.admin.exchange.authBasic')}</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <SettingsRow
            label={t('calendar.admin.exchange.contacts')}
            description={t('calendar.admin.exchange.contactsHint')}
          >
            <Switch
              checked={contactsSync}
              onCheckedChange={setContactsSync}
              aria-label={t('calendar.admin.exchange.contacts')}
            />
          </SettingsRow>
          <div className="flex justify-end">
            <Button
              type="submit"
              variant="pri"
              size="sm"
              loading={save.isPending}
              disabled={invalid}
            >
              {t('common.actions.save')}
            </Button>
          </div>
        </div>
      </SettingsCard>
    </form>
  );
}

function ProviderCard({
  initial,
  provider: p,
}: {
  initial: CalendarIntegration;
  provider: Exclude<CalendarProvider, 'exchange'>;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const fail = useFail();
  const [enabled, setEnabled] = useState(initial.enabled);
  const [clientId, setClientId] = useState(initial.clientId ?? '');
  const [secret, setSecret] = useState('');
  const [tenant, setTenant] = useState(initial.tenant ?? '');
  // Google Workspace: undefined keeps the stored key, null removes it.
  const [key, setKey] = useState<{ name: string; json: string } | null | undefined>(undefined);
  const [admin, setAdmin] = useState(initial.delegatedAdmin ?? '');
  const [directorySync, setDirectorySync] = useState(initial.directorySync ?? false);
  const [domainWide, setDomainWide] = useState(initial.domainWide ?? false);
  const [contactsSync, setContactsSync] = useState(initial.contactsSync ?? false);
  const missing = enabled && (!clientId.trim() || (!secret && !initial.hasClientSecret));

  const save = useMutation({
    mutationFn: () =>
      api.call('updateCalendarIntegration', {
        params: { provider: p },
        body: {
          enabled,
          domainWide,
          clientId: clientId.trim() || null,
          ...(p === 'microsoft' ? { tenant: tenant.trim() || null, contactsSync } : {}),
          // Empty keeps the stored secret.
          ...(secret ? { clientSecret: secret } : {}),
          ...(p === 'google'
            ? {
                delegatedAdmin: admin.trim() || null,
                directorySync,
                ...(key === undefined ? {} : { serviceAccountKey: key ? key.json : null }),
              }
            : {}),
        },
      }),
    onSuccess: async () => {
      toast(t('calendar.admin.saved'));
      await qc.invalidateQueries({ queryKey: calendarIntegrationsKey });
      await qc.invalidateQueries({ queryKey: calendarAccountsKey });
    },
    onError: fail,
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <SettingsCard
        title={
          <span className="flex items-center gap-2">
            {t(`calendar.admin.${p}.title`)}
            {initial.accountCount ? (
              <Badge>{t('calendar.admin.accounts', { count: initial.accountCount })}</Badge>
            ) : null}
          </span>
        }
      >
        <SettingsRow
          label={t('calendar.admin.enabled')}
          description={t(`calendar.admin.${p}.help`)}
        >
          <Switch
            checked={enabled}
            onCheckedChange={setEnabled}
            aria-label={t('calendar.admin.enabled')}
          />
        </SettingsRow>
        <div className="flex flex-col gap-3 border-t border-line py-3">
          <Field label={t('calendar.admin.clientId')}>
            <Input
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              autoComplete="off"
            />
          </Field>
          <Field
            label={t('calendar.admin.clientSecret')}
            hint={initial.hasClientSecret ? t('calendar.admin.secretKept') : undefined}
          >
            <Input
              type="password"
              autoComplete="new-password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
            />
          </Field>
          {p === 'microsoft' ? (
            <Field label={t('calendar.admin.tenant')} hint={t('calendar.admin.tenantHint')}>
              <Input
                value={tenant}
                onChange={(e) => setTenant(e.target.value)}
                autoComplete="off"
              />
            </Field>
          ) : null}
          <Field
            label={t('calendar.admin.redirectUri')}
            hint={`${t('calendar.admin.redirectHint')} ${t('calendar.admin.scopes', { scopes: SCOPES[p] })}`}
          >
            <CopyField value={initial.redirectUri} />
          </Field>
          <SettingsRow
            label={t('calendar.admin.domainWide')}
            description={t(`calendar.admin.domainWideHint.${p}`)}
          >
            <Switch
              checked={domainWide}
              onCheckedChange={setDomainWide}
              aria-label={t('calendar.admin.domainWide')}
            />
          </SettingsRow>
          {p === 'microsoft' ? (
            <SettingsRow
              label={t('calendar.admin.contactsSync')}
              description={t('calendar.admin.contactsSyncHint')}
            >
              <Switch
                checked={contactsSync}
                onCheckedChange={setContactsSync}
                aria-label={t('calendar.admin.contactsSync')}
              />
            </SettingsRow>
          ) : null}
          {p === 'google' ? (
            <WorkspaceFields
              initial={initial}
              keyFile={key}
              onKey={setKey}
              admin={admin}
              onAdmin={setAdmin}
              directorySync={directorySync}
              onDirectorySync={setDirectorySync}
            />
          ) : null}
          <div className="flex justify-end">
            <Button
              type="submit"
              variant="pri"
              size="sm"
              loading={save.isPending}
              disabled={missing}
            >
              {t('common.actions.save')}
            </Button>
          </div>
        </div>
      </SettingsCard>
    </form>
  );
}

/**
 * Google Workspace (sonraki-isler): the service account with domain-wide delegation, the admin
 * it acts as, and the hourly directory sync (manager, department, title… for the org chart).
 */
function WorkspaceFields({
  initial,
  keyFile,
  onKey,
  admin,
  onAdmin,
  directorySync,
  onDirectorySync,
}: {
  initial: CalendarIntegration;
  keyFile: { name: string; json: string } | null | undefined;
  onKey: (k: { name: string; json: string } | null | undefined) => void;
  admin: string;
  onAdmin: (v: string) => void;
  directorySync: boolean;
  onDirectorySync: (v: boolean) => void;
}) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const fail = useFail();
  const input = useRef<HTMLInputElement>(null);
  const sync = useMutation({
    mutationFn: () => api.call('syncWorkspaceDirectory'),
    onSuccess: async (r) => {
      if (!r.directoryError) toast(t('calendar.admin.workspace.synced'));
      await qc.invalidateQueries({ queryKey: calendarIntegrationsKey });
      await qc.invalidateQueries({ queryKey: contactsKeys.all });
    },
    onError: fail,
  });
  const when = initial.directorySyncedAt
    ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
        new Date(initial.directorySyncedAt),
      )
    : null;
  return (
    <div className="flex flex-col gap-3 border-t border-line pt-3" data-testid="workspace-fields">
      <div className="flex flex-col gap-1">
        <span className="text-sm font-semibold">{t('calendar.admin.workspace.title')}</span>
        <span className="text-xs text-fg2">
          {t('calendar.admin.workspace.help', { scopes: WORKSPACE_SCOPES })}
        </span>
      </div>
      <Field
        label={t('calendar.admin.workspace.key')}
        hint={
          keyFile
            ? t('calendar.admin.workspace.keyPicked', { name: keyFile.name })
            : keyFile === null
              ? t('calendar.admin.workspace.keyRemoved')
              : initial.serviceAccountEmail
                ? t('calendar.admin.workspace.keyLoaded', { email: initial.serviceAccountEmail })
                : undefined
        }
      >
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="out" onClick={() => input.current?.click()}>
            <Icon name="upload" size={15} />
            {t('calendar.admin.workspace.pickKey')}
          </Button>
          {initial.serviceAccountEmail && keyFile === undefined ? (
            <Button type="button" size="sm" variant="gh" onClick={() => onKey(null)}>
              {t('calendar.admin.workspace.removeKey')}
            </Button>
          ) : null}
          <input
            ref={input}
            type="file"
            accept=".json,application/json"
            className="hidden"
            aria-label={t('calendar.admin.workspace.key')}
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) onKey({ name: f.name, json: await f.text() });
            }}
          />
        </div>
      </Field>
      <Field
        label={t('calendar.admin.workspace.admin')}
        hint={t('calendar.admin.workspace.adminHint')}
      >
        <Input
          type="email"
          value={admin}
          onChange={(e) => onAdmin(e.target.value)}
          autoComplete="off"
        />
      </Field>
      <SettingsRow
        label={t('calendar.admin.workspace.directory')}
        description={t('calendar.admin.workspace.directoryHint')}
      >
        <Switch
          checked={directorySync}
          onCheckedChange={onDirectorySync}
          aria-label={t('calendar.admin.workspace.directory')}
        />
      </SettingsRow>
      {initial.directorySync ? (
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <span className={initial.directoryError ? 'text-danger' : 'text-fg2'}>
            {initial.directoryError
              ? t('calendar.admin.workspace.syncError', { code: initial.directoryError })
              : when
                ? t('calendar.admin.workspace.syncedAt', { when })
                : t('calendar.admin.workspace.never')}
          </span>
          <Button
            type="button"
            size="sm"
            variant="out"
            loading={sync.isPending}
            onClick={() => sync.mutate()}
          >
            <Icon name="refresh" size={14} />
            {t('calendar.admin.workspace.syncNow')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
