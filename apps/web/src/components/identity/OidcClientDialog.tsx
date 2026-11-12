import {
  OIDC_SCOPES,
  type CreatedOidcClient,
  type OidcClient,
  type OidcClientType,
} from '@crewhall/shared';
import {
  Badge,
  Button,
  Checkbox,
  cn,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Field,
  Input,
  Segmented,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from '@crewhall/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import { Notice } from '@/components/auth/AuthLayout';
import { AppMark, CopyField, ListEditor, ToggleRow } from '@/components/identity/parts';
import { api, isApiError } from '@/lib/api';
import { formatDateLong } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import {
  clientToForm,
  emptyClientForm,
  formToCreate,
  formToUpdate,
  redirectUriProblem,
  SECRET_MONTHS,
  withOpenid,
  type ClientForm,
} from '@/lib/identity/oidcClients';
import { orgSpacesQuery } from '@/lib/queries';

/** "Uygulama ekle" / edit form for an OIDC client (9.12, 9.13). */
export function OidcClientDialog({
  open,
  onOpenChange,
  client,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Edit this client; create a new one when absent. */
  client?: OidcClient;
  onSaved: (result: { created?: CreatedOidcClient; updated?: OidcClient }) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent width={720}>
        {open ? (
          <ClientFormBody client={client} onCancel={() => onOpenChange(false)} onSaved={onSaved} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ClientFormBody({
  client,
  onCancel,
  onSaved,
}: {
  client?: OidcClient;
  onCancel: () => void;
  onSaved: (result: { created?: CreatedOidcClient; updated?: OidcClient }) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const [form, setForm] = useState<ClientForm>(() =>
    client ? clientToForm(client) : emptyClientForm(),
  );
  const spaces = useQuery(orgSpacesQuery());
  const set = <K extends keyof ClientForm>(k: K, v: ClientForm[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const save = useMutation({
    mutationFn: async () =>
      client
        ? {
            updated: await api.call('updateOidcClient', {
              params: { oidcClientId: client.id },
              body: formToUpdate(form),
            }),
          }
        : { created: await api.call('createOidcClient', { body: formToCreate(form) }) },
    onSuccess: onSaved,
  });

  const uriProblem = (type: OidcClientType) => (v: string) => {
    const p = redirectUriProblem(v, type);
    return p ? t(`identity.sso.uriProblem.${p}`) : null;
  };
  const canSave = form.name.trim().length > 0 && form.redirectUris.length > 0;
  const error = save.error
    ? isApiError(save.error)
      ? t(`errors.${save.error.code}`)
      : t('errors.internal')
    : null;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (canSave) save.mutate();
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <DialogHeader
        icon="key"
        title={
          client ? t('identity.sso.editTitle', { name: client.name }) : t('identity.sso.addTitle')
        }
        description={t('identity.sso.formHint')}
      />
      <div className="grid gap-5 md:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-3.5">
          <Field label={t('identity.sso.fields.name')}>
            <Input
              value={form.name}
              maxLength={80}
              onChange={(e) => set('name', e.target.value)}
              autoFocus
              containerClassName="h-10"
            />
          </Field>
          <Field
            label={t('identity.sso.fields.type')}
            hint={t(`identity.sso.typeHint.${form.type}`)}
          >
            <Segmented<OidcClientType>
              aria-label={t('identity.sso.fields.type')}
              value={form.type}
              onValueChange={(v) => set('type', v)}
              options={(['web', 'spa', 'native'] as const).map((v) => ({
                value: v,
                label: t(`identity.sso.types.${v}`),
                disabled: Boolean(client) && v !== form.type,
              }))}
            />
          </Field>
          <Field label={t('identity.sso.fields.homepage')}>
            <Input
              type="url"
              placeholder="https://app.example.com"
              value={form.homepageUrl}
              onChange={(e) => set('homepageUrl', e.target.value)}
              containerClassName="h-10"
            />
          </Field>
          <Field label={t('identity.sso.fields.logo')}>
            <div className="flex items-center gap-2">
              <AppMark name={form.name || '?'} logoUrl={form.logoUrl || null} size={40} />
              <Input
                type="url"
                placeholder="https://app.example.com/logo.png"
                value={form.logoUrl}
                onChange={(e) => set('logoUrl', e.target.value)}
                containerClassName="h-10 flex-1"
              />
            </div>
          </Field>
          <Field label={t('identity.sso.fields.redirectUris')}>
            <ListEditor
              values={form.redirectUris}
              onChange={(v) => set('redirectUris', v)}
              placeholder="https://app.example.com/signin-oidc"
              addLabel={t('identity.sso.addUri')}
              inputLabel={t('identity.sso.fields.redirectUris')}
              validate={uriProblem(form.type)}
            />
          </Field>
          <Field label={t('identity.sso.fields.postLogout')}>
            <ListEditor
              values={form.postLogoutRedirectUris}
              onChange={(v) => set('postLogoutRedirectUris', v)}
              placeholder="https://app.example.com/signout-callback-oidc"
              addLabel={t('identity.sso.addUri')}
              inputLabel={t('identity.sso.fields.postLogout')}
              validate={uriProblem(form.type)}
            />
          </Field>
        </div>
        <div className="flex min-w-0 flex-col gap-3.5">
          <Field label={t('identity.sso.fields.scopes')}>
            <ScopeList value={form.scopes} onChange={(v) => set('scopes', v)} />
          </Field>
          <Field label={t('identity.sso.fields.access')}>
            <Select value={form.access} onValueChange={(v) => set('access', v)}>
              <SelectTrigger className="h-10" aria-label={t('identity.sso.fields.access')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('identity.sso.accessAll')}</SelectItem>
                {(spaces.data?.items ?? []).map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {t('identity.sso.accessSpace', { name: s.name })}
                  </SelectItem>
                ))}
                {client?.access.kind === 'space' &&
                !spaces.data?.items.some((s) => s.id === form.access) ? (
                  <SelectItem value={client.access.spaceId}>
                    {t('identity.sso.accessSpace', { name: client.access.spaceName })}
                  </SelectItem>
                ) : null}
              </SelectContent>
            </Select>
          </Field>
          <div className="flex flex-col rounded-lg px-3 shadow-line2">
            <ToggleRow
              id={`${id}-guests`}
              label={t('identity.sso.fields.guests')}
              hint={t('identity.sso.fields.guestsHint')}
            >
              <Switch
                id={`${id}-guests`}
                checked={form.guestsAllowed}
                onCheckedChange={(v) => set('guestsAllowed', v)}
              />
            </ToggleRow>
            <ToggleRow
              id={`${id}-consent`}
              label={t('identity.sso.fields.skipConsent')}
              hint={t('identity.sso.fields.skipConsentHint')}
            >
              <Switch
                id={`${id}-consent`}
                checked={form.skipConsent}
                onCheckedChange={(v) => set('skipConsent', v)}
              />
            </ToggleRow>
          </div>
          {!client && form.type === 'web' ? (
            <Field label={t('identity.sso.fields.secretMonths')}>
              <Segmented
                aria-label={t('identity.sso.fields.secretMonths')}
                value={String(form.secretMonths)}
                onValueChange={(v) => set('secretMonths', Number(v))}
                options={SECRET_MONTHS.map((m) => ({
                  value: String(m),
                  label: t('identity.sso.months', { count: m }),
                }))}
              />
            </Field>
          ) : null}
        </div>
      </div>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <DialogFooter>
        <Button variant="gh" onClick={onCancel}>
          {t('common.actions.cancel')}
        </Button>
        <Button type="submit" variant="pri" loading={save.isPending} disabled={!canSave}>
          {client ? t('common.actions.save') : t('identity.sso.create')}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Scope checkboxes; `openid` is locked on (9.13). */
export function ScopeList({
  value,
  onChange,
  readOnly,
}: {
  value: ClientForm['scopes'];
  onChange?: (v: ClientForm['scopes']) => void;
  readOnly?: boolean;
}) {
  const { t } = useI18n();
  const id = useId();
  return (
    <div className="flex flex-col overflow-hidden rounded-lg shadow-line2">
      {OIDC_SCOPES.map((scope) => {
        const locked = scope === 'openid';
        const checked = locked || value.includes(scope);
        const box = `${id}-${scope}`;
        return (
          <div
            key={scope}
            className={cn(
              'flex min-h-10 items-center gap-2.5 border-b border-line px-3 py-1.5 last:border-b-0',
            )}
          >
            <Checkbox
              id={box}
              checked={checked}
              disabled={locked || readOnly}
              onCheckedChange={(c) =>
                onChange?.(withOpenid(c ? [...value, scope] : value.filter((s) => s !== scope)))
              }
            />
            <label
              htmlFor={box}
              className="min-w-0 flex-1 cursor-pointer font-mono text-[13px] font-semibold"
            >
              {scope}
            </label>
            <span className="text-tag text-fg3">
              {locked ? t('identity.sso.scopeRequired') : t(`identity.scopes.${scope}.short`)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Client secret shown once (9.13): after creation or rotation. Closing needs the explicit
 * "Kopyaladım, kapat"; the secret cannot be shown again, only rotated.
 */
export function ClientSecretDialog({
  open,
  onClose,
  client,
  secret,
  expiresAt,
  rotated,
}: {
  open: boolean;
  onClose: () => void;
  client: OidcClient | null;
  secret: string | null;
  expiresAt: string | null;
  rotated?: boolean;
}) {
  const { t, locale } = useI18n();
  if (!client) return null;
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        // A secret is on screen: only the explicit button closes the dialog.
        if (!o && !secret) onClose();
      }}
    >
      <DialogContent
        width={720}
        onEscapeKeyDown={(e) => secret && e.preventDefault()}
        onInteractOutside={(e) => secret && e.preventDefault()}
      >
        <div className="flex items-start gap-3">
          <AppMark name={client.name} logoUrl={client.logoUrl} size={40} />
          <DialogHeader
            title={client.name}
            description={t(rotated ? 'identity.sso.rotatedSub' : 'identity.sso.createdSub', {
              type: t(`identity.sso.typeLong.${client.type}`),
            })}
          />
        </div>
        {secret ? (
          <Notice tone="warn">
            <b className="font-semibold">{t('identity.sso.secretOnceTitle')}</b>{' '}
            {t('identity.sso.secretOnceBody')}
          </Notice>
        ) : (
          <Notice tone="info">{t('identity.sso.publicClient')}</Notice>
        )}
        <div className="grid gap-5 md:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-3.5">
            <Field label={t('identity.sso.fields.clientId')}>
              <CopyField value={client.clientId} label={t('identity.sso.fields.clientId')} />
            </Field>
            {secret ? (
              <Field
                label={t('identity.sso.fields.clientSecret')}
                hint={
                  expiresAt
                    ? t('identity.sso.secretValid', { date: formatDateLong(expiresAt, locale) })
                    : undefined
                }
              >
                <CopyField value={secret} secret label={t('identity.sso.fields.clientSecret')} />
              </Field>
            ) : null}
            <Field label={t('identity.sso.fields.redirectUris')}>
              <div className="flex flex-col gap-1.5">
                {client.redirectUris.map((u) => (
                  <span
                    key={u}
                    className="rounded-lg bg-bg2 px-3 py-2 font-mono text-[13px] break-all"
                  >
                    {u}
                  </span>
                ))}
              </div>
            </Field>
          </div>
          <div className="flex min-w-0 flex-col gap-3.5">
            <Field label={t('identity.sso.fields.scopes')}>
              <ScopeList value={client.scopes} readOnly />
            </Field>
            <Field label={t('identity.sso.fields.access')}>
              <span className="flex h-10 items-center gap-2 rounded-lg bg-bg2 px-3 text-cap font-semibold">
                {client.access.kind === 'all'
                  ? t('identity.sso.accessAll')
                  : t('identity.sso.accessSpace', { name: client.access.spaceName })}
              </span>
            </Field>
          </div>
        </div>
        <DialogFooter className="justify-between">
          <Badge tone="default">{t('identity.sso.audited')}</Badge>
          <Button variant="inv" onClick={onClose}>
            {secret ? t('identity.sso.copiedClose') : t('common.actions.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
