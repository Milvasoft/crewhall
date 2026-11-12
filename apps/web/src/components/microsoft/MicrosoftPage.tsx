import {
  MICROSOFT_RAW_PATHS,
  type DriveMount,
  type IntegrationKey,
  type MicrosoftIntegrations,
  type MountKind,
} from '@crewhall/shared';
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
  Textarea,
  toast,
} from '@crewhall/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';
import { PageHeader } from '@/components/admin/Settings';
import { Notice } from '@/components/auth/AuthLayout';
import { ConfirmDialog, CopyField, InfoRow } from '@/components/identity/parts';
import { Workspace } from '@/components/shell/Workspace';
import { config } from '@/config';
import { api } from '@/lib/api';
import { errorKey } from '@/lib/errors';
import { formatRelative } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { microsoftKeys, microsoftQuery } from '@/lib/microsoft/queries';

/**
 * Yönetim › Entegrasyonlar › Microsoft 365 (sonraki-isler.md "Microsoft entegrasyonları"): the
 * app registration, then one card per integration with its switch, steps and settings. Each
 * integration is off until switched on here.
 */
export function MicrosoftPage() {
  const { t } = useI18n();
  const q = useQuery(microsoftQuery);
  return (
    <Workspace
      crumbs={[
        { label: t('admin.title') },
        { label: t('microsoft.admin.back') },
        { label: t('microsoft.admin.title') },
      ]}
    >
      <PageHeader title={t('microsoft.admin.title')} subtitle={t('microsoft.admin.subtitle')} />
      {q.isError ? (
        <Notice tone="error">{t(errorKey(q.error))}</Notice>
      ) : !q.data ? (
        <div className="flex flex-col gap-4">
          <Skeleton className="h-48 rounded-2xl" />
          <Skeleton className="h-48 rounded-2xl" />
        </div>
      ) : (
        <div className="flex flex-col gap-4 pb-6">
          <AppCard data={q.data} />
          <EntraCard data={q.data} />
          <OutlookCard data={q.data} />
          <TeamsCard data={q.data} />
          <StorageCard data={q.data} />
        </div>
      )}
    </Workspace>
  );
}

function useSwitch(key: IntegrationKey) {
  const { t } = useI18n();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { enabled: boolean; botAppId?: string }) =>
      api.call('updateMicrosoftIntegration', { params: { integration: key }, body }),
    onSuccess: (data) => qc.setQueryData(microsoftKeys.overview, data),
    onError: (e) => toast.error(t(errorKey(e))),
  });
}

function Card({
  title,
  hint,
  icon,
  integration,
  data,
  children,
}: {
  title: string;
  hint: string;
  icon: Parameters<typeof Icon>[0]['name'];
  integration?: IntegrationKey;
  data: MicrosoftIntegrations;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const toggle = useSwitch(integration ?? 'entra');
  const on = integration ? data.switches[integration] : false;
  return (
    <section
      aria-label={title}
      className="flex flex-col gap-3 rounded-2xl bg-surface p-4 shadow-line"
    >
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-bg2">
          <Icon name={icon} size={20} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <h2 className="m-0 text-sub font-semibold">{title}</h2>
          <span className="text-xs text-fg2">{hint}</span>
        </div>
        {integration ? (
          <label className="flex items-center gap-2 text-cap font-semibold">
            <Switch
              checked={on}
              disabled={toggle.isPending || (integration === 'teams' && !data.teams.botAppId)}
              aria-label={`${title}: ${t('microsoft.admin.enabled')}`}
              onCheckedChange={(v) => toggle.mutate({ enabled: v })}
            />
            {t(on ? 'microsoft.admin.on' : 'microsoft.admin.off')}
          </label>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function Steps({ items }: { items: string[] }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-semibold text-fg2">{t('microsoft.admin.steps')}</span>
      <ol className="m-0 flex list-decimal flex-col gap-1 pl-5 text-cap">
        {items.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>
    </div>
  );
}

const rawUrl = (path: string) => new URL(path, config.apiUrl).toString();

// ---- 1. App registration ----------------------------------------------------------------------

function AppCard({ data }: { data: MicrosoftIntegrations }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const app = data.app;
  const [tenantId, setTenant] = useState(app.tenantId ?? '');
  const [clientId, setClient] = useState(app.clientId ?? '');
  const [secret, setSecret] = useState('');
  const save = useMutation({
    mutationFn: () =>
      api.call('updateMicrosoftApp', {
        body: {
          tenantId: tenantId.trim(),
          clientId: clientId.trim(),
          ...(secret ? { clientSecret: secret } : {}),
        },
      }),
    onSuccess: () => {
      setSecret('');
      toast(t('microsoft.admin.saved'));
      void qc.invalidateQueries({ queryKey: microsoftKeys.overview });
    },
    onError: (e) => toast.error(t(errorKey(e))),
  });
  const test = useMutation({
    mutationFn: () => api.call('testMicrosoftApp'),
    onSettled: () => void qc.invalidateQueries({ queryKey: microsoftKeys.overview }),
    onError: (e) => toast.error(t(errorKey(e))),
  });
  return (
    <Card title={t('microsoft.app.title')} hint={t('microsoft.app.hint')} icon="key" data={data}>
      <form
        className="grid gap-3 md:grid-cols-3"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Field label={t('microsoft.app.tenant')} hint={t('microsoft.app.tenantHint')}>
          <Input value={tenantId} onChange={(e) => setTenant(e.target.value)} autoComplete="off" />
        </Field>
        <Field label={t('microsoft.app.clientId')}>
          <Input value={clientId} onChange={(e) => setClient(e.target.value)} autoComplete="off" />
        </Field>
        <Field
          label={t('microsoft.app.secret')}
          hint={
            app.secretSet
              ? t('microsoft.app.secretSet', { key: app.secretHint ?? '' })
              : t('microsoft.app.secretMissing')
          }
        >
          <Input
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            autoComplete="off"
          />
        </Field>
        <div className="flex flex-wrap gap-2 md:col-span-3">
          <Button
            type="submit"
            variant="inv"
            loading={save.isPending}
            disabled={!tenantId.trim() || !clientId.trim()}
          >
            {t('microsoft.app.save')}
          </Button>
          <Button
            type="button"
            variant="out"
            loading={test.isPending}
            disabled={!app.secretSet}
            onClick={() => test.mutate()}
          >
            {t('microsoft.app.test')}
          </Button>
        </div>
      </form>
      {test.data ? (
        <p
          role="status"
          className={test.data.ok ? 'm-0 text-cap text-success' : 'm-0 text-cap text-danger'}
        >
          {!test.data.ok
            ? t('microsoft.app.testFailed', { error: test.data.error ?? '' })
            : test.data.roles.length
              ? t('microsoft.app.testOk', { names: test.data.roles.join(', ') })
              : t('microsoft.app.testNoRoles')}
        </p>
      ) : null}
      <div className="flex flex-col gap-1 rounded-lg bg-bg2 px-3 py-2">
        <span className="text-xs font-semibold">{t('microsoft.admin.permissions')}</span>
        <span className="text-xs text-fg2">{t('microsoft.app.permissionsBody')}</span>
        <ul className="m-0 pl-5 text-xs">
          <li>{t('microsoft.app.permSites')}</li>
          <li>{t('microsoft.app.permFiles')}</li>
          <li>{t('microsoft.app.permGroups')}</li>
        </ul>
      </div>
    </Card>
  );
}

// ---- Entra ID ---------------------------------------------------------------------------------

function EntraCard({ data }: { data: MicrosoftIntegrations }) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const providers = data.entra.providers;
  const [providerId, setProvider] = useState(providers[0]?.id ?? '');
  const [name, setName] = useState('Entra ID');
  const [secret, setSecret] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => api.call('createScimToken', { body: { name: name.trim(), providerId } }),
    onSuccess: (res) => {
      setSecret(res.secret);
      void qc.invalidateQueries({ queryKey: microsoftKeys.overview });
    },
    onError: (e) => toast.error(t(errorKey(e))),
  });
  const revoke = useMutation({
    mutationFn: (tokenId: string) => api.call('revokeScimToken', { params: { tokenId } }),
    onSuccess: () => {
      setRevoking(null);
      void qc.invalidateQueries({ queryKey: microsoftKeys.overview });
    },
    onError: (e) => toast.error(t(errorKey(e))),
  });
  return (
    <Card
      title={t('microsoft.entra.title')}
      hint={t('microsoft.entra.hint')}
      icon="users"
      integration="entra"
      data={data}
    >
      <Steps
        items={[1, 2, 3, 4].map((i) => t(`microsoft.entra.step${i}` as 'microsoft.entra.step1'))}
      />
      <Field label={t('microsoft.entra.scimUrl')}>
        <CopyField value={data.entra.scimUrl} label={t('microsoft.entra.scimUrl')} />
      </Field>
      {providers.length === 0 ? (
        <Notice tone="info">{t('microsoft.entra.noProvider')}</Notice>
      ) : (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <Field label={t('microsoft.entra.provider')} className="min-w-[220px]">
            <Select value={providerId} onValueChange={setProvider}>
              <SelectTrigger aria-label={t('microsoft.entra.provider')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {providers.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label={t('microsoft.entra.tokenName')} className="min-w-[180px] flex-1">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Button
            type="submit"
            variant="out"
            loading={create.isPending}
            disabled={!data.switches.entra || !providerId || !name.trim()}
          >
            {t('microsoft.entra.createToken')}
          </Button>
        </form>
      )}
      {secret ? (
        <div className="flex flex-col gap-1">
          <Notice tone="info">{t('microsoft.entra.tokenOnce')}</Notice>
          <CopyField value={secret} secret label={t('microsoft.entra.createToken')} />
        </div>
      ) : null}
      <div className="flex flex-col">
        <span className="text-xs font-semibold text-fg2">{t('microsoft.entra.tokens')}</span>
        {data.entra.tokens.length === 0 ? (
          <span className="text-cap text-fg2">{t('microsoft.entra.noTokens')}</span>
        ) : (
          data.entra.tokens.map((tok) => (
            <InfoRow
              key={tok.id}
              label={t('microsoft.entra.tokenRow', {
                name: tok.name,
                key: tok.hint,
                title: tok.providerName,
              })}
            >
              <span className="flex items-center gap-2">
                <span className="font-normal text-fg2">
                  {tok.lastUsedAt
                    ? t('microsoft.entra.lastUsed', {
                        when: formatRelative(tok.lastUsedAt, locale),
                      })
                    : t('microsoft.entra.neverUsed')}
                </span>
                <Button size="sm" variant="gh" onClick={() => setRevoking(tok.id)}>
                  {t('microsoft.entra.revoke')}
                </Button>
              </span>
            </InfoRow>
          ))
        )}
      </div>
      <span className="text-cap text-fg2">
        {t('microsoft.entra.provisioned', {
          count: data.entra.provisioned,
          n: data.entra.deactivated,
        })}
      </span>
      <div className="flex flex-col gap-1 rounded-lg bg-bg2 px-3 py-2">
        <span className="text-xs font-semibold">{t('microsoft.entra.caTitle')}</span>
        <span className="text-xs text-fg2">{t('microsoft.entra.caBody')}</span>
      </div>
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(o) => !o && setRevoking(null)}
        title={t('microsoft.entra.revokeTitle')}
        body={t('microsoft.entra.revokeBody')}
        confirm={t('microsoft.entra.revoke')}
        pending={revoke.isPending}
        onConfirm={() => revoking && revoke.mutate(revoking)}
      />
    </Card>
  );
}

// ---- Outlook and Teams ------------------------------------------------------------------------

function OutlookCard({ data }: { data: MicrosoftIntegrations }) {
  const { t } = useI18n();
  return (
    <Card
      title={t('microsoft.outlook.title')}
      hint={t('microsoft.outlook.hint')}
      icon="mail"
      integration="outlook"
      data={data}
    >
      <Steps
        items={[1, 2, 3, 4].map((i) =>
          t(`microsoft.outlook.step${i}` as 'microsoft.outlook.step1'),
        )}
      />
      {data.outlook.clientId ? (
        <InfoRow label={t('microsoft.outlook.client')}>{data.outlook.clientId}</InfoRow>
      ) : null}
      {data.switches.outlook ? (
        <Button asChild variant="out" className="self-start">
          <a href={rawUrl(MICROSOFT_RAW_PATHS.outlookManifest)} download>
            <Icon name="download" size={16} />
            {t('microsoft.outlook.manifest')}
          </a>
        </Button>
      ) : null}
    </Card>
  );
}

function TeamsCard({ data }: { data: MicrosoftIntegrations }) {
  const { t } = useI18n();
  const [bot, setBot] = useState(data.teams.botAppId ?? '');
  const toggle = useSwitch('teams');
  return (
    <Card
      title={t('microsoft.teams.title')}
      hint={t('microsoft.teams.hint')}
      icon="chat"
      integration="teams"
      data={data}
    >
      <Steps
        items={[1, 2, 3, 4].map((i) => t(`microsoft.teams.step${i}` as 'microsoft.teams.step1'))}
      />
      <Field label={t('microsoft.teams.endpoint')}>
        <CopyField value={data.teams.messagingEndpoint} label={t('microsoft.teams.endpoint')} />
      </Field>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          toggle.mutate({ enabled: true, botAppId: bot.trim() });
        }}
      >
        <Field label={t('microsoft.teams.botAppId')} className="min-w-[280px] flex-1">
          <Input value={bot} onChange={(e) => setBot(e.target.value)} autoComplete="off" />
        </Field>
        <Button
          type="submit"
          variant="out"
          loading={toggle.isPending}
          disabled={!/^[0-9a-f-]{36}$/i.test(bot.trim())}
        >
          {t('microsoft.app.save')}
        </Button>
      </form>
      {data.switches.teams ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button asChild variant="out">
            <a href={rawUrl(MICROSOFT_RAW_PATHS.teamsPackage)} download>
              <Icon name="download" size={16} />
              {t('microsoft.teams.package')}
            </a>
          </Button>
          <span className="text-cap text-fg2">
            {t('microsoft.teams.linked', { count: data.teams.linkedPeople })}
          </span>
        </div>
      ) : null}
    </Card>
  );
}

// ---- External storage -----------------------------------------------------------------------

function StorageCard({ data }: { data: MicrosoftIntegrations }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const mounts = useQuery({
    queryKey: microsoftKeys.mounts,
    queryFn: () => api.call('listDriveMounts'),
  });
  const jobs = useQuery({
    queryKey: microsoftKeys.jobs,
    queryFn: () => api.call('listImportJobs'),
  });
  const [removing, setRemoving] = useState<DriveMount | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: microsoftKeys.mounts });
    void qc.invalidateQueries({ queryKey: microsoftKeys.overview });
  };
  const test = useMutation({
    mutationFn: (mountId: string) => api.call('testDriveMount', { params: { mountId } }),
    onSuccess: (res) => {
      if (res.ok) toast(t('microsoft.storage.testOk'));
      else toast.error(res.error ?? t('errors.mount_unreachable'));
      refresh();
    },
    onError: (e) => toast.error(t(errorKey(e))),
  });
  const remove = useMutation({
    mutationFn: (mountId: string) => api.call('deleteDriveMount', { params: { mountId } }),
    onSuccess: () => {
      setRemoving(null);
      refresh();
    },
    onError: (e) => toast.error(t(errorKey(e))),
  });
  const statusOf = (m: DriveMount) => (m.lastOk === null ? 'unknown' : m.lastOk ? 'ok' : 'error');
  return (
    <Card
      title={t('microsoft.storage.title')}
      hint={t('microsoft.storage.hint')}
      icon="folder"
      integration="externalStorage"
      data={data}
    >
      <Steps items={[t('microsoft.storage.step1'), t('microsoft.storage.step2')]} />
      <div className="flex flex-col">
        <span className="text-xs font-semibold text-fg2">{t('microsoft.storage.mounts')}</span>
        {(mounts.data?.items ?? []).length === 0 ? (
          <span className="text-cap text-fg2">{t('microsoft.storage.empty')}</span>
        ) : (
          mounts.data!.items.map((m) => (
            <InfoRow key={m.id} label={`${m.name} · ${m.spaceName}`}>
              <span className="flex items-center gap-2">
                <span className="truncate font-normal text-fg2">{m.location}</span>
                <Badge
                  tone={
                    statusOf(m) === 'ok' ? 'ok' : statusOf(m) === 'error' ? 'danger' : 'default'
                  }
                >
                  {t(`microsoft.storage.status.${statusOf(m)}`)}
                </Badge>
                <Button size="sm" variant="gh" onClick={() => test.mutate(m.id)}>
                  {t('microsoft.storage.test')}
                </Button>
                <Button size="sm" variant="gh" onClick={() => setRemoving(m)}>
                  {t('microsoft.storage.delete')}
                </Button>
              </span>
            </InfoRow>
          ))
        )}
      </div>
      <AddMountForm onDone={refresh} />
      <OneDriveMove disabled={!data.switches.externalStorage} />
      <div className="flex flex-col">
        <span className="text-xs font-semibold text-fg2">{t('microsoft.storage.jobs')}</span>
        {(jobs.data?.items ?? []).length === 0 ? (
          <span className="text-cap text-fg2">{t('microsoft.storage.noJobs')}</span>
        ) : (
          jobs.data!.items.map((j) => (
            <InfoRow key={j.id} label={j.source}>
              <span className="flex items-center gap-2">
                <span className="font-normal text-fg2">
                  {t('microsoft.storage.jobLine', { count: j.files, n: j.skipped })}
                </span>
                <Badge
                  tone={j.status === 'done' ? 'ok' : j.status === 'failed' ? 'danger' : 'info'}
                >
                  {t(`microsoft.storage.jobStatus.${j.status}`)}
                </Badge>
              </span>
            </InfoRow>
          ))
        )}
      </div>
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={t('microsoft.storage.deleteTitle')}
        body={t('microsoft.storage.deleteBody')}
        confirm={t('microsoft.storage.delete')}
        pending={remove.isPending}
        onConfirm={() => removing && remove.mutate(removing.id)}
      />
    </Card>
  );
}

function AddMountForm({ onDone }: { onDone: () => void }) {
  const { t } = useI18n();
  const spaces = useQuery({ queryKey: ['spaces', 'list'], queryFn: () => api.call('listSpaces') });
  const shared = (spaces.data?.items ?? []).filter((s) => s.kind === 'shared');
  const [kind, setKind] = useState<MountKind>('sharepoint');
  const [f, setF] = useState({
    name: '',
    spaceId: '',
    siteUrl: '',
    library: '',
    rootPath: '',
    user: '',
    share: '',
    domain: '',
    username: '',
    password: '',
    readOnly: false,
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF({ ...f, [k]: e.target.value });
  const create = useMutation({
    mutationFn: () => {
      const common = { spaceId: f.spaceId, name: f.name.trim(), readOnly: f.readOnly };
      const body =
        kind === 'sharepoint'
          ? {
              ...common,
              kind,
              config: {
                siteUrl: f.siteUrl.trim(),
                library: f.library.trim(),
                rootPath: f.rootPath,
              },
            }
          : kind === 'onedrive'
            ? { ...common, kind, config: { user: f.user.trim(), rootPath: f.rootPath } }
            : {
                ...common,
                kind,
                config: {
                  share: f.share.trim(),
                  domain: f.domain.trim(),
                  username: f.username.trim(),
                  rootPath: f.rootPath,
                },
                password: f.password,
              };
      return api.call('createDriveMount', { body: body as never });
    },
    onSuccess: () => {
      setF({
        ...f,
        name: '',
        siteUrl: '',
        library: '',
        rootPath: '',
        user: '',
        share: '',
        password: '',
      });
      onDone();
    },
    onError: (e) => toast.error(t(errorKey(e))),
  });
  return (
    <form
      aria-label={t('microsoft.storage.add')}
      className="grid gap-2 rounded-lg border border-line p-3 md:grid-cols-3"
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate();
      }}
    >
      <Field label={t('microsoft.storage.kind')}>
        <Select value={kind} onValueChange={(v) => setKind(v as MountKind)}>
          <SelectTrigger aria-label={t('microsoft.storage.kind')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(['sharepoint', 'onedrive', 'smb'] as const).map((k) => (
              <SelectItem key={k} value={k}>
                {t(`microsoft.storage.kinds.${k}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field label={t('microsoft.storage.name')}>
        <Input value={f.name} onChange={set('name')} />
      </Field>
      <Field label={t('microsoft.storage.space')}>
        <Select value={f.spaceId} onValueChange={(v) => setF({ ...f, spaceId: v })}>
          <SelectTrigger aria-label={t('microsoft.storage.space')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {shared.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      {kind === 'sharepoint' ? (
        <>
          <Field label={t('microsoft.storage.siteUrl')}>
            <Input
              value={f.siteUrl}
              onChange={set('siteUrl')}
              placeholder="https://contoso.sharepoint.com/sites/..."
            />
          </Field>
          <Field label={t('microsoft.storage.library')}>
            <Input value={f.library} onChange={set('library')} />
          </Field>
        </>
      ) : kind === 'onedrive' ? (
        <Field label={t('microsoft.storage.user')}>
          <Input value={f.user} onChange={set('user')} type="email" />
        </Field>
      ) : (
        <>
          <Field label={t('microsoft.storage.share')}>
            <Input value={f.share} onChange={set('share')} />
          </Field>
          <Field label={t('microsoft.storage.domain')}>
            <Input value={f.domain} onChange={set('domain')} />
          </Field>
          <Field label={t('microsoft.storage.username')}>
            <Input value={f.username} onChange={set('username')} autoComplete="off" />
          </Field>
          <Field label={t('microsoft.storage.password')}>
            <Input
              type="password"
              value={f.password}
              onChange={set('password')}
              autoComplete="off"
            />
          </Field>
        </>
      )}
      <Field label={t('microsoft.storage.rootPath')}>
        <Input value={f.rootPath} onChange={set('rootPath')} />
      </Field>
      <div className="flex items-center justify-between gap-2 md:col-span-3">
        <label className="flex items-center gap-2 text-cap font-semibold">
          <Switch checked={f.readOnly} onCheckedChange={(v) => setF({ ...f, readOnly: v })} />
          {t('microsoft.storage.readOnly')}
        </label>
        <Button
          type="submit"
          variant="out"
          loading={create.isPending}
          disabled={!f.name.trim() || !f.spaceId}
        >
          <Icon name="plus" size={16} />
          {t('microsoft.storage.create')}
        </Button>
      </div>
    </form>
  );
}

function OneDriveMove({ disabled }: { disabled: boolean }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [users, setUsers] = useState('');
  const [folder, setFolder] = useState('OneDrive');
  const start = useMutation({
    mutationFn: () =>
      api.call('startOneDriveMove', {
        body: {
          users: users
            .split(/[\s,;]+/)
            .map((u) => u.trim())
            .filter(Boolean),
          folderName: folder.trim() || 'OneDrive',
        },
      }),
    onSuccess: (res) => {
      setUsers('');
      toast(t('microsoft.storage.moveStarted', { count: res.items.length }));
      void qc.invalidateQueries({ queryKey: microsoftKeys.jobs });
    },
    onError: (e) => toast.error(t(errorKey(e))),
  });
  return (
    <form
      aria-label={t('microsoft.storage.moveTitle')}
      className="flex flex-col gap-2 rounded-lg border border-line p-3"
      onSubmit={(e) => {
        e.preventDefault();
        start.mutate();
      }}
    >
      <span className="text-cap font-semibold">{t('microsoft.storage.moveTitle')}</span>
      <span className="text-xs text-fg2">{t('microsoft.storage.moveHint')}</span>
      <Field label={t('microsoft.storage.moveUsers')}>
        <Textarea rows={3} value={users} onChange={(e) => setUsers(e.target.value)} />
      </Field>
      <div className="flex flex-wrap items-end gap-2">
        <Field label={t('microsoft.storage.moveFolder')} className="min-w-[200px] flex-1">
          <Input value={folder} onChange={(e) => setFolder(e.target.value)} />
        </Field>
        <Button
          type="submit"
          variant="out"
          loading={start.isPending}
          disabled={disabled || !users.trim()}
        >
          {t('microsoft.storage.moveStart')}
        </Button>
      </div>
    </form>
  );
}

/** The Microsoft 365 card on Yönetim › Entegrasyonlar. */
export function MicrosoftSummaryCard() {
  const { t } = useI18n();
  const q = useQuery(microsoftQuery);
  const on = q.data ? Object.values(q.data.switches).filter(Boolean).length : 0;
  return (
    <section
      aria-label={t('microsoft.card.title')}
      className="flex items-center gap-3 rounded-2xl bg-surface p-4 shadow-line"
    >
      <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-bg2">
        <Icon name="grid" size={20} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <h2 className="m-0 text-sub font-semibold">{t('microsoft.card.title')}</h2>
        <span className="text-xs text-fg2">{t('microsoft.card.hint')}</span>
        {q.data ? (
          <span className="text-xs text-fg2">{t('microsoft.card.active', { count: on })}</span>
        ) : null}
      </div>
      <Button asChild variant="out" size="sm">
        <Link to="/admin/integrations/microsoft">{t('microsoft.card.open')}</Link>
      </Button>
    </section>
  );
}
