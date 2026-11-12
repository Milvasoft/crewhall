import { queryKeys } from '@crewhall/api-client';
import { type IdentityProvider, type IdpTestResult } from '@crewhall/shared';
import {
  Avatar,
  Badge,
  Button,
  cn,
  EmptyState,
  Field,
  Icon,
  IconBox,
  Input,
  Segmented,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Switch,
  Table,
  Tag,
  Td,
  Textarea,
  Th,
  toast,
} from '@crewhall/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useId, useState, type ReactNode } from 'react';
import { SaveBar } from '@/components/admin/Settings';
import { Notice } from '@/components/auth/AuthLayout';
import { RoleMappingEditor } from '@/components/identity/RoleMappingEditor';
import { ConfirmDialog, CopyField, ListEditor, ToggleRow } from '@/components/identity/parts';
import { Workspace } from '@/components/shell/Workspace';
import { api, isApiError } from '@/lib/api';
import { useUnsavedGuard } from './UnsavedGuard';
import { formatRelative } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import {
  formToCreate,
  formToUpdate,
  KIND_ICON,
  missingFields,
  normalizeDomain,
  PRESETS,
  providerHealth,
  providerToForm,
  type LdapForm,
  type OidcForm,
  type ProviderForm,
  type SamlForm,
} from '@/lib/identity/providers';
import { identityKeys, linkedIdentitiesQuery } from '@/lib/identity/queries';
import { orgSpacesQuery } from '@/lib/queries';

/**
 * Identity provider settings (9.14 "Ayarlar"): every contract field, secrets write-only, the
 * values the IdP administrator needs, role mappings, connection test, directory sync and the
 * linked accounts. New providers start from a preset.
 */
export function ProviderEditor({
  provider,
  initial,
}: {
  /** Saved provider; absent while creating. */
  provider?: IdentityProvider;
  initial: ProviderForm;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const navigate = useNavigate();
  // Seeded once; the saved state comes back from the server after each save.
  const [base, setBase] = useState<ProviderForm>(initial);
  const [form, setForm] = useState<ProviderForm>(initial);
  const [version, setVersion] = useState(0);
  const [deleting, setDeleting] = useState(false);
  const [showMissing, setShowMissing] = useState(false);
  const dirty = JSON.stringify(form) !== JSON.stringify(base);
  const isNew = !provider;
  const missing = missingFields(form, Boolean(provider?.hasSecret));

  const guard = useUnsavedGuard(dirty, (path) => path.startsWith('/admin/integrations/identity/'));

  const save = useMutation({
    mutationFn: () =>
      provider
        ? api.call('updateIdentityProvider', {
            params: { providerId: provider.id },
            body: formToUpdate(form),
          })
        : api.call('createIdentityProvider', { body: formToCreate(form) }),
    onSuccess: async (saved) => {
      const next = providerToForm(saved);
      setBase(next);
      setForm(next);
      setVersion((v) => v + 1);
      qc.setQueryData(identityKeys.provider(saved.id), saved);
      await qc.invalidateQueries({ queryKey: identityKeys.providers });
      await qc.invalidateQueries({ queryKey: queryKeys.bootstrap });
      toast(t('ui.saved'));
      if (isNew) {
        await navigate({
          to: '/admin/integrations/identity/$providerId',
          params: { providerId: saved.id },
          replace: true,
        });
      }
    },
    onError: (e) => toast(isApiError(e) ? t(`errors.${e.code}`) : t('errors.internal')),
  });
  const remove = useMutation({
    mutationFn: () =>
      api.call('deleteIdentityProvider', { params: { providerId: provider?.id ?? '' } }),
    onSuccess: async () => {
      setDeleting(false);
      await qc.invalidateQueries({ queryKey: identityKeys.providers });
      await qc.invalidateQueries({ queryKey: queryKeys.bootstrap });
      toast(t('identity.idp.deleted'));
      setForm(base);
      await navigate({ to: '/admin/integrations' });
    },
    onError: (e) => toast(isApiError(e) ? t(`errors.${e.code}`) : t('errors.internal')),
  });

  const set = <K extends keyof ProviderForm>(k: K, v: ProviderForm[K]) =>
    setForm((f) => ({ ...f, [k]: v }));
  const health = provider ? providerHealth(provider) : null;

  return (
    <Workspace
      crumbs={[
        { label: t('admin.title') },
        { label: t('identity.nav.integrations') },
        { label: provider?.name ?? t(`identity.idp.presets.${form.preset}`) },
      ]}
    >
      <div className="flex shrink-0 flex-wrap items-center gap-3">
        <Button variant="gh" size="sm" asChild>
          <Link to="/admin/integrations">
            <Icon name="arrowL" size={16} />
            {t('identity.idp.back')}
          </Link>
        </Button>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <IconBox icon={KIND_ICON[form.kind]} size="lg" />
        <div className="flex min-w-0 flex-1 flex-col">
          <h1 className="m-0 truncate text-wtitle font-bold">
            {provider
              ? provider.name
              : t('identity.idp.newTitle', { name: PRESETS[form.preset].name })}
          </h1>
          <span className="text-[13.5px] text-fg2">
            {t(`identity.idp.presets.${form.preset}`)} · {t(`identity.idp.kinds.${form.kind}`)}
          </span>
        </div>
        {health ? (
          <Badge tone={health === 'connected' ? 'ok' : health === 'error' ? 'danger' : 'default'}>
            {t(`identity.idp.status.${health}`)}
          </Badge>
        ) : null}
        {provider ? (
          <Button variant="dng" size="sm" onClick={() => setDeleting(true)}>
            <Icon name="trash" size={16} />
            {t('identity.idp.delete')}
          </Button>
        ) : null}
      </div>
      <div className="grid grid-cols-1 items-start gap-5 pb-24 xl:grid-cols-[minmax(0,1fr)_400px]">
        <div className="flex min-w-0 flex-col gap-5">
          <Card title={t('identity.idp.general')}>
            <Field label={t('identity.idp.fields.name')} hint={t('identity.idp.fields.nameHint')}>
              <Input
                value={form.name}
                maxLength={80}
                onChange={(e) => set('name', e.target.value)}
                invalid={showMissing && missing.includes('name')}
                containerClassName="h-10"
              />
            </Field>
            <Toggle
              label={t('identity.idp.fields.enabled')}
              hint={t('identity.idp.fields.enabledHint')}
              checked={form.enabled}
              onChange={(v) => set('enabled', v)}
            />
            <Field
              label={t('identity.idp.fields.domains')}
              hint={t('identity.idp.fields.domainsHint')}
            >
              <ListEditor
                values={form.domains}
                onChange={(v) => set('domains', v)}
                placeholder="example.com"
                addLabel={t('identity.common.add')}
                inputLabel={t('identity.idp.fields.domains')}
                normalize={(v) => normalizeDomain(v) ?? v.trim()}
                validate={(v) => (normalizeDomain(v) ? null : t('identity.idp.badDomain'))}
              />
            </Field>
            {form.kind !== 'ldap' ? (
              <Toggle
                label={t('identity.idp.fields.enforceSso')}
                hint={t('identity.idp.fields.enforceSsoHint')}
                checked={form.enforceSso}
                onChange={(v) => set('enforceSso', v)}
              />
            ) : null}
          </Card>
          <Card key={version} title={t('identity.idp.connection')}>
            {form.kind === 'oidc' ? (
              <OidcFields
                value={form.oidc}
                onChange={(oidc) => set('oidc', oidc)}
                secret={form.secret}
                onSecret={(v) => set('secret', v)}
                hasSecret={Boolean(provider?.hasSecret)}
                urlHint={PRESETS[form.preset].urlHint}
                invalid={showMissing ? missing : []}
              />
            ) : form.kind === 'saml' ? (
              <SamlFields
                value={form.saml}
                onChange={(saml) => set('saml', saml)}
                urlHint={PRESETS[form.preset].urlHint}
                invalid={showMissing ? missing : []}
              />
            ) : (
              <LdapFields
                value={form.ldap}
                onChange={(ldap) => set('ldap', ldap)}
                secret={form.secret}
                onSecret={(v) => set('secret', v)}
                hasSecret={Boolean(provider?.hasSecret)}
                urlHint={PRESETS[form.preset].urlHint}
                invalid={showMissing ? missing : []}
              />
            )}
          </Card>
          <Card title={t('identity.idp.accounts')}>
            <Toggle
              label={t('identity.idp.fields.jit')}
              hint={t('identity.idp.fields.jitHint')}
              checked={form.jitProvisioning}
              onChange={(v) => set('jitProvisioning', v)}
            />
            <ToggleLike
              label={t('identity.idp.fields.defaultRole')}
              hint={t('identity.idp.fields.defaultRoleHint')}
            >
              <Segmented
                aria-label={t('identity.idp.fields.defaultRole')}
                value={form.defaultRole}
                onValueChange={(v) => set('defaultRole', v)}
                options={[
                  { value: 'member', label: t('common.roles.org.member') },
                  { value: 'guest', label: t('common.roles.org.guest') },
                ]}
              />
            </ToggleLike>
            <Toggle
              label={t('identity.idp.fields.linkExisting')}
              hint={t('identity.idp.fields.linkExistingHint')}
              checked={form.linkExistingByEmail}
              onChange={(v) => set('linkExistingByEmail', v)}
            />
            {form.kind !== 'ldap' ? (
              <Toggle
                label={t('identity.idp.fields.trustMfa')}
                hint={t('identity.idp.fields.trustMfaHint')}
                checked={form.trustIdpMfa}
                onChange={(v) => set('trustIdpMfa', v)}
              />
            ) : null}
            {form.kind === 'ldap' ? (
              <Toggle
                label={t('identity.idp.fields.syncEnabled')}
                hint={t('identity.idp.fields.syncEnabledHint')}
                checked={form.syncEnabled}
                onChange={(v) => set('syncEnabled', v)}
              />
            ) : null}
          </Card>
          <Card
            title={t('identity.idp.mappings')}
            aside={
              <Toggle
                inline
                label={t('identity.idp.fields.syncRoles')}
                checked={form.syncRoles}
                onChange={(v) => set('syncRoles', v)}
              />
            }
          >
            <p className="m-0 text-xs text-fg2">
              {t(form.syncRoles ? 'identity.idp.mappingsHintSync' : 'identity.idp.mappingsHint')}
            </p>
            <RoleMappingEditor
              value={form.roleMappings}
              onChange={(v) => set('roleMappings', v)}
              groupHint={
                form.kind === 'ldap'
                  ? 'CN=Crewhall-Admins,OU=Groups,DC=corp,DC=example,DC=com'
                  : 'crewhall-admins'
              }
            />
          </Card>
        </div>
        <div className="flex min-w-0 flex-col gap-5">
          {provider ? (
            <IdpAdminInfo provider={provider} />
          ) : (
            <Notice tone="info">{t('identity.idp.saveFirst')}</Notice>
          )}
          <TestPanel form={form} provider={provider} />
          {provider?.kind === 'ldap' ? <SyncPanel provider={provider} /> : null}
          {provider ? <LinkedUsers provider={provider} /> : null}
        </div>
      </div>
      {showMissing && missing.length > 0 ? (
        <div className="pointer-events-none absolute right-6 bottom-20 left-6 flex justify-center">
          <Notice tone="error" className="pointer-events-auto max-w-md">
            {t('identity.idp.missing')}
          </Notice>
        </div>
      ) : null}
      <SaveBar
        count={isNew ? 1 : dirty ? 1 : 0}
        saving={save.isPending}
        onCancel={() => {
          if (isNew) void navigate({ to: '/admin/integrations' });
          setForm(base);
          setVersion((v) => v + 1);
          setShowMissing(false);
        }}
        onSave={() => {
          if (missing.length) {
            setShowMissing(true);
            return;
          }
          setShowMissing(false);
          save.mutate();
        }}
      />
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={t('identity.idp.deleteTitle', { name: provider?.name ?? '' })}
        body={t('identity.idp.deleteBody')}
        confirm={t('identity.idp.delete')}
        pending={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
      {guard}
    </Workspace>
  );
}

function Card({
  title,
  aside,
  children,
  className,
}: {
  title: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn('flex flex-col gap-3.5 rounded-2xl bg-surface p-5 shadow-line', className)}
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="m-0 text-sm font-semibold">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
  inline,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  inline?: boolean;
}) {
  const id = useId();
  if (inline) {
    return (
      <label htmlFor={id} className="flex items-center gap-2 text-xs font-medium text-fg2">
        {label}
        <Switch id={id} checked={checked} onCheckedChange={onChange} />
      </label>
    );
  }
  return (
    <ToggleRow id={id} label={label} hint={hint}>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </ToggleRow>
  );
}

function ToggleLike({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line py-2.5">
      <span className="flex min-w-0 flex-col">
        <span className="text-cap font-semibold">{label}</span>
        {hint ? <span className="text-xs text-fg2">{hint}</span> : null}
      </span>
      {children}
    </div>
  );
}

/** Write-only secret: "kayıtlı · değiştir" until a new value is typed. */
function SecretField({
  label,
  value,
  onChange,
  stored,
  invalid,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  stored: boolean;
  invalid?: boolean;
}) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(!stored);
  return (
    <Field label={label} hint={stored ? t('identity.idp.secretHint') : undefined}>
      {editing ? (
        <Input
          type="password"
          autoComplete="new-password"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          invalid={invalid}
          containerClassName="h-10"
          trailing={
            stored ? (
              <Button
                size="xs"
                variant="gh"
                onClick={() => {
                  onChange('');
                  setEditing(false);
                }}
              >
                {t('common.actions.cancel')}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="flex h-10 items-center gap-2 rounded-lg bg-bg2 px-3 text-cap">
          <Icon name="lock" size={15} className="text-fg2" />
          <span className="flex-1 font-semibold">{t('identity.idp.secretStored')}</span>
          <Button size="xs" variant="out" onClick={() => setEditing(true)}>
            {t('identity.idp.secretChange')}
          </Button>
        </div>
      )}
    </Field>
  );
}

function TextField({
  label,
  hint,
  value,
  onChange,
  placeholder,
  mono,
  invalid,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
  invalid?: boolean;
}) {
  return (
    <Field label={label} hint={hint}>
      <Input
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        invalid={invalid}
        spellCheck={false}
        className={mono ? 'font-mono text-[13px]' : undefined}
        containerClassName="h-10"
      />
    </Field>
  );
}

function OidcFields({
  value,
  onChange,
  secret,
  onSecret,
  hasSecret,
  urlHint,
  invalid,
}: {
  value: OidcForm;
  onChange: (v: OidcForm) => void;
  secret: string;
  onSecret: (v: string) => void;
  hasSecret: boolean;
  urlHint: string;
  invalid: string[];
}) {
  const { t } = useI18n();
  const set = <K extends keyof OidcForm>(k: K, v: OidcForm[K]) => onChange({ ...value, [k]: v });
  return (
    <div className="flex flex-col gap-3.5">
      <TextField
        label={t('identity.idp.fields.issuer')}
        hint={t('identity.idp.fields.issuerHint')}
        value={value.issuer}
        placeholder={urlHint}
        onChange={(v) => set('issuer', v)}
        mono
        invalid={invalid.includes('issuer')}
      />
      <div className="grid gap-3.5 md:grid-cols-2">
        <TextField
          label={t('identity.idp.fields.clientId')}
          value={value.clientId}
          onChange={(v) => set('clientId', v)}
          mono
          invalid={invalid.includes('clientId')}
        />
        <SecretField
          label={t('identity.idp.fields.clientSecret')}
          value={secret}
          onChange={onSecret}
          stored={hasSecret}
          invalid={invalid.includes('clientSecret')}
        />
        <TextField
          label={t('identity.idp.fields.scopes')}
          value={value.scopes}
          onChange={(v) => set('scopes', v)}
          mono
        />
        <TextField
          label={t('identity.idp.fields.groupsClaim')}
          hint={t('identity.idp.fields.groupsClaimHint')}
          value={value.groupsClaim}
          onChange={(v) => set('groupsClaim', v)}
          mono
        />
      </div>
      <Field label={t('identity.idp.fields.prompt')}>
        <Select
          value={value.prompt || 'none'}
          onValueChange={(v) => set('prompt', v === 'none' ? '' : (v as OidcForm['prompt']))}
        >
          <SelectTrigger className="h-10" aria-label={t('identity.idp.fields.prompt')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">{t('identity.idp.prompt.none')}</SelectItem>
            <SelectItem value="login">{t('identity.idp.prompt.login')}</SelectItem>
            <SelectItem value="select_account">
              {t('identity.idp.prompt.select_account')}
            </SelectItem>
            <SelectItem value="consent">{t('identity.idp.prompt.consent')}</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <Toggle
        label={t('identity.idp.fields.endSession')}
        hint={t('identity.idp.fields.endSessionHint')}
        checked={value.endSessionOnLogout}
        onChange={(v) => set('endSessionOnLogout', v)}
      />
    </div>
  );
}

function SamlFields({
  value,
  onChange,
  urlHint,
  invalid,
}: {
  value: SamlForm;
  onChange: (v: SamlForm) => void;
  urlHint: string;
  invalid: string[];
}) {
  const { t } = useI18n();
  const id = useId();
  const set = <K extends keyof SamlForm>(k: K, v: SamlForm[K]) => onChange({ ...value, [k]: v });
  return (
    <div className="flex flex-col gap-3.5">
      <TextField
        label={t('identity.idp.fields.entryPoint')}
        value={value.entryPoint}
        placeholder={urlHint}
        onChange={(v) => set('entryPoint', v)}
        mono
        invalid={invalid.includes('entryPoint')}
      />
      <TextField
        label={t('identity.idp.fields.idpIssuer')}
        value={value.idpIssuer}
        onChange={(v) => set('idpIssuer', v)}
        mono
        invalid={invalid.includes('idpIssuer')}
      />
      <Field
        label={t('identity.idp.fields.idpCert')}
        hint={t('identity.idp.fields.idpCertHint')}
        id={`${id}-cert`}
      >
        <Textarea
          id={`${id}-cert`}
          rows={5}
          value={value.idpCert}
          onChange={(e) => set('idpCert', e.target.value)}
          invalid={invalid.includes('idpCert')}
          spellCheck={false}
          className="font-mono text-xs"
          placeholder="-----BEGIN CERTIFICATE-----"
        />
      </Field>
      <div className="grid gap-3.5 md:grid-cols-3">
        <TextField
          label={t('identity.idp.fields.emailAttribute')}
          value={value.emailAttribute}
          onChange={(v) => set('emailAttribute', v)}
          mono
        />
        <TextField
          label={t('identity.idp.fields.nameAttribute')}
          value={value.nameAttribute}
          onChange={(v) => set('nameAttribute', v)}
          mono
        />
        <TextField
          label={t('identity.idp.fields.groupsAttribute')}
          value={value.groupsAttribute}
          onChange={(v) => set('groupsAttribute', v)}
          mono
        />
      </div>
      <TextField
        label={t('identity.idp.fields.logoutUrl')}
        value={value.logoutUrl}
        onChange={(v) => set('logoutUrl', v)}
        mono
      />
      <Toggle
        label={t('identity.idp.fields.endSession')}
        hint={t('identity.idp.fields.endSessionHint')}
        checked={value.endSessionOnLogout}
        onChange={(v) => set('endSessionOnLogout', v)}
      />
    </div>
  );
}

function LdapFields({
  value,
  onChange,
  secret,
  onSecret,
  hasSecret,
  urlHint,
  invalid,
}: {
  value: LdapForm;
  onChange: (v: LdapForm) => void;
  secret: string;
  onSecret: (v: string) => void;
  hasSecret: boolean;
  urlHint: string;
  invalid: string[];
}) {
  const { t } = useI18n();
  const id = useId();
  const set = <K extends keyof LdapForm>(k: K, v: LdapForm[K]) => onChange({ ...value, [k]: v });
  return (
    <div className="flex flex-col gap-3.5">
      <TextField
        label={t('identity.idp.fields.url')}
        hint={t('identity.idp.fields.urlHint')}
        value={value.url}
        placeholder={urlHint}
        onChange={(v) => set('url', v)}
        mono
        invalid={invalid.includes('url')}
      />
      <div className="grid gap-3.5 md:grid-cols-2">
        <TextField
          label={t('identity.idp.fields.bindDn')}
          hint={t('identity.idp.fields.bindDnHint')}
          value={value.bindDn}
          placeholder="CN=svc-crewhall,OU=Service,DC=corp,DC=example,DC=com"
          onChange={(v) => set('bindDn', v)}
          mono
        />
        <SecretField
          label={t('identity.idp.fields.bindPassword')}
          value={secret}
          onChange={onSecret}
          stored={hasSecret}
        />
      </div>
      <TextField
        label={t('identity.idp.fields.baseDn')}
        value={value.baseDn}
        placeholder="OU=Users,DC=corp,DC=example,DC=com"
        onChange={(v) => set('baseDn', v)}
        mono
        invalid={invalid.includes('baseDn')}
      />
      <TextField
        label={t('identity.idp.fields.userFilter')}
        hint={t('identity.idp.fields.userFilterHint')}
        value={value.userFilter}
        onChange={(v) => set('userFilter', v)}
        mono
        invalid={invalid.includes('userFilter')}
      />
      <div className="grid gap-3.5 md:grid-cols-3">
        <TextField
          label={t('identity.idp.fields.emailAttribute')}
          value={value.emailAttribute}
          onChange={(v) => set('emailAttribute', v)}
          mono
        />
        <TextField
          label={t('identity.idp.fields.nameAttribute')}
          value={value.nameAttribute}
          onChange={(v) => set('nameAttribute', v)}
          mono
        />
        <TextField
          label={t('identity.idp.fields.uidAttribute')}
          hint={t('identity.idp.fields.uidAttributeHint')}
          value={value.uidAttribute}
          onChange={(v) => set('uidAttribute', v)}
          mono
        />
      </div>
      <Toggle
        label={t('identity.idp.fields.useMemberOf')}
        hint={t('identity.idp.fields.useMemberOfHint')}
        checked={value.useMemberOf}
        onChange={(v) => set('useMemberOf', v)}
      />
      {!value.useMemberOf ? (
        <div className="grid gap-3.5 md:grid-cols-2">
          <TextField
            label={t('identity.idp.fields.groupBaseDn')}
            value={value.groupBaseDn}
            onChange={(v) => set('groupBaseDn', v)}
            mono
          />
          <TextField
            label={t('identity.idp.fields.groupNameAttribute')}
            value={value.groupNameAttribute}
            onChange={(v) => set('groupNameAttribute', v)}
            mono
          />
          <div className="md:col-span-2">
            <TextField
              label={t('identity.idp.fields.groupFilter')}
              hint={t('identity.idp.fields.groupFilterHint')}
              value={value.groupFilter}
              onChange={(v) => set('groupFilter', v)}
              mono
            />
          </div>
        </div>
      ) : null}
      <Toggle
        label={t('identity.idp.fields.activeDirectory')}
        hint={t('identity.idp.fields.activeDirectoryHint')}
        checked={value.activeDirectory}
        onChange={(v) => set('activeDirectory', v)}
      />
      <Toggle
        label={t('identity.idp.fields.startTls')}
        hint={t('identity.idp.fields.startTlsHint')}
        checked={value.startTls}
        onChange={(v) => set('startTls', v)}
      />
      <Toggle
        label={t('identity.idp.fields.tlsVerify')}
        hint={t('identity.idp.fields.tlsVerifyHint')}
        checked={value.tlsVerify}
        onChange={(v) => set('tlsVerify', v)}
      />
      <Field
        label={t('identity.idp.fields.caCert')}
        hint={t('identity.idp.fields.caCertHint')}
        id={`${id}-ca`}
      >
        <Textarea
          id={`${id}-ca`}
          rows={3}
          value={value.caCert}
          onChange={(e) => set('caCert', e.target.value)}
          spellCheck={false}
          className="font-mono text-xs"
          placeholder="-----BEGIN CERTIFICATE-----"
        />
      </Field>
      <Field label={t('identity.idp.fields.timeout')}>
        <Segmented
          aria-label={t('identity.idp.fields.timeout')}
          value={String(value.timeoutMs)}
          onValueChange={(v) => set('timeoutMs', Number(v))}
          options={[3000, 5000, 8000, 15000, 30000].map((ms) => ({
            value: String(ms),
            label: t('identity.idp.seconds', { count: ms / 1000 }),
          }))}
        />
      </Field>
    </div>
  );
}

/** What the IdP administrator registers (redirect / ACS URL, SP metadata). */
function IdpAdminInfo({ provider }: { provider: IdentityProvider }) {
  const { t } = useI18n();
  if (provider.kind === 'ldap') {
    return (
      <Card title={t('identity.idp.forAdmin')}>
        <p className="m-0 text-xs text-fg2">{t('identity.idp.ldapAdminHint')}</p>
      </Card>
    );
  }
  return (
    <Card title={t('identity.idp.forAdmin')}>
      <p className="m-0 text-xs text-fg2">{t(`identity.idp.adminHint.${provider.kind}`)}</p>
      {provider.callbackUrl ? (
        <Field label={t(`identity.idp.callback.${provider.kind}`)}>
          <CopyField value={provider.callbackUrl} />
        </Field>
      ) : null}
      {provider.spEntityId ? (
        <Field label={t('identity.idp.spEntityId')}>
          <CopyField value={provider.spEntityId} />
        </Field>
      ) : null}
      {provider.spMetadataUrl ? (
        <Field label={t('identity.idp.spMetadata')}>
          <CopyField value={provider.spMetadataUrl} />
        </Field>
      ) : null}
    </Card>
  );
}

const STEP_KEYS = [
  'discovery',
  'jwks',
  'metadata',
  'certificate',
  'connect',
  'starttls',
  'tls',
  'bind',
  'search',
  'user',
  'groups',
] as const;
type StepKey = (typeof STEP_KEYS)[number];
const isStepKey = (k: string): k is StepKey => (STEP_KEYS as readonly string[]).includes(k);

/** "Bağlantıyı test et": unsaved values are tested as a draft, secrets fall back to the stored ones. */
function TestPanel({ form, provider }: { form: ProviderForm; provider?: IdentityProvider }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [username, setUsername] = useState('');
  const test = useMutation({
    mutationFn: () =>
      api.call('testIdentityProvider', {
        body: {
          ...(provider ? { providerId: provider.id } : {}),
          draft: formToCreate(form),
          ...(form.kind === 'ldap' && username.trim() ? { username: username.trim() } : {}),
        },
      }),
    onSuccess: () => {
      if (provider) void qc.invalidateQueries({ queryKey: identityKeys.providers });
    },
  });
  return (
    <Card title={t('identity.idp.testTitle')}>
      <p className="m-0 text-xs text-fg2">{t(`identity.idp.testHint.${form.kind}`)}</p>
      {form.kind === 'ldap' ? (
        <Field label={t('identity.idp.testUser')} hint={t('identity.idp.testUserHint')}>
          <Input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="ayse.yilmaz"
            spellCheck={false}
            containerClassName="h-10"
          />
        </Field>
      ) : null}
      <Button variant="inv" loading={test.isPending} onClick={() => test.mutate()}>
        <Icon name="zap" size={16} />
        {t('identity.idp.testRun')}
      </Button>
      {test.isError ? (
        <Notice tone="error">
          {isApiError(test.error) ? t(`errors.${test.error.code}`) : t('errors.internal')}
        </Notice>
      ) : null}
      {test.data ? <TestResult result={test.data} /> : null}
    </Card>
  );
}

function TestResult({ result }: { result: IdpTestResult }) {
  const { t } = useI18n();
  const spaces = useQuery(orgSpacesQuery());
  const spaceName = (id: string) => spaces.data?.items.find((s) => s.id === id)?.name ?? id;
  const u = result.user;
  return (
    <div className="flex flex-col gap-3">
      <Badge tone={result.ok ? 'ok' : 'danger'} className="self-start">
        {result.ok ? t('identity.idp.testOk') : t('identity.idp.testFailed')}
      </Badge>
      <ol
        className="m-0 flex list-none flex-col gap-1 p-0"
        aria-label={t('identity.idp.testTitle')}
      >
        {result.steps.map((s, i) => (
          <li key={`${s.key}-${i}`} className="flex items-start gap-2 text-cap">
            <Icon
              name={s.ok ? 'check' : 'x'}
              size={16}
              className={cn('mt-px', s.ok ? 'text-success' : 'text-danger')}
              aria-label={s.ok ? t('identity.idp.stepOk') : t('identity.idp.stepFailed')}
            />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="font-semibold">
                {isStepKey(s.key) ? t(`identity.idp.steps.${s.key}`) : s.key}
              </span>
              {s.detail ? <span className="text-xs break-all text-fg2">{s.detail}</span> : null}
            </span>
            <span className="text-xs tn text-fg3">
              {t('identity.idp.ms', { ms: Math.round(s.ms) })}
            </span>
          </li>
        ))}
      </ol>
      {u ? (
        <div className="flex flex-col gap-2 rounded-lg bg-bg2 p-3">
          <div className="flex items-center gap-2">
            <Avatar name={u.name ?? u.email ?? u.dn} size="sm" />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-cap font-semibold">{u.name ?? '—'}</span>
              <span className="truncate text-xs text-fg2">
                {u.email ?? t('identity.idp.noEmail')}
              </span>
            </span>
            {u.disabled ? <Badge tone="danger">{t('identity.idp.dirDisabled')}</Badge> : null}
          </div>
          <span className="font-mono text-[11.5px] break-all text-fg2">{u.dn}</span>
          {u.uid ? <span className="font-mono text-[11.5px] text-fg3">{u.uid}</span> : null}
          <div className="flex flex-wrap gap-1">
            {u.groups.length === 0 ? (
              <span className="text-xs text-fg2">{t('identity.idp.noGroups')}</span>
            ) : (
              u.groups.map((g) => (
                <Tag key={g} title={g}>
                  {g.replace(/^CN=([^,]+),.*$/i, '$1')}
                </Tag>
              ))
            )}
          </div>
          <div className="flex flex-col gap-0.5 border-t border-line pt-2 text-xs">
            <span>
              {t('identity.idp.resultRole')}:{' '}
              <b className="font-semibold">
                {u.orgRole ? t(`common.roles.org.${u.orgRole}`) : t('identity.idp.noAccess')}
              </b>
            </span>
            {u.spaces.length ? (
              <span>
                {t('identity.idp.resultSpaces')}:{' '}
                <b className="font-semibold">
                  {u.spaces
                    .map((s) => `${spaceName(s.spaceId)} (${t(`common.roles.space.${s.role}`)})`)
                    .join(', ')}
                </b>
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function SyncPanel({ provider }: { provider: IdentityProvider }) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const sync = useMutation({
    mutationFn: () => api.call('syncIdentityProvider', { params: { providerId: provider.id } }),
    onSuccess: async () => {
      toast(t('identity.idp.synced'));
      await qc.invalidateQueries({ queryKey: identityKeys.all });
    },
    onError: (e) => toast(isApiError(e) ? t(`errors.${e.code}`) : t('errors.internal')),
  });
  const s = provider.status;
  const last = sync.data ?? s.lastSync;
  return (
    <Card title={t('identity.idp.syncTitle')}>
      <p className="m-0 text-xs text-fg2">
        {provider.syncEnabled ? t('identity.idp.syncHourly') : t('identity.idp.syncOff')}
        {s.lastSyncAt
          ? ` · ${t('identity.idp.lastSyncAt', { when: formatRelative(s.lastSyncAt, locale) })}`
          : null}
      </p>
      {s.lastSyncOk === false ? (
        <Notice tone="error">{s.lastError ?? t('identity.idp.syncFailed')}</Notice>
      ) : null}
      {last ? (
        <div className="grid grid-cols-4 gap-2 text-center">
          {(['checked', 'updated', 'suspended', 'reactivated'] as const).map((k) => (
            <div key={k} className="flex flex-col rounded-lg bg-bg2 px-2 py-2">
              <span className="text-sub font-bold tn">{last[k]}</span>
              <span className="text-[11px] text-fg2">{t(`identity.idp.sync.${k}`)}</span>
            </div>
          ))}
        </div>
      ) : null}
      <Button variant="default" loading={sync.isPending} onClick={() => sync.mutate()}>
        <Icon name="refresh" size={16} />
        {t('identity.idp.syncNow')}
      </Button>
    </Card>
  );
}

function LinkedUsers({ provider }: { provider: IdentityProvider }) {
  const { t, locale } = useI18n();
  const list = useQuery(linkedIdentitiesQuery(provider.id));
  const items = list.data?.items ?? [];
  const dirTone = { active: 'ok', disabled: 'danger', missing: 'warn' } as const;
  return (
    <Card
      title={t('identity.idp.linkedTitle')}
      aside={<span className="text-xs text-fg3">{provider.status.linkedUsers}</span>}
    >
      {list.isPending ? (
        <Skeleton className="h-24" />
      ) : items.length === 0 ? (
        <EmptyState icon="users" title={t('identity.idp.noLinked')} className="py-4" />
      ) : (
        <div className="-mx-5 overflow-x-auto">
          <Table>
            <thead>
              <tr>
                <Th>{t('identity.idp.cols.person')}</Th>
                <Th>{t('identity.idp.cols.status')}</Th>
                <Th>{t('identity.idp.cols.lastLogin')}</Th>
              </tr>
            </thead>
            <tbody>
              {items.map((u) => (
                <tr key={u.userId}>
                  <Td>
                    <Link
                      to="/admin/members/$userId"
                      params={{ userId: u.userId }}
                      className="flex items-center gap-2"
                    >
                      <Avatar name={u.name} size="sm" />
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate text-cap font-semibold">{u.name}</span>
                        <span className="truncate text-xs text-fg2" title={u.subject}>
                          {u.email}
                        </span>
                      </span>
                    </Link>
                  </Td>
                  <Td>
                    <span className="flex flex-col items-start gap-1">
                      {provider.kind === 'ldap' ? (
                        <Badge tone={dirTone[u.directoryStatus]}>
                          {t(`identity.idp.dirStatus.${u.directoryStatus}`)}
                        </Badge>
                      ) : null}
                      {u.memberStatus && u.memberStatus !== 'active' ? (
                        <Tag>{t(`identity.idp.memberStatus.${u.memberStatus}`)}</Tag>
                      ) : null}
                      {u.groups.length ? (
                        <span className="text-[11px] text-fg3">
                          {t('identity.idp.groupCount', { count: u.groups.length })}
                        </span>
                      ) : null}
                    </span>
                  </Td>
                  <Td className="text-xs whitespace-nowrap text-fg2">
                    {u.lastLoginAt
                      ? formatRelative(u.lastLoginAt, locale)
                      : t('identity.idp.never')}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      )}
    </Card>
  );
}
