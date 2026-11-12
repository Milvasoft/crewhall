import { encryptBitwardenExport, toBitwardenJson } from '@crewhall/crypto';
import { type UpdateVaultPolicy, type VaultKeyStatus, type VaultPolicy } from '@crewhall/shared';
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Field,
  Icon,
  IconButton,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Tooltip,
} from '@crewhall/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState, type ReactNode } from 'react';
import { Workspace } from '@/components/shell/Workspace';
import { api } from '@/lib/api';
import { formatDate, formatDateLong } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useMe } from '@/lib/session';
import {
  changeVaultPassword,
  keyStatusQuery,
  passwordProof,
  policyQuery,
  regenerateRecoveryKey,
  saveSettings,
  vaultKeys,
  vaultsQuery,
} from '@/lib/vault/api';
import { copySecret } from '@/lib/vault/clipboard';
import { payloadOf, useItemsOf } from '@/lib/vault/items';
import { addPasskeyUnlock, passkeySupported } from '@/lib/vault/passkey';
import { useVaultSession } from '@/lib/vault/session';
import {
  AUTO_LOCK_CHOICES,
  CLIPBOARD_CHOICES,
  HIDDEN_LOCK_CHOICES,
  type VaultSettings,
} from '@/lib/vault/settings';
import { desktopHas } from '@/lib/desktop';
import { HelloSettingsRow, useThisDeviceUnlockId } from './DeviceUnlock';
import { errorMessage } from './errors';
import { StrengthBar, useStrengthModule } from './strength';
import { useHealthCount } from './VaultMain';
import { vaultName, VaultSidebar } from './VaultSidebar';

/** Select value of a hidden-lock wait: minutes, or "off". */
const hiddenValue = (m: number | null) => (m === null ? 'off' : String(m));

/** Placeholder while the key status loads (hooks run before the early return). */
const EMPTY_STATUS = {
  keyVersion: 0,
  passwordChangedAt: null,
  unlockMethods: [],
} as unknown as VaultKeyStatus;

/** Vault settings (design 8.16): per account, stored encrypted. */
export function SettingsPage() {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const { unlocked } = useVaultSession();
  const status = useQuery(keyStatusQuery);
  const vaults = useQuery(vaultsQuery);
  const list = useMemo(() => vaults.data ?? [], [vaults.data]);
  const healthCount = useHealthCount(list);
  const [dialog, setDialog] = useState<'password' | 'recovery' | 'passkey' | 'export' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const proof = useProof();
  const thisDevice = useThisDeviceUnlockId(unlocked?.userId, status.data ?? EMPTY_STATUS);
  const s = unlocked?.settings;
  if (!s || !status.data) return null;
  const kdf = status.data.kdf;

  const update = (patch: Partial<VaultSettings>) => {
    setError(null);
    void saveSettings({ ...s, ...patch }).catch((e: unknown) => setError(errorMessage(e, t)));
  };

  return (
    <Workspace
      sidebar={<VaultSidebar vaults={list} healthCount={healthCount} />}
      crumbs={[{ label: t('vault.title') }, { label: t('vault.settings.title') }]}
    >
      <div className="mx-auto flex w-full max-w-[760px] flex-col gap-6">
        <div>
          <h1 className="text-h font-semibold">{t('vault.settings.heading')}</h1>
          <p className="text-sm text-fg2">{t('vault.settings.body')}</p>
        </div>
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}

        <Section title={t('vault.settings.autoLock')}>
          <Row title={t('vault.settings.idle')} hint={t('vault.settings.idleHint')}>
            <Select
              value={String(s.autoLockMinutes)}
              onValueChange={(v) => update({ autoLockMinutes: Number(v) })}
            >
              <SelectTrigger className="w-[150px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AUTO_LOCK_CHOICES.map((m) => (
                  <SelectItem key={m} value={String(m)}>
                    {t('vault.settings.minutes', { count: m })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Row>
          <Row
            title={t('vault.settings.hidden')}
            hint={
              desktopHas('systemLock')
                ? t('vault.settings.hiddenDesktopHint')
                : t('vault.settings.hiddenHint')
            }
          >
            <Select
              value={hiddenValue(s.hiddenLockMinutes)}
              onValueChange={(v) => {
                const minutes = v === 'off' ? null : Number(v);
                update({ hiddenLockMinutes: minutes, lockOnHidden: minutes !== null });
              }}
            >
              <SelectTrigger className="w-[150px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {HIDDEN_LOCK_CHOICES.map((m) => (
                  <SelectItem key={hiddenValue(m)} value={hiddenValue(m)}>
                    {m === null
                      ? t('vault.settings.hiddenOff')
                      : m === 0
                        ? t('vault.settings.hiddenNow')
                        : t('vault.settings.minutes', { count: m })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Row>
          <Row title={t('vault.settings.close')} hint={t('vault.settings.closeHint')}>
            <Switch checked disabled />
          </Row>
        </Section>

        <Section title={t('vault.settings.clipboard')}>
          <Row title={t('vault.settings.clipboardClear')} hint={t('vault.settings.clipboardHint')}>
            <Select
              value={String(s.clipboardSeconds)}
              onValueChange={(v) => update({ clipboardSeconds: Number(v) })}
            >
              <SelectTrigger className="w-[150px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CLIPBOARD_CHOICES.map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    {t('vault.settings.seconds', { count: n })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Row>
          <Row title={t('vault.settings.reveal')} hint={t('vault.settings.revealHint')}>
            <Select
              value={String(s.revealSeconds)}
              onValueChange={(v) => update({ revealSeconds: Number(v) })}
            >
              <SelectTrigger className="w-[150px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CLIPBOARD_CHOICES.map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    {t('vault.settings.seconds', { count: n })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Row>
        </Section>

        <Section title={t('vault.settings.unlock')}>
          <Row
            title={t('vault.settings.password')}
            hint={
              status.data.passwordChangedAt
                ? t('vault.settings.changedAt', {
                    date: formatDateLong(status.data.passwordChangedAt, locale),
                  })
                : undefined
            }
          >
            <Button size="sm" variant="out" onClick={() => setDialog('password')}>
              {t('vault.settings.change')}
            </Button>
          </Row>
          <Row
            title={t('vault.settings.passkeys', {
              count: status.data.unlockMethods.filter((m) => m.method === 'passkey_prf').length,
            })}
            hint={
              passkeySupported() ? t('vault.settings.passkeysHint') : t('vault.passkey.unsupported')
            }
          >
            <Button
              size="sm"
              variant="out"
              disabled={!passkeySupported()}
              onClick={() => setDialog('passkey')}
            >
              <Icon name="plus" size={14} />
              {t('vault.settings.add')}
            </Button>
          </Row>
          <HelloSettingsRow
            status={status.data}
            proof={proof}
            render={({ title, hint, control, extra }) => (
              <>
                <Row title={title} hint={hint}>
                  {control}
                </Row>
                {extra}
              </>
            )}
          />
          {status.data.unlockMethods.map((m) => (
            <div key={m.id} className="flex items-center gap-3 py-2 pl-4 text-sm">
              <Icon
                name={m.method === 'device' ? 'phone' : 'finger'}
                size={16}
                className="text-fg2"
              />
              <span className="flex-1">
                {m.label}
                <span className="text-fg3">
                  {' '}
                  ·{' '}
                  {m.lastUsedAt
                    ? t('vault.settings.lastUsed', { date: formatDate(m.lastUsedAt, locale) })
                    : t('vault.settings.neverUsed')}
                </span>
              </span>
              {m.method === 'device' ? (
                <span className="text-xs text-fg3">
                  {m.id === thisDevice.data
                    ? t('vault.hello.thisComputer')
                    : t('vault.settings.fromMobile')}
                </span>
              ) : null}
              <Tooltip content={t('vault.settings.remove')}>
                <IconButton
                  aria-label={`${t('vault.settings.remove')}: ${m.label}`}
                  tone="plain"
                  size="xs"
                  onClick={() =>
                    void api
                      .call('vaultRemoveUnlockMethod', { params: { unlockId: m.id } })
                      .then(() => qc.invalidateQueries({ queryKey: vaultKeys.status }))
                      .catch((e: unknown) => setError(errorMessage(e, t)))
                  }
                >
                  <Icon name="x" size={14} />
                </IconButton>
              </Tooltip>
            </div>
          ))}
        </Section>

        <Section title={t('vault.settings.recovery')}>
          <Row
            title={t('vault.settings.recoveryKey')}
            hint={
              status.data.recoveryCreatedAt
                ? t('vault.settings.recoveryAt', {
                    date: formatDateLong(status.data.recoveryCreatedAt, locale),
                  })
                : undefined
            }
          >
            <Button size="sm" variant="out" onClick={() => setDialog('recovery')}>
              {t('vault.settings.newRecovery')}
            </Button>
          </Row>
          <Row
            title={t('vault.settings.kdf')}
            hint={
              kdf
                ? t('vault.settings.kdfValue', { m: Math.round(kdf.m / 1024), t: kdf.t, p: kdf.p })
                : undefined
            }
          >
            <span className="text-xs text-fg3">{t('vault.settings.kdfHint')}</span>
          </Row>
          <Row title={t('vault.settings.export')} hint={t('vault.settings.exportHint')}>
            <Button size="sm" variant="out" onClick={() => setDialog('export')}>
              {t('vault.settings.exportButton')}
            </Button>
          </Row>
        </Section>
        <OrgPolicySection />
      </div>
      {dialog === 'password' ? <PasswordDialog onClose={() => setDialog(null)} /> : null}
      {dialog === 'recovery' ? <RecoveryDialog onClose={() => setDialog(null)} /> : null}
      {dialog === 'passkey' ? <PasskeyDialog onClose={() => setDialog(null)} /> : null}
      {dialog === 'export' ? <ExportDialog onClose={() => setDialog(null)} /> : null}
    </Workspace>
  );
}

const SHARE_HOURS = [1, 24, 24 * 7, 24 * 30] as const;
const SHARE_VIEWS = [1, 3, 5, 10, 20] as const;

/**
 * Org vault policy (roadmap 20), for org admins only (server: can(actor, 'org.update_settings')):
 * the leaked password check and its range API mirror, share links and their limits.
 */
function OrgPolicySection() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const policy = useQuery(policyQuery);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const p = policy.data;
  if (!p?.canEdit) return null;
  const save = (patch: UpdateVaultPolicy) => {
    setError(null);
    void api
      .call('vaultUpdatePolicy', { body: patch })
      .then((next: VaultPolicy) => {
        qc.setQueryData(vaultKeys.policy, next);
        setUrl(null);
      })
      .catch((e: unknown) => setError(errorMessage(e, t)));
  };
  const urlValue = url ?? p.breachRangeUrl ?? '';
  const hourLabel = (h: number) =>
    h < 24 ? t('vault.share.hours', { n: h }) : t('vault.share.days', { n: h / 24 });
  return (
    <Section title={t('vault.policy.title')}>
      <p className="py-3 text-xs text-fg2">{t('vault.policy.body')}</p>
      <Row title={t('vault.policy.breach')} hint={t('vault.policy.breachHint')}>
        <Switch
          aria-label={t('vault.policy.breach')}
          checked={p.breachCheck}
          onCheckedChange={(v) => save({ breachCheck: v })}
        />
      </Row>
      {p.breachCheck ? (
        <div className="flex flex-col gap-2 py-3">
          <Field label={t('vault.policy.mirror')} hint={t('vault.policy.mirrorHint')}>
            <div className="flex items-center gap-2">
              <Input
                type="url"
                placeholder="https://api.pwnedpasswords.com"
                value={urlValue}
                onChange={(e) => setUrl(e.target.value)}
              />
              <Button
                size="sm"
                variant="out"
                disabled={url === null || url === (p.breachRangeUrl ?? '')}
                onClick={() => save({ breachRangeUrl: urlValue.trim() || null })}
              >
                {t('vault.save')}
              </Button>
            </div>
          </Field>
        </div>
      ) : null}
      <Row title={t('vault.policy.shareLinks')} hint={t('vault.policy.shareLinksHint')}>
        <Switch
          aria-label={t('vault.policy.shareLinks')}
          checked={p.shareLinks}
          onCheckedChange={(v) => save({ shareLinks: v })}
        />
      </Row>
      {p.shareLinks ? (
        <>
          <Row title={t('vault.policy.maxHours')}>
            <Select
              value={String(p.shareMaxHours)}
              onValueChange={(v) => save({ shareMaxHours: Number(v) })}
            >
              <SelectTrigger className="w-[150px]" aria-label={t('vault.policy.maxHours')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SHARE_HOURS.map((h) => (
                  <SelectItem key={h} value={String(h)}>
                    {hourLabel(h)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Row>
          <Row title={t('vault.policy.maxViews')}>
            <Select
              value={String(p.shareMaxViews)}
              onValueChange={(v) => save({ shareMaxViews: Number(v) })}
            >
              <SelectTrigger className="w-[150px]" aria-label={t('vault.policy.maxViews')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SHARE_VIEWS.map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    {String(n)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Row>
        </>
      ) : null}
      {error ? (
        <p role="alert" className="py-3 text-sm text-danger">
          {error}
        </p>
      ) : null}
    </Section>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col divide-y divide-line rounded-4xl bg-surface px-5 py-2 shadow-line">
      <span className="eyebrow py-3">{title}</span>
      {children}
    </section>
  );
}

function Row({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-4 py-3">
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-sm font-semibold">{title}</span>
        {hint ? <span className="text-xs text-fg2">{hint}</span> : null}
      </div>
      {children}
    </div>
  );
}

/** Proof of the current password for key changes; reuses this unlock's when there is one. */
function useProof() {
  const { unlocked } = useVaultSession();
  const [password, setPassword] = useState('');
  const needed = !unlocked?.verifier;
  const field = needed ? (
    <PasswordField label="vault.settings.currentPassword" value={password} onChange={setPassword} />
  ) : null;
  const get = async () => unlocked?.verifier ?? (await passwordProof(password));
  return { field, get, ready: !needed || password.length > 0 };
}

function PasswordField({
  label,
  value,
  onChange,
}: {
  label:
    | 'vault.settings.currentPassword'
    | 'vault.setup.password'
    | 'vault.setup.again'
    | 'vault.settings.exportPassword';
  value: string;
  onChange: (v: string) => void;
}) {
  const { t } = useI18n();
  return (
    <Field label={t(label)}>
      <Input
        type="password"
        autoComplete="off"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  );
}

function PasswordDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const me = useMe();
  const qc = useQueryClient();
  const strength = useStrengthModule();
  const proof = useProof();
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputs = [me?.user.email ?? '', me?.user.name ?? ''];
  const ok =
    Boolean(strength?.vaultPasswordChecks(password, inputs).ok) &&
    password === again &&
    proof.ready;
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await changeVaultPassword({ method: 'password', verifier: await proof.get() }, password);
      void qc.invalidateQueries({ queryKey: vaultKeys.status });
      onClose();
    } catch (e) {
      setError(errorMessage(e, t));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent width={460}>
        <DialogHeader
          icon="key"
          title={t('vault.settings.changePassword')}
          description={t('vault.settings.changePasswordBody')}
        />
        {proof.field}
        <PasswordField label="vault.setup.password" value={password} onChange={setPassword} />
        <StrengthBar password={password} inputs={inputs} />
        <PasswordField label="vault.setup.again" value={again} onChange={setAgain} />
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="gh" onClick={onClose}>
            {t('vault.cancel')}
          </Button>
          <Button variant="pri" loading={busy} disabled={!ok} onClick={() => void submit()}>
            {t('vault.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RecoveryDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const proof = useProof();
  const [key, setKey] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      setKey(await regenerateRecoveryKey(await proof.get()));
      void qc.invalidateQueries({ queryKey: vaultKeys.status });
    } catch (e) {
      setError(errorMessage(e, t));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(v) => !v && (!key || saved) && onClose()}>
      <DialogContent width={500}>
        <DialogHeader
          icon="shield"
          title={t('vault.settings.newRecovery')}
          description={key ? t('vault.recovery.body') : t('vault.settings.newRecoveryBody')}
        />
        {key ? (
          <>
            <div className="grid grid-cols-4 gap-2 rounded-xl bg-bg2 p-4 font-mono text-[16px] font-semibold tracking-wider">
              {key.split(' ').map((g, i) => (
                <span key={i} className="text-center">
                  {g}
                </span>
              ))}
            </div>
            <Button
              size="sm"
              variant="out"
              className="self-start"
              onClick={() =>
                void copySecret(key, t('vault.recovery.keyLabel'), 30).catch(() => undefined)
              }
            >
              <Icon name="copy" size={15} />
              {t('vault.copy')}
            </Button>
            <label className="flex items-center gap-2.5 text-sm">
              <Checkbox checked={saved} onCheckedChange={(v) => setSaved(v === true)} />
              {t('vault.recovery.saved')}
            </label>
          </>
        ) : (
          proof.field
        )}
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          {key ? (
            <Button variant="pri" disabled={!saved} onClick={onClose}>
              {t('vault.done')}
            </Button>
          ) : (
            <>
              <Button variant="gh" onClick={onClose}>
                {t('vault.cancel')}
              </Button>
              <Button
                variant="pri"
                loading={busy}
                disabled={!proof.ready}
                onClick={() => void create()}
              >
                {t('vault.settings.createRecovery')}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PasskeyDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const proof = useProof();
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      await addPasskeyUnlock(label.trim(), await proof.get());
      void qc.invalidateQueries({ queryKey: vaultKeys.status });
      onClose();
    } catch (e) {
      if (e instanceof Error && e.message === 'prf_unsupported') {
        setError(t('vault.passkey.unsupported'));
      } else if (e instanceof DOMException) setError(t('vault.passkey.cancelled'));
      else setError(errorMessage(e, t));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent width={460}>
        <DialogHeader
          icon="finger"
          title={t('vault.passkey.addTitle')}
          description={t('vault.passkey.addBody')}
        />
        {proof.field}
        <Field label={t('vault.passkey.label')}>
          <Input
            value={label}
            maxLength={100}
            placeholder={t('vault.passkey.labelPlaceholder')}
            onChange={(e) => setLabel(e.target.value)}
          />
        </Field>
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="gh" onClick={onClose}>
            {t('vault.cancel')}
          </Button>
          <Button
            variant="pri"
            loading={busy}
            disabled={!label.trim() || !proof.ready}
            onClick={() => void add()}
          >
            {t('vault.settings.add')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Password-protected, Bitwarden-compatible export of everything I can read (design 8.16). */
function ExportDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const vaults = useQuery(vaultsQuery);
  const list = useMemo(() => vaults.data ?? [], [vaults.data]);
  const { items, loading } = useItemsOf(list);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const live = items.filter((d) => d.summary && !d.item.deletedAt);
  const run = async () => {
    setBusy(true);
    try {
      // Export is a one-off: whole payloads are decrypted here, item by item.
      const json = toBitwardenJson(
        live.flatMap((d) => {
          const payload = payloadOf(d);
          return payload ? [{ payload, folder: vaultName(d.vault, t) }] : [];
        }),
      );
      const out = await encryptBitwardenExport(json, password);
      const url = URL.createObjectURL(new Blob([out], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `crewhall-vault-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      onClose();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent width={460}>
        <DialogHeader
          icon="download"
          title={t('vault.settings.export')}
          description={t('vault.settings.exportBody', { count: live.length })}
        />
        <PasswordField
          label="vault.settings.exportPassword"
          value={password}
          onChange={setPassword}
        />
        <DialogFooter>
          <Button variant="gh" onClick={onClose}>
            {t('vault.cancel')}
          </Button>
          <Button
            variant="pri"
            loading={busy || loading}
            disabled={password.length < 12}
            onClick={() => void run()}
          >
            {t('vault.settings.exportButton')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
