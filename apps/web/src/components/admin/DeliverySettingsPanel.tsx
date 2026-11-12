import {
  DELIVERY_LIMITS,
  type DeliverySettings,
  type DeliveryTestResult,
  type EmailDeliveryMode,
  type PushDeliveryMode,
  type SmtpSecurity,
  type StoredSecret,
  type UpdateDeliverySettings,
} from '@crewhall/shared';
import {
  Badge,
  Button,
  cn,
  Field,
  Icon,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Textarea,
  toast,
} from '@crewhall/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useRef, useState, type ReactNode } from 'react';
import { SaveBar, SettingsCard } from '@/components/admin/Settings';
import { useUnsavedGuard } from '@/components/identity/UnsavedGuard';
import { api, isApiError } from '@/lib/api';
import { formatDate, formatRelative } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';

export const deliveryKey = ['org', 'delivery'] as const;

/** A write-only secret in the form: keep the stored one, replace it, or remove it. */
interface SecretDraft {
  value: string;
  remove: boolean;
}
const keep = (): SecretDraft => ({ value: '', remove: false });

interface Draft {
  emailMode: EmailDeliveryMode;
  host: string;
  port: string;
  security: SmtpSecurity;
  username: string;
  password: SecretDraft;
  from: string;
  pushMode: PushDeliveryMode;
  serviceAccount: SecretDraft;
  expoToken: SecretDraft;
  notifikeUrl: string;
  notifikeKey: SecretDraft;
}

const draftOf = (s: DeliverySettings): Draft => ({
  emailMode: s.email.mode,
  host: s.email.smtp.host ?? '',
  port: s.email.smtp.port === null ? '' : String(s.email.smtp.port),
  security: s.email.smtp.security,
  username: s.email.smtp.username ?? '',
  password: keep(),
  from: s.email.smtp.from ?? '',
  pushMode: s.push.mode,
  serviceAccount: keep(),
  expoToken: keep(),
  notifikeUrl: s.notifike.baseUrl ?? '',
  notifikeKey: keep(),
});

const text = (v: string) => v.trim() || null;
const secret = (d: SecretDraft) => (d.value.trim() ? d.value.trim() : d.remove ? null : undefined);

/** Only what differs from the stored settings; secrets: value replaces, null removes. */
export function changesOf(s: DeliverySettings, d: Draft): UpdateDeliverySettings {
  const body: UpdateDeliverySettings = {};
  const smtp: NonNullable<NonNullable<UpdateDeliverySettings['email']>['smtp']> = {};
  if (text(d.host) !== s.email.smtp.host) smtp.host = text(d.host);
  const port = d.port.trim() ? Number(d.port) : null;
  if (port !== s.email.smtp.port) smtp.port = port;
  if (d.security !== s.email.smtp.security) smtp.security = d.security;
  if (text(d.username) !== s.email.smtp.username) smtp.username = text(d.username);
  if (text(d.from) !== s.email.smtp.from) smtp.from = text(d.from);
  const password = secret(d.password);
  if (password !== undefined) smtp.password = password;
  if (d.emailMode !== s.email.mode || Object.keys(smtp).length) {
    body.email = {
      ...(d.emailMode !== s.email.mode ? { mode: d.emailMode } : {}),
      ...(Object.keys(smtp).length ? { smtp } : {}),
    };
  }
  const account = secret(d.serviceAccount);
  const expo = secret(d.expoToken);
  if (d.pushMode !== s.push.mode || account !== undefined || expo !== undefined) {
    body.push = {
      ...(d.pushMode !== s.push.mode ? { mode: d.pushMode } : {}),
      ...(account !== undefined ? { fcmServiceAccount: account } : {}),
      ...(expo !== undefined ? { expoAccessToken: expo } : {}),
    };
  }
  const key = secret(d.notifikeKey);
  const url = text(d.notifikeUrl);
  if (url !== s.notifike.baseUrl || key !== undefined) {
    body.notifike = {
      ...(url !== s.notifike.baseUrl ? { baseUrl: url } : {}),
      ...(key !== undefined ? { apiKey: key } : {}),
    };
  }
  return body;
}

/** `email.smtp.host` → message, from a 422 `validation_failed`. */
function fieldErrorsOf(e: unknown): Record<string, { code: string; message: string }> {
  if (!isApiError(e, 'validation_failed')) return {};
  const issues = (e.details as { issues?: { path?: unknown[]; code?: string; message?: string }[] })
    ?.issues;
  const out: Record<string, { code: string; message: string }> = {};
  for (const i of issues ?? []) {
    if (!Array.isArray(i.path)) continue;
    out[i.path.join('.')] = { code: i.code ?? 'invalid', message: i.message ?? '' };
  }
  return out;
}

/**
 * Yönetim › Bildirim gönderimi: how the org's e-mail and push go out (the server's settings, the
 * org's own SMTP / Firebase, or Notifike). Fields wait for the save bar; tests use what is saved.
 */
export function DeliverySettingsPanel() {
  const settings = useQuery({
    queryKey: deliveryKey,
    queryFn: () => api.call('getDeliverySettings'),
  });
  const [draft, setDraft] = useState<Draft | null>(null);
  if (settings.data && !draft) setDraft(draftOf(settings.data));
  if (!settings.data || !draft) return <Skeleton className="h-96 rounded-2xl" />;
  return (
    <DeliveryForm
      settings={settings.data}
      draft={draft}
      setDraft={setDraft}
      onSaved={(s) => setDraft(draftOf(s))}
    />
  );
}

function DeliveryForm({
  settings,
  draft,
  setDraft,
  onSaved,
}: {
  settings: DeliverySettings;
  draft: Draft;
  setDraft: (d: Draft) => void;
  onSaved: (s: DeliverySettings) => void;
}) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const id = useId();
  const [errors, setErrors] = useState<Record<string, { code: string; message: string }>>({});
  const set = (patch: Partial<Draft>) => {
    setDraft({ ...draft, ...patch });
    setErrors({});
  };
  const changes = changesOf(settings, draft);
  const count = countChanges(changes);
  const dirty = count > 0;
  const guard = useUnsavedGuard(dirty);

  const save = useMutation({
    mutationFn: () => api.call('updateDeliverySettings', { body: changes }),
    onSuccess: (next) => {
      qc.setQueryData(deliveryKey, next);
      onSaved(next);
      setErrors({});
      toast(t('admin.delivery.saved'));
    },
    onError: (e) => {
      const fields = fieldErrorsOf(e);
      setErrors(fields);
      if (!Object.keys(fields).length) {
        toast(isApiError(e) ? t(`errors.${e.code}`) : t('errors.internal'));
      }
    },
  });

  const fieldError = (path: string) => {
    const e = errors[path];
    if (!e) return undefined;
    if (e.code === 'required') return t('admin.delivery.errors.required');
    if (e.code === 'invalid_service_account') {
      return t('admin.delivery.errors.serviceAccount', { text: e.message });
    }
    return t('admin.delivery.errors.invalid');
  };

  const notifikeOn = draft.emailMode === 'notifike' || draft.pushMode === 'notifike';

  return (
    <div className="flex max-w-[860px] flex-col gap-4 pb-20">
      {guard}
      <SettingsCard title={t('admin.delivery.email.title')}>
        <ModePicker
          label={t('admin.delivery.email.title')}
          value={draft.emailMode}
          onChange={(emailMode) => set({ emailMode })}
          options={[
            {
              value: 'env',
              title: t('admin.delivery.modes.env'),
              hint: settings.server.email
                ? t('admin.delivery.email.envOn')
                : t('admin.delivery.email.envOff'),
            },
            {
              value: 'smtp',
              title: t('admin.delivery.email.smtp'),
              hint: t('admin.delivery.email.smtpHint'),
            },
            {
              value: 'notifike',
              title: t('admin.delivery.modes.notifike'),
              hint: t('admin.delivery.email.notifikeHint'),
            },
          ]}
        />
        {draft.emailMode === 'env' && !settings.server.email ? (
          <Warning>{t('admin.delivery.email.envMissing')}</Warning>
        ) : null}
        {draft.emailMode === 'smtp' ? (
          <div className="grid gap-3 pb-3 md:grid-cols-[minmax(0,1fr)_120px_160px]">
            <Field label={t('admin.delivery.smtp.host')} error={fieldError('email.smtp.host')}>
              <Input
                value={draft.host}
                maxLength={DELIVERY_LIMITS.hostChars}
                placeholder="smtp.ornek.com"
                onChange={(e) => set({ host: e.target.value })}
              />
            </Field>
            <Field label={t('admin.delivery.smtp.port')} error={fieldError('email.smtp.port')}>
              <Input
                value={draft.port}
                inputMode="numeric"
                placeholder={draft.security === 'tls' ? '465' : '587'}
                onChange={(e) => set({ port: e.target.value.replace(/[^\d]/g, '').slice(0, 5) })}
              />
            </Field>
            <Field label={t('admin.delivery.smtp.security')}>
              <Select
                value={draft.security}
                onValueChange={(v) => {
                  const security = v as SmtpSecurity;
                  // An empty or default port follows the security choice.
                  const port =
                    !draft.port ||
                    draft.port === '465' ||
                    draft.port === '587' ||
                    draft.port === '25'
                      ? security === 'tls'
                        ? '465'
                        : security === 'starttls'
                          ? '587'
                          : '25'
                      : draft.port;
                  set({ security, port });
                }}
              >
                <SelectTrigger aria-label={t('admin.delivery.smtp.security')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(['tls', 'starttls', 'none'] as const).map((v) => (
                    <SelectItem key={v} value={v}>
                      {t(`admin.delivery.smtp.securities.${v}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            {draft.security === 'none' ? (
              <div className="md:col-span-3">
                <Warning>{t('admin.delivery.smtp.noneWarning')}</Warning>
              </div>
            ) : null}
            <Field label={t('admin.delivery.smtp.username')}>
              <Input
                value={draft.username}
                autoComplete="off"
                maxLength={DELIVERY_LIMITS.usernameChars}
                onChange={(e) => set({ username: e.target.value })}
              />
            </Field>
            <div className="md:col-span-2">
              <SecretField
                label={t('admin.delivery.smtp.password')}
                stored={settings.email.smtp.password}
                draft={draft.password}
                maxLength={DELIVERY_LIMITS.passwordChars}
                onChange={(password) => set({ password })}
              />
            </div>
            <div className="md:col-span-3">
              <Field
                label={t('admin.delivery.smtp.from')}
                hint={t('admin.delivery.smtp.fromHint')}
                error={fieldError('email.smtp.from')}
              >
                <Input
                  value={draft.from}
                  maxLength={DELIVERY_LIMITS.fromChars}
                  placeholder="Crewhall <bildirim@ornek.com>"
                  onChange={(e) => set({ from: e.target.value })}
                />
              </Field>
            </div>
          </div>
        ) : null}
        <TestRow channel="email" dirty={dirty} last={settings.email.lastTest} withRecipient />
      </SettingsCard>

      <SettingsCard title={t('admin.delivery.push.title')}>
        <ModePicker
          label={t('admin.delivery.push.title')}
          value={draft.pushMode}
          onChange={(pushMode) => set({ pushMode })}
          options={[
            {
              value: 'env',
              title: t('admin.delivery.modes.env'),
              hint: settings.server.fcm
                ? t('admin.delivery.push.envOn')
                : t('admin.delivery.push.envOff'),
            },
            {
              value: 'direct',
              title: t('admin.delivery.push.direct'),
              hint: t('admin.delivery.push.directHint'),
            },
            {
              value: 'notifike',
              title: t('admin.delivery.modes.notifike'),
              hint: t('admin.delivery.push.notifikeHint'),
            },
          ]}
        />
        {draft.pushMode === 'direct' ? (
          <div className="flex flex-col gap-3 pb-3">
            <ServiceAccountField
              stored={settings.push.direct.fcmServiceAccount}
              projectId={settings.push.direct.fcmProjectId}
              draft={draft.serviceAccount}
              error={fieldError('push.fcmServiceAccount')}
              onChange={(serviceAccount) => set({ serviceAccount })}
              inputId={`${id}-sa`}
            />
            <SecretField
              label={t('admin.delivery.push.expoToken')}
              hint={t('admin.delivery.push.expoTokenHint')}
              stored={settings.push.direct.expoAccessToken}
              draft={draft.expoToken}
              maxLength={DELIVERY_LIMITS.tokenChars}
              onChange={(expoToken) => set({ expoToken })}
            />
          </div>
        ) : null}
        <TestRow channel="push" dirty={dirty} last={settings.push.lastTest} />
      </SettingsCard>

      {notifikeOn ? (
        <SettingsCard title={t('admin.delivery.notifike.title')}>
          {settings.notifike.authFailedAt ? (
            <Warning tone="danger">
              {t('admin.delivery.notifike.authFailed', {
                date: formatDate(settings.notifike.authFailedAt, locale, {
                  day: 'numeric',
                  month: 'short',
                  hour: '2-digit',
                  minute: '2-digit',
                }),
              })}
            </Warning>
          ) : null}
          <div className="flex flex-col gap-3 pb-3">
            <Field
              label={t('admin.delivery.notifike.baseUrl')}
              hint={t('admin.delivery.notifike.baseUrlHint')}
              error={fieldError('notifike.baseUrl')}
            >
              <Input
                value={draft.notifikeUrl}
                inputMode="url"
                placeholder="https://api.notifike.com"
                onChange={(e) => set({ notifikeUrl: e.target.value })}
              />
            </Field>
            <SecretField
              label={t('admin.delivery.notifike.apiKey')}
              stored={settings.notifike.apiKey}
              draft={draft.notifikeKey}
              maxLength={DELIVERY_LIMITS.apiKeyChars}
              error={fieldError('notifike.apiKey')}
              onChange={(notifikeKey) => set({ notifikeKey })}
            />
          </div>
        </SettingsCard>
      ) : null}

      <SettingsCard title={t('admin.delivery.notes.title')}>
        <ul className="m-0 flex list-none flex-col gap-2 p-0 pb-3 text-cap text-fg2">
          {(['expo', 'sender', 'required'] as const).map((k) => (
            <li key={k} className="flex gap-2">
              <Icon name="info" size={15} className="mt-0.5 shrink-0 text-fg3" />
              <span>{t(`admin.delivery.notes.${k}`)}</span>
            </li>
          ))}
        </ul>
      </SettingsCard>

      <SaveBar
        count={count}
        saving={save.isPending}
        onCancel={() => {
          setDraft(draftOf(settings));
          setErrors({});
        }}
        onSave={() => save.mutate()}
      />
    </div>
  );
}

function countChanges(body: UpdateDeliverySettings): number {
  let n = 0;
  const walk = (o: object) => {
    for (const v of Object.values(o)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) walk(v);
      else n++;
    }
  };
  walk(body);
  return n;
}

function ModePicker<V extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: V;
  onChange: (v: V) => void;
  options: { value: V; title: string; hint: string }[];
}) {
  return (
    <div role="radiogroup" aria-label={label} className="grid gap-2 pb-3 md:grid-cols-3">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            'flex flex-col items-start gap-0.5 rounded-lg px-3.5 py-2.5 text-left',
            value === o.value ? 'bg-bg2 shadow-[inset_0_0_0_1.5px_var(--fg)]' : 'shadow-line',
          )}
        >
          <span className="text-cap font-semibold">{o.title}</span>
          <span className="text-xs text-fg2">{o.hint}</span>
        </button>
      ))}
    </div>
  );
}

function Warning({ children, tone = 'warn' }: { children: ReactNode; tone?: 'warn' | 'danger' }) {
  return (
    <div
      role="alert"
      className={cn(
        'mb-3 flex items-start gap-2 rounded-lg px-3 py-2 text-cap',
        tone === 'danger' ? 'bg-danger/10' : 'bg-warning/10',
      )}
    >
      <Icon
        name="alert"
        size={15}
        className={cn('mt-0.5 shrink-0', tone === 'danger' ? 'text-danger' : 'text-warning')}
      />
      <span>{children}</span>
    </div>
  );
}

/**
 * A stored secret is never shown: "Kayıtlı · son değiştirme …" with Değiştir and Kaldır.
 * Değiştir opens an empty field (empty again = keep); Kaldır marks it for removal on save.
 */
function SecretField({
  label,
  hint,
  stored,
  draft,
  maxLength,
  error,
  onChange,
}: {
  label: string;
  hint?: string;
  stored: StoredSecret;
  draft: SecretDraft;
  maxLength: number;
  error?: string;
  onChange: (d: SecretDraft) => void;
}) {
  const { t, locale } = useI18n();
  // Editing the value stored at that moment: a save (new updatedAt) closes the field again.
  const version = stored.updatedAt ?? '';
  const [editingFor, setEditingFor] = useState<string | null>(null);
  const editing = editingFor === version;
  const setEditing = (on: boolean) => setEditingFor(on ? version : null);
  const input = useRef<HTMLInputElement>(null);
  if (stored.set && !editing && !draft.value) {
    return (
      <Field label={label} hint={hint} error={error}>
        <div className="flex min-h-11 flex-wrap items-center gap-2 rounded-lg bg-bg2 px-3.5 py-2 text-cap">
          {draft.remove ? (
            <>
              <span className="flex-1 text-danger">{t('admin.delivery.secret.willRemove')}</span>
              <Button size="xs" variant="gh" onClick={() => onChange(keep())}>
                {t('common.actions.cancel')}
              </Button>
            </>
          ) : (
            <>
              <Icon name="lock" size={15} className="text-fg2" />
              <span className="flex-1">
                {[
                  t('admin.delivery.secret.stored'),
                  stored.hint ? `•••• ${stored.hint}` : null,
                  stored.updatedAt
                    ? t('admin.delivery.secret.changed', {
                        time: formatRelative(stored.updatedAt, locale),
                      })
                    : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
              <Button
                size="xs"
                variant="gh"
                aria-label={t('admin.delivery.secret.replaceLabel', { name: label })}
                onClick={() => {
                  setEditing(true);
                  setTimeout(() => input.current?.focus(), 0);
                }}
              >
                {t('admin.delivery.secret.replace')}
              </Button>
              <Button
                size="xs"
                variant="dng"
                aria-label={t('admin.delivery.secret.removeLabel', { name: label })}
                onClick={() => onChange({ value: '', remove: true })}
              >
                {t('admin.delivery.secret.remove')}
              </Button>
            </>
          )}
        </div>
      </Field>
    );
  }
  return (
    <Field
      label={label}
      hint={stored.set ? t('admin.delivery.secret.emptyKeeps') : hint}
      error={error}
    >
      <Input
        ref={input}
        type="password"
        autoComplete="new-password"
        value={draft.value}
        maxLength={maxLength}
        onChange={(e) => onChange({ value: e.target.value, remove: false })}
        trailing={
          stored.set ? (
            <Button
              size="xs"
              variant="gh"
              onClick={() => {
                setEditing(false);
                onChange(keep());
              }}
            >
              {t('common.actions.cancel')}
            </Button>
          ) : null
        }
      />
    </Field>
  );
}

/** The Firebase service account JSON: pasted or read from the downloaded file. */
function ServiceAccountField({
  stored,
  projectId,
  draft,
  error,
  onChange,
  inputId,
}: {
  stored: StoredSecret;
  projectId: string | null;
  draft: SecretDraft;
  error?: string;
  onChange: (d: SecretDraft) => void;
  inputId: string;
}) {
  const { t, locale } = useI18n();
  const file = useRef<HTMLInputElement>(null);
  // Without a stored account the field is open; with one, only after Değiştir until a save.
  const version = stored.updatedAt ?? '';
  const [openFor, setOpenFor] = useState<string | null>(null);
  const open = !stored.set || openFor === version;
  const setOpen = (on: boolean) => setOpenFor(on ? version : null);
  const label = t('admin.delivery.push.serviceAccount');
  return (
    <Field
      label={label}
      hint={t('admin.delivery.push.serviceAccountHint')}
      error={error}
      id={inputId}
    >
      <div className="flex flex-col gap-2">
        {stored.set ? (
          <div className="flex min-h-11 flex-wrap items-center gap-2 rounded-lg bg-bg2 px-3.5 py-2 text-cap">
            <Icon name="lock" size={15} className="text-fg2" />
            <span className="flex-1">
              {draft.remove
                ? t('admin.delivery.secret.willRemove')
                : [
                    t('admin.delivery.secret.stored'),
                    projectId ? t('admin.delivery.push.project', { name: projectId }) : null,
                    stored.updatedAt
                      ? t('admin.delivery.secret.changed', {
                          time: formatRelative(stored.updatedAt, locale),
                        })
                      : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
            </span>
            {draft.remove ? (
              <Button size="xs" variant="gh" onClick={() => onChange(keep())}>
                {t('common.actions.cancel')}
              </Button>
            ) : (
              <>
                <Button
                  size="xs"
                  variant="gh"
                  aria-label={t('admin.delivery.secret.replaceLabel', { name: label })}
                  onClick={() => setOpen(true)}
                >
                  {t('admin.delivery.secret.replace')}
                </Button>
                <Button
                  size="xs"
                  variant="dng"
                  aria-label={t('admin.delivery.secret.removeLabel', { name: label })}
                  onClick={() => {
                    setOpen(false);
                    onChange({ value: '', remove: true });
                  }}
                >
                  {t('admin.delivery.secret.remove')}
                </Button>
              </>
            )}
          </div>
        ) : null}
        {open && !draft.remove ? (
          <>
            <Textarea
              id={inputId}
              aria-label={label}
              value={draft.value}
              maxLength={DELIVERY_LIMITS.serviceAccountChars}
              placeholder={'{ "type": "service_account", "project_id": "…", … }'}
              className="min-h-[120px] font-mono text-xs"
              onChange={(e) => onChange({ value: e.target.value, remove: false })}
            />
            <div className="flex flex-wrap items-center gap-2">
              <input
                ref={file}
                type="file"
                accept="application/json,.json"
                className="sr-only"
                aria-label={t('admin.delivery.push.uploadFile')}
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (f) onChange({ value: await f.text(), remove: false });
                  e.target.value = '';
                }}
              />
              <Button size="xs" variant="out" onClick={() => file.current?.click()}>
                <Icon name="upload" size={14} />
                {t('admin.delivery.push.uploadFile')}
              </Button>
              {stored.set ? (
                <Button
                  size="xs"
                  variant="gh"
                  onClick={() => {
                    setOpen(false);
                    onChange(keep());
                  }}
                >
                  {t('common.actions.cancel')}
                </Button>
              ) : null}
            </div>
          </>
        ) : null}
      </div>
    </Field>
  );
}

/** Sends a test with the saved settings; the result (or the last one) shows below. */
function TestRow({
  channel,
  dirty,
  last,
  withRecipient,
}: {
  channel: 'email' | 'push';
  dirty: boolean;
  last: DeliveryTestResult | null;
  withRecipient?: boolean;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [to, setTo] = useState('');
  const [result, setResult] = useState<DeliveryTestResult | null>(null);
  const run = useMutation({
    mutationFn: () =>
      api.call('testDelivery', {
        body: { channel, ...(withRecipient && to.trim() ? { to: to.trim() } : {}) },
      }),
    onSuccess: async (r) => {
      setResult(r);
      await qc.invalidateQueries({ queryKey: deliveryKey });
    },
    onError: (e) => toast(isApiError(e) ? t(`errors.${e.code}`) : t('errors.internal')),
  });
  const shown = result ?? last;
  return (
    <div className="flex flex-col gap-2 border-t border-line py-3">
      <div className="flex flex-wrap items-end gap-2">
        {withRecipient ? (
          <Field
            label={t('admin.delivery.test.to')}
            hint={t('admin.delivery.test.toHint')}
            className="min-w-[220px] flex-1"
          >
            <Input
              type="email"
              value={to}
              placeholder={t('admin.delivery.test.toPlaceholder')}
              onChange={(e) => setTo(e.target.value)}
            />
          </Field>
        ) : null}
        <Button
          variant="out"
          size="sm"
          disabled={dirty}
          loading={run.isPending}
          onClick={() => run.mutate()}
        >
          <Icon name={channel === 'email' ? 'mail' : 'bell'} size={15} />
          {t(channel === 'email' ? 'admin.delivery.test.email' : 'admin.delivery.test.push')}
        </Button>
      </div>
      {dirty ? (
        <span className="text-xs text-fg2">{t('admin.delivery.test.saveFirst')}</span>
      ) : null}
      {shown ? <TestResultCard result={shown} /> : null}
    </div>
  );
}

function TestResultCard({ result }: { result: DeliveryTestResult }) {
  const { t, locale } = useI18n();
  return (
    <div
      role="status"
      aria-label={t('admin.delivery.test.result')}
      className={cn(
        'flex flex-col gap-1 rounded-lg px-3 py-2.5 text-cap',
        result.ok ? 'bg-success/10' : 'bg-danger/10',
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Icon
          name={result.ok ? 'checkC' : 'alert'}
          size={16}
          className={result.ok ? 'text-success' : 'text-danger'}
        />
        <span className="font-semibold">
          {result.ok
            ? t('admin.delivery.test.ok', { count: result.recipients })
            : t('admin.delivery.test.failed')}
        </span>
        <Badge>{t(`admin.delivery.via.${result.via}`)}</Badge>
        <span className="ml-auto text-xs text-fg2">{formatRelative(result.at, locale)}</span>
      </div>
      {result.code ? <span>{t(`errors.${result.code}` as Parameters<typeof t>[0])}</span> : null}
      {result.message ? <code className="text-xs text-fg2">{result.message}</code> : null}
    </div>
  );
}
