import {
  type OfficeServerType,
  type OfficeSettings,
  type OfficeTestResult,
  type UpdateOfficeSettings,
} from '@crewhall/shared';
import { Badge, Button, Field, Input, Segmented, Switch, toast } from '@crewhall/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { errorKey } from '@/lib/errors';
import { formatRelative } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useModuleEnabled } from '@/lib/identity/modules';
import { officeKeys } from '@/lib/office/queries';

/**
 * Yönetim › Entegrasyonlar › Office: the document server (any WOPI server, e.g. Collabora
 * Online) Drive opens Word, Excel and PowerPoint files with. Off unless switched on here.
 */
export function OfficeSettingsCard() {
  const on = useModuleEnabled('office');
  const { data: s } = useQuery({
    queryKey: officeKeys.settings,
    queryFn: () => api.call('getOfficeSettings'),
    enabled: on,
  });
  if (!on || !s) return null;
  // Fresh form fields whenever the stored settings change.
  return <SettingsBody key={s.updatedAt ?? 'new'} s={s} />;
}

function SettingsBody({ s }: { s: OfficeSettings }) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const [serverUrl, setServerUrl] = useState(s.serverUrl ?? '');
  const [internalUrl, setInternalUrl] = useState(s.internalUrl ?? '');
  const [serverType, setServerType] = useState<OfficeServerType>(s.serverType);
  const [jwtSecret, setJwtSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<OfficeTestResult | null>(null);
  const result = test ?? s.lastTest;

  const save = async (body: UpdateOfficeSettings) => {
    setBusy(true);
    try {
      qc.setQueryData(officeKeys.settings, await api.call('updateOfficeSettings', { body }));
      void qc.invalidateQueries({ queryKey: officeKeys.capabilities });
      toast(t('office.admin.saved'));
    } catch (e) {
      toast.error(t(errorKey(e)));
    } finally {
      setBusy(false);
    }
  };

  const runTest = async () => {
    setBusy(true);
    try {
      setTest(await api.call('testOfficeSettings'));
      void qc.invalidateQueries({ queryKey: officeKeys.capabilities });
    } catch (e) {
      toast.error(t(errorKey(e)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      aria-label={t('office.admin.title')}
      className="flex flex-col gap-3 rounded-2xl bg-surface p-4 shadow-line"
    >
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-bg2 text-[13px] font-black">
          DOC
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <h2 className="m-0 text-sub font-semibold">{t('office.admin.title')}</h2>
          <span className="text-xs text-fg2">{t('office.admin.hint')}</span>
        </div>
        <Badge tone={s.enabled && result?.ok ? 'ok' : 'default'}>
          {t(s.enabled && result?.ok ? 'office.admin.active' : 'office.admin.inactive')}
        </Badge>
      </div>
      <label className="flex items-center gap-2 text-cap font-semibold">
        <Switch
          checked={s.enabled}
          disabled={busy || (!s.serverUrl && !s.enabled)}
          aria-label={t('office.admin.enabled')}
          onCheckedChange={(v) => void save({ enabled: v })}
        />
        {t('office.admin.enabled')}
      </label>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void save({
            serverType,
            serverUrl: serverUrl.trim() || null,
            internalUrl: internalUrl.trim() || null,
            ...(jwtSecret.trim() ? { jwtSecret: jwtSecret.trim() } : {}),
          }).then(() => setJwtSecret(''));
        }}
      >
        <Field label={t('office.admin.serverType')}>
          <Segmented
            aria-label={t('office.admin.serverType')}
            value={serverType}
            onValueChange={setServerType}
            options={[
              { value: 'onlyoffice', label: t('office.admin.types.onlyoffice') },
              { value: 'wopi', label: t('office.admin.types.wopi') },
            ]}
          />
        </Field>
        <Field label={t('office.admin.serverUrl')} hint={t('office.admin.serverUrlHint')}>
          <Input
            type="url"
            value={serverUrl}
            placeholder="https://office.example.com"
            onChange={(e) => setServerUrl(e.target.value)}
          />
        </Field>
        <Field label={t('office.admin.internalUrl')} hint={t('office.admin.internalUrlHint')}>
          <Input
            type="url"
            value={internalUrl}
            placeholder="http://office"
            onChange={(e) => setInternalUrl(e.target.value)}
          />
        </Field>
        {serverType === 'onlyoffice' ? (
          <Field
            label={t('office.admin.jwtSecret')}
            hint={
              s.jwtSecret.set
                ? t('office.admin.jwtSecretSet', { hint: s.jwtSecret.hint ?? '' })
                : t('office.admin.jwtSecretHint')
            }
          >
            <Input
              type="password"
              autoComplete="off"
              value={jwtSecret}
              placeholder={s.jwtSecret.set ? '••••••••' : ''}
              onChange={(e) => setJwtSecret(e.target.value)}
            />
          </Field>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" variant="out" disabled={busy}>
            {t('office.admin.save')}
          </Button>
          <Button
            type="button"
            variant="gh"
            disabled={busy || !s.serverUrl}
            onClick={() => void runTest()}
          >
            {t('office.admin.test')}
          </Button>
        </div>
      </form>
      {result ? (
        <p className={result.ok ? 'm-0 text-cap text-success' : 'm-0 text-cap text-danger'}>
          {result.ok
            ? t('office.admin.testOk', {
                types: result.edit.join(', ') || t('office.admin.none'),
              })
            : t('office.admin.testFail', { error: result.error ?? '' })}{' '}
          <span className="text-fg3">
            {t('office.admin.lastTest', { when: formatRelative(result.checkedAt, locale) })}
          </span>
        </p>
      ) : null}
    </section>
  );
}
