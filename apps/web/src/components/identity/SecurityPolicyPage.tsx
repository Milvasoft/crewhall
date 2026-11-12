import { queryKeys } from '@crewhall/api-client';
import { type IpRange, type SecurityPolicy, type SecurityPolicyView } from '@crewhall/shared';
import {
  Badge,
  Button,
  Icon,
  IconButton,
  Input,
  Segmented,
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
import { useState, type FormEvent } from 'react';
import { PageHeader, SaveBar, SettingsCard, SettingsRow } from '@/components/admin/Settings';
import { Notice } from '@/components/auth/AuthLayout';
import { useIdentityReauth } from '@/components/identity/ReauthDialog';
import { Workspace } from '@/components/shell/Workspace';
import { api, isApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n/I18nContext';
import { ipInRanges, isValidCidr } from '@/lib/identity/ip';
import { identityKeys, securityPolicyQuery } from '@/lib/identity/queries';
import { useUnsavedGuard } from './UnsavedGuard';
import {
  countPolicyChanges,
  ipMode,
  policyPatch,
  withIpMode,
  type IpMode,
} from '@/lib/identity/security';

const MIN_LENGTHS = [8, 10, 12, 14, 16, 20];
const SESSION_HOURS = [1, 4, 8, 12, 24, 72, 168, 720];
const REMEMBER_DAYS = [0, 7, 14, 30, 60, 90];

/** Yönetim › Güvenlik (design 9.11): org-wide sign-in, password and session policies. */
export function SecurityPolicyPage() {
  const { t } = useI18n();
  const view = useQuery(securityPolicyQuery);
  return (
    <Workspace
      crumbs={[{ label: t('admin.title') }, { label: t('identity.nav.security') }]}
      searchLabel={t('admin.searchSettings')}
    >
      <PageHeader title={t('identity.security.title')} subtitle={t('identity.security.subtitle')} />
      {view.data ? (
        <PolicyEditor key={view.dataUpdatedAt} view={view.data} />
      ) : view.isError ? (
        <Notice tone="error">
          {isApiError(view.error) ? t(`errors.${view.error.code}`) : t('errors.internal')}
        </Notice>
      ) : (
        <Skeleton className="h-96 w-full rounded-2xl" />
      )}
    </Workspace>
  );
}

function PolicyEditor({ view }: { view: SecurityPolicyView }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const reauth = useIdentityReauth();
  const base = view.policy;
  const [draft, setDraft] = useState<SecurityPolicy>(base);
  const [lockout, setLockout] = useState(false);
  const changes = countPolicyChanges(base, draft);

  const guard = useUnsavedGuard(changes > 0);

  const save = useMutation({
    mutationFn: () => api.call('updateSecurityPolicy', { body: policyPatch(base, draft) }),
    onSuccess: (next) => {
      setLockout(false);
      // Reseeds the editor (keyed by dataUpdatedAt) with the saved policy.
      qc.setQueryData(identityKeys.security, next);
      void qc.invalidateQueries({ queryKey: queryKeys.bootstrap });
      toast(t('ui.saved'));
    },
    onError: (e) => {
      if (reauth.handle(e, () => save.mutate())) return;
      if (isApiError(e, 'ip_allowlist_self_lockout')) setLockout(true);
      toast(isApiError(e) ? t(`errors.${e.code}`) : t('errors.internal'));
    },
  });

  const set = <S extends keyof SecurityPolicy>(section: S, patch: Partial<SecurityPolicy[S]>) =>
    setDraft((d) => ({ ...d, [section]: { ...d[section], ...patch } }));

  const status = view.status;
  const pendingNames = status.twoFactor.pending.map((p) => p.name);

  return (
    <>
      <div className="grid grid-cols-1 items-start gap-5 pb-20 xl:grid-cols-2">
        <div className="flex flex-col gap-5">
          <SettingsCard title={t('identity.security.auth')}>
            <SettingsRow
              label={t('identity.security.require2fa')}
              description={
                <>
                  {t('identity.security.enrolled', {
                    count: status.twoFactor.enrolled,
                    total: status.twoFactor.total,
                  })}
                  {pendingNames.length > 0
                    ? ` · ${t('identity.security.pendingPeople', {
                        name: pendingNames.slice(0, 3).join(', '),
                        count: pendingNames.length,
                      })}`
                    : null}
                </>
              }
            >
              <Switch
                aria-label={t('identity.security.require2fa')}
                checked={draft.twoFactor.required}
                onCheckedChange={(v) => set('twoFactor', { required: v })}
              />
            </SettingsRow>
            <SettingsRow
              label={t('identity.security.passkey')}
              description={t('identity.security.passkeyHint')}
            >
              <Switch
                aria-label={t('identity.security.passkey')}
                checked={draft.twoFactor.passkeyEnabled}
                onCheckedChange={(v) => set('twoFactor', { passkeyEnabled: v })}
              />
            </SettingsRow>
            <SettingsRow
              label={t('identity.security.rememberDevice')}
              description={t('identity.security.rememberDeviceHint')}
            >
              <Switch
                aria-label={t('identity.security.rememberDevice')}
                checked={draft.twoFactor.rememberDevice}
                onCheckedChange={(v) => set('twoFactor', { rememberDevice: v })}
              />
            </SettingsRow>
            <p className="m-0 border-t border-line py-2.5 text-xs text-fg2">
              {t('identity.security.adminsAlways')}
            </p>
          </SettingsCard>
          <SettingsCard title={t('identity.security.passwordPolicy')}>
            <SettingsRow
              label={t('identity.security.localLogin')}
              description={t('identity.security.localLoginHint')}
            >
              <Switch
                aria-label={t('identity.security.localLogin')}
                checked={draft.password.localLogin}
                onCheckedChange={(v) => set('password', { localLogin: v })}
              />
            </SettingsRow>
            <SettingsRow
              label={t('identity.security.minLength')}
              description={t('identity.security.minLengthHint')}
            >
              <NumberSelect
                label={t('identity.security.minLength')}
                value={draft.password.minLength}
                options={MIN_LENGTHS}
                format={(n) => t('identity.security.chars', { count: n })}
                onChange={(n) => set('password', { minLength: n })}
              />
            </SettingsRow>
            <SettingsRow
              label={t('identity.security.breachCheck')}
              description={t('identity.security.breachCheckHint')}
            >
              <Switch
                aria-label={t('identity.security.breachCheck')}
                checked={draft.password.breachCheck}
                onCheckedChange={(v) => set('password', { breachCheck: v })}
              />
            </SettingsRow>
          </SettingsCard>
        </div>
        <div className="flex flex-col gap-5">
          <SettingsCard title={t('identity.security.session')}>
            <SettingsRow
              label={t('identity.security.sessionHours')}
              description={t('identity.security.sessionHoursHint')}
            >
              <NumberSelect
                label={t('identity.security.sessionHours')}
                value={draft.session.hours}
                options={SESSION_HOURS}
                format={(n) =>
                  n % 24 === 0 && n >= 24
                    ? t('identity.security.days', { count: n / 24 })
                    : t('identity.security.hours', { count: n })
                }
                onChange={(n) => set('session', { hours: n })}
              />
            </SettingsRow>
            <SettingsRow
              label={t('identity.security.rememberDays')}
              description={t('identity.security.rememberDaysHint')}
            >
              <NumberSelect
                label={t('identity.security.rememberDays')}
                value={draft.session.rememberDays}
                options={REMEMBER_DAYS}
                format={(n) =>
                  n === 0 ? t('identity.security.off') : t('identity.security.days', { count: n })
                }
                onChange={(n) => set('session', { rememberDays: n })}
              />
            </SettingsRow>
            <SettingsRow
              label={t('identity.security.lockout')}
              description={t('identity.security.lockoutHint')}
            >
              <span className="text-cap font-semibold">
                {t('identity.security.lockoutValue', {
                  count: status.lockout.attempts,
                  n: status.lockout.minutes,
                })}
              </span>
              <Icon name="lock" size={14} className="text-fg3" />
            </SettingsRow>
          </SettingsCard>
          <IpAllowlistCard
            value={draft.ipAllowlist}
            currentIp={status.currentIp}
            lockout={lockout}
            onChange={(ipAllowlist) => {
              setLockout(false);
              setDraft((d) => ({ ...d, ipAllowlist }));
            }}
          />
        </div>
      </div>
      <SaveBar
        count={changes}
        saving={save.isPending}
        onCancel={() => {
          setDraft(base);
          setLockout(false);
        }}
        onSave={() => (view.status.needsReauth ? reauth.ask(() => save.mutate()) : save.mutate())}
      />
      {reauth.dialog}
      {guard}
    </>
  );
}

function IpAllowlistCard({
  value,
  currentIp,
  lockout,
  onChange,
}: {
  value: SecurityPolicy['ipAllowlist'];
  currentIp: string | null;
  lockout: boolean;
  onChange: (v: SecurityPolicy['ipAllowlist']) => void;
}) {
  const { t } = useI18n();
  const [adding, setAdding] = useState(false);
  const [cidr, setCidr] = useState('');
  const [label, setLabel] = useState('');
  const mode = ipMode(value);
  const covered = currentIp ? ipInRanges(currentIp, value.ranges) : null;
  const cidrValid = isValidCidr(cidr);
  const duplicate = value.ranges.some((r) => r.cidr === cidr.trim());

  function add(range: IpRange) {
    onChange({ ...value, ranges: [...value.ranges, range] });
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!cidrValid || duplicate) return;
    add({ cidr: cidr.trim(), label: label.trim() });
    setCidr('');
    setLabel('');
    setAdding(false);
  }

  return (
    <SettingsCard title={t('identity.security.ipTitle')}>
      <div className="flex flex-col gap-3 pb-3">
        <Segmented<IpMode>
          aria-label={t('identity.security.ipTitle')}
          value={mode}
          onValueChange={(m) => onChange(withIpMode(value, m))}
          options={[
            { value: 'off', label: t('identity.security.ipOff') },
            { value: 'admin', label: t('identity.security.ipAdmin') },
            { value: 'all', label: t('identity.security.ipAll') },
          ]}
        />
        <p className="m-0 text-xs text-fg2">{t(`identity.security.ipHint.${mode}`)}</p>
        {value.ranges.length === 0 ? (
          <p className="m-0 rounded-lg bg-bg2 px-3 py-2.5 text-xs text-fg2">
            {t('identity.security.ipEmpty')}
          </p>
        ) : (
          <ul className="m-0 flex list-none flex-col p-0">
            {value.ranges.map((r) => (
              <li
                key={r.cidr}
                className="flex min-h-11 items-center gap-3 border-t border-line first:border-t-0"
              >
                <span className="min-w-0 flex-1 font-mono text-[13px] font-semibold">{r.cidr}</span>
                <span className="truncate text-xs text-fg2">{r.label}</span>
                <IconButton
                  size="xs"
                  tone="plain"
                  aria-label={t('identity.security.ipRemove', { ip: r.cidr })}
                  onClick={() =>
                    onChange({ ...value, ranges: value.ranges.filter((x) => x.cidr !== r.cidr) })
                  }
                >
                  <Icon name="x" size={15} />
                </IconButton>
              </li>
            ))}
          </ul>
        )}
        {adding ? (
          <form onSubmit={submit} className="flex flex-wrap items-center gap-2">
            <Input
              aria-label={t('identity.security.ipCidr')}
              placeholder="203.0.113.0/24"
              value={cidr}
              onChange={(e) => setCidr(e.target.value)}
              invalid={cidr.length > 0 && !cidrValid}
              className="font-mono"
              containerClassName="h-9 w-[180px] rounded-md"
              autoFocus
            />
            <Input
              aria-label={t('identity.security.ipLabel')}
              placeholder={t('identity.security.ipLabelHint')}
              value={label}
              maxLength={80}
              onChange={(e) => setLabel(e.target.value)}
              containerClassName="h-9 min-w-[140px] flex-1 rounded-md"
            />
            <Button type="submit" size="sm" variant="inv" disabled={!cidrValid || duplicate}>
              {t('identity.common.add')}
            </Button>
            <Button size="sm" variant="gh" onClick={() => setAdding(false)}>
              {t('common.actions.cancel')}
            </Button>
          </form>
        ) : null}
        {lockout ? <Notice tone="error">{t('errors.ip_allowlist_self_lockout')}</Notice> : null}
        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
          {currentIp ? (
            <>
              <Badge tone={covered ? 'ok' : 'warn'}>
                {covered ? t('identity.security.ipCovered') : t('identity.security.ipNotCovered')}
              </Badge>
              <span className="font-mono text-xs text-fg2">{currentIp}</span>
              {!covered ? (
                <Button
                  size="xs"
                  variant="out"
                  onClick={() =>
                    add({
                      cidr: currentIp,
                      label: t('identity.security.ipMine'),
                    })
                  }
                >
                  {t('identity.security.ipAddMine')}
                </Button>
              ) : null}
            </>
          ) : (
            <span className="text-xs text-fg2">{t('identity.security.ipUnknown')}</span>
          )}
          {!adding ? (
            <Button size="xs" variant="gh" className="ml-auto" onClick={() => setAdding(true)}>
              <Icon name="plus" size={14} />
              {t('identity.security.ipAdd')}
            </Button>
          ) : null}
        </div>
      </div>
    </SettingsCard>
  );
}

function NumberSelect({
  label,
  value,
  options,
  format,
  onChange,
}: {
  label: string;
  value: number;
  options: number[];
  format: (n: number) => string;
  onChange: (n: number) => void;
}) {
  const all = [...new Set([...options, value])].sort((a, b) => a - b);
  return (
    <Select value={String(value)} onValueChange={(v) => onChange(Number(v))}>
      <SelectTrigger className="h-9 w-auto min-w-[120px]" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {all.map((n) => (
          <SelectItem key={n} value={String(n)}>
            {format(n)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
