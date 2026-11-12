import {
  type MailAuthMode,
  type MailProbeResult,
  type MailSecurity,
  type MailServerSettings,
  type MailServerTestResult,
  type UpdateMailServerSettings,
} from '@crewhall/shared';
import {
  Badge,
  Button,
  Field,
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
import { useState, type ReactNode } from 'react';
import { PageHeader, SettingsCard, SettingsRow } from '@/components/admin/Settings';
import { Notice } from '@/components/auth/AuthLayout';
import { CopyField } from '@/components/identity/parts';
import { Workspace } from '@/components/shell/Workspace';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n/I18nContext';
import { mailKeys, mailServerSettingsQuery } from '@/lib/mail/queries';
import { codeText, mailError } from './errors';

type Form = Omit<UpdateMailServerSettings, 'oauthClientSecret'> & { oauthClientSecret: string };

export const MAIL_PRESETS = {
  microsoft: {
    imapHost: 'outlook.office365.com',
    imapPort: 993,
    imapSecurity: 'tls',
    smtpHost: 'smtp.office365.com',
    smtpPort: 587,
    smtpSecurity: 'starttls',
    authMode: 'oauth_microsoft',
    saveSentCopy: false,
  },
  google: {
    imapHost: 'imap.gmail.com',
    imapPort: 993,
    imapSecurity: 'tls',
    smtpHost: 'smtp.gmail.com',
    smtpPort: 465,
    smtpSecurity: 'tls',
    authMode: 'oauth_google',
    saveSentCopy: false,
  },
} as const satisfies Record<string, Partial<Form>>;

const SECURITIES: MailSecurity[] = ['tls', 'starttls', 'none'];
const AUTHS: MailAuthMode[] = ['password', 'oauth_microsoft', 'oauth_google'];

function formOf(s: MailServerSettings): Form {
  return {
    imapHost: s.imapHost,
    imapPort: s.imapPort,
    imapSecurity: s.imapSecurity,
    smtpHost: s.smtpHost,
    smtpPort: s.smtpPort,
    smtpSecurity: s.smtpSecurity,
    authMode: s.authMode,
    usernameFormat: s.usernameFormat,
    oauthClientId: s.oauthClientId ?? '',
    oauthClientSecret: '',
    oauthTenant: s.oauthTenant ?? '',
    saveSentCopy: s.saveSentCopy,
    allowRemoteImages: s.allowRemoteImages,
    pollMinutes: s.pollMinutes,
  };
}

/** Yönetim › Posta sunucusu: IMAP/SMTP servers, how users sign in, and a connection test. */
export function MailAdminPage() {
  const { t } = useI18n();
  const settings = useQuery(mailServerSettingsQuery);
  return (
    <Workspace crumbs={[{ label: t('admin.title') }, { label: t('mail.admin.title') }]}>
      <div className="flex w-full max-w-[760px] flex-col gap-5">
        <PageHeader title={t('mail.admin.title')} subtitle={t('mail.admin.subtitle')} />
        {settings.data ? (
          // A save returns new settings (updatedAt): the form starts over from them.
          <SettingsForm key={settings.data.updatedAt ?? 'new'} initial={settings.data} />
        ) : settings.isError ? (
          <Notice tone="error">{mailError(t, settings.error)}</Notice>
        ) : (
          <Skeleton className="h-96 w-full" />
        )}
      </div>
    </Workspace>
  );
}

function SettingsForm({ initial }: { initial: MailServerSettings }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [form, setForm] = useState<Form>(() => formOf(initial));
  const set = <K extends keyof Form>(key: K, value: Form[K]) =>
    setForm((f) => ({ ...f, [key]: value }));
  const oauth = form.authMode !== 'password';
  const oauthMissing =
    oauth &&
    (!form.oauthClientId?.trim() || (!form.oauthClientSecret && !initial.hasOauthClientSecret));

  const save = useMutation({
    mutationFn: () =>
      api.call('mailUpdateServerSettings', {
        body: {
          ...form,
          imapHost: form.imapHost.trim(),
          smtpHost: form.smtpHost.trim(),
          oauthClientId: oauth ? form.oauthClientId?.trim() || null : null,
          oauthTenant:
            form.authMode === 'oauth_microsoft' ? form.oauthTenant?.trim() || null : null,
          // Empty keeps the stored secret.
          ...(form.oauthClientSecret ? { oauthClientSecret: form.oauthClientSecret } : {}),
        },
      }),
    onSuccess: (saved) => {
      toast(t('mail.admin.saved'));
      qc.setQueryData(mailKeys.settings, saved);
      void qc.invalidateQueries({ queryKey: mailKeys.account });
    },
    onError: (e) => toast(mailError(t, e)),
  });

  const preset = (key: keyof typeof MAIL_PRESETS | 'custom') => {
    if (key === 'custom') return;
    setForm((f) => ({ ...f, ...MAIL_PRESETS[key] }));
  };

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <SettingsCard title={t('mail.admin.preset')}>
        <div className="flex flex-wrap gap-2 py-3">
          {(['microsoft', 'google'] as const).map((k) => (
            <Button key={k} type="button" size="sm" variant="out" onClick={() => preset(k)}>
              {t(`mail.admin.presets.${k}`)}
            </Button>
          ))}
        </div>
      </SettingsCard>

      <ServerCard
        title={t('mail.admin.imap')}
        prefix="imap"
        host={form.imapHost}
        port={form.imapPort}
        security={form.imapSecurity}
        onHost={(v) => set('imapHost', v)}
        onPort={(v) => set('imapPort', v)}
        onSecurity={(v) => set('imapSecurity', v)}
      />
      <ServerCard
        title={t('mail.admin.smtp')}
        prefix="smtp"
        host={form.smtpHost}
        port={form.smtpPort}
        security={form.smtpSecurity}
        onHost={(v) => set('smtpHost', v)}
        onPort={(v) => set('smtpPort', v)}
        onSecurity={(v) => set('smtpSecurity', v)}
      />
      {form.imapSecurity === 'none' || form.smtpSecurity === 'none' ? (
        <Notice tone="warn">{t('mail.admin.noneWarning')}</Notice>
      ) : null}

      <SettingsCard title={t('mail.admin.auth')}>
        <SettingsRow label={t('mail.admin.auth')}>
          <Choice
            label={t('mail.admin.auth')}
            value={form.authMode}
            onChange={(v) => set('authMode', v)}
            options={AUTHS.map((a) => ({ value: a, label: t(`mail.admin.auths.${a}`) }))}
          />
        </SettingsRow>
        {!oauth ? (
          <SettingsRow label={t('mail.admin.usernameFormat')}>
            <Choice
              label={t('mail.admin.usernameFormat')}
              value={form.usernameFormat ?? 'email'}
              onChange={(v) => set('usernameFormat', v)}
              options={(['email', 'local'] as const).map((v) => ({
                value: v,
                label: t(`mail.admin.usernameFormats.${v}`),
              }))}
            />
          </SettingsRow>
        ) : (
          <div className="flex flex-col gap-3 border-t border-line py-3">
            <Field label={t('mail.admin.clientId')}>
              <Input
                value={form.oauthClientId ?? ''}
                onChange={(e) => set('oauthClientId', e.target.value)}
                autoComplete="off"
              />
            </Field>
            <Field
              label={t('mail.admin.clientSecret')}
              hint={initial.hasOauthClientSecret ? t('mail.admin.clientSecretKeep') : undefined}
            >
              <Input
                type="password"
                autoComplete="new-password"
                value={form.oauthClientSecret}
                onChange={(e) => set('oauthClientSecret', e.target.value)}
              />
            </Field>
            {form.authMode === 'oauth_microsoft' ? (
              <Field label={t('mail.admin.tenant')} hint={t('mail.admin.tenantHint')}>
                <Input
                  value={form.oauthTenant ?? ''}
                  onChange={(e) => set('oauthTenant', e.target.value)}
                />
              </Field>
            ) : null}
            <Field label={t('mail.admin.redirectUri')} hint={t('mail.admin.redirectHint')}>
              <CopyField value={initial.oauthRedirectUri} />
            </Field>
            {oauthMissing ? <Notice tone="warn">{t('mail.admin.oauthRequired')}</Notice> : null}
          </div>
        )}
      </SettingsCard>

      <SettingsCard title={t('mail.admin.behaviour')}>
        <SettingsRow label={t('mail.admin.saveSent')} description={t('mail.admin.saveSentHint')}>
          <Switch
            aria-label={t('mail.admin.saveSent')}
            checked={form.saveSentCopy ?? true}
            onCheckedChange={(v) => set('saveSentCopy', v)}
          />
        </SettingsRow>
        <SettingsRow
          label={t('mail.admin.remoteImages')}
          description={t('mail.admin.remoteImagesHint')}
        >
          <Switch
            aria-label={t('mail.admin.remoteImages')}
            checked={form.allowRemoteImages ?? true}
            onCheckedChange={(v) => set('allowRemoteImages', v)}
          />
        </SettingsRow>
        <SettingsRow
          label={t('mail.admin.poll')}
          description={t('mail.admin.pollHint')}
          htmlFor="mail-poll"
        >
          <Input
            id="mail-poll"
            type="number"
            min={1}
            max={60}
            className="w-24"
            value={form.pollMinutes ?? 5}
            onChange={(e) =>
              set('pollMinutes', Math.min(60, Math.max(1, Number(e.target.value) || 1)))
            }
          />
        </SettingsRow>
      </SettingsCard>

      <TestCard form={form} />

      <div className="flex justify-end">
        <Button
          type="submit"
          variant="pri"
          loading={save.isPending}
          disabled={!form.imapHost.trim() || !form.smtpHost.trim() || oauthMissing}
        >
          {t('mail.admin.save')}
        </Button>
      </div>
    </form>
  );
}

function ServerCard({
  title,
  prefix,
  host,
  port,
  security,
  onHost,
  onPort,
  onSecurity,
}: {
  title: string;
  prefix: string;
  host: string;
  port: number;
  security: MailSecurity;
  onHost: (v: string) => void;
  onPort: (v: number) => void;
  onSecurity: (v: MailSecurity) => void;
}) {
  const { t } = useI18n();
  return (
    <SettingsCard title={title}>
      <div className="grid grid-cols-1 gap-3 py-3 sm:grid-cols-[1fr_96px_180px]">
        <Field label={t('mail.admin.host')} id={`${prefix}-host`}>
          <Input
            value={host}
            onChange={(e) => onHost(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
        <Field label={t('mail.admin.port')} id={`${prefix}-port`}>
          <Input
            type="number"
            min={1}
            max={65535}
            value={port}
            onChange={(e) => onPort(Math.min(65535, Math.max(1, Number(e.target.value) || 1)))}
          />
        </Field>
        <Field label={t('mail.admin.security')} id={`${prefix}-security`}>
          <Choice
            label={`${title} · ${t('mail.admin.security')}`}
            value={security}
            onChange={onSecurity}
            options={SECURITIES.map((s) => ({ value: s, label: t(`mail.admin.securities.${s}`) }))}
          />
        </Field>
      </div>
    </SettingsCard>
  );
}

function Choice<V extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: V;
  onChange: (v: V) => void;
  options: { value: V; label: ReactNode }[];
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as V)}>
      <SelectTrigger aria-label={label} className="min-w-[180px]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function TestCard({ form }: { form: Form }) {
  const { t } = useI18n();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const test = useMutation({
    mutationFn: (): Promise<MailServerTestResult> =>
      api.call('mailTestServer', {
        body: {
          imapHost: form.imapHost.trim(),
          imapPort: form.imapPort,
          imapSecurity: form.imapSecurity,
          smtpHost: form.smtpHost.trim(),
          smtpPort: form.smtpPort,
          smtpSecurity: form.smtpSecurity,
          ...(username && password ? { username, password } : {}),
        },
      }),
    onError: (e) => toast(mailError(t, e)),
  });
  return (
    <SettingsCard title={t('mail.admin.testTitle')}>
      <div className="flex flex-col gap-3 py-3">
        <span className="text-xs text-fg2">{t('mail.admin.testUserHint')}</span>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label={t('mail.admin.testUser')}>
            <Input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="off"
            />
          </Field>
          <Field label={t('mail.admin.testPassword')}>
            <Input
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            size="sm"
            loading={test.isPending}
            disabled={!form.imapHost.trim() || !form.smtpHost.trim()}
            onClick={() => test.mutate()}
          >
            {t('mail.admin.testRun')}
          </Button>
          {test.data ? (
            <>
              <ProbeBadge label="IMAP" result={test.data.imap} />
              <ProbeBadge label="SMTP" result={test.data.smtp} />
            </>
          ) : null}
        </div>
        {test.data
          ? [test.data.imap, test.data.smtp]
              .filter((r) => !r.ok && r.detail)
              .map((r, i) => (
                <code key={i} className="rounded-md bg-bg2 px-2 py-1 text-xs break-all text-fg2">
                  {r.detail}
                </code>
              ))
          : null}
      </div>
    </SettingsCard>
  );
}

function ProbeBadge({ label, result }: { label: string; result: MailProbeResult }) {
  const { t } = useI18n();
  return (
    <Badge tone={result.ok ? 'ok' : 'danger'}>
      {label} ·{' '}
      {result.ok ? t('mail.admin.testOk') : codeText(t, result.error, 'mail_server_unreachable')}
    </Badge>
  );
}
