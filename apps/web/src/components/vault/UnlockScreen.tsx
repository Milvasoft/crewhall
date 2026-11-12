import { isRecoveryKeyComplete } from '@crewhall/crypto';
import { type VaultKeyStatus } from '@crewhall/shared';
import { Avatar, Button, Field, Icon, IconButton, Input, Textarea } from '@crewhall/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Workspace } from '@/components/shell/Workspace';
import { isApiError } from '@/lib/api';
import { formatTime } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useMe } from '@/lib/session';
import { useNow } from '@/lib/useNow';
import {
  changeVaultPassword,
  unlockWithPassword,
  unlockWithRecovery,
  unlockWithSecret,
  vaultKeys,
} from '@/lib/vault/api';
import { deviceLockName, passwordUnlocked, unlockWithDevice } from '@/lib/vault/desktop-device';
import { passkeySupported, passkeyUnlock } from '@/lib/vault/passkey';
import { useVaultSession } from '@/lib/vault/session';
import { HELLO_DAYS, useDeviceState } from './DeviceUnlock';
import { errorMessage } from './errors';
import { StrengthBar, useStrengthModule } from './strength';

/**
 * Lock screen (design 8.3). The wait after 5 wrong tries is enforced by the server; the screen
 * only shows it. Passkey unlock uses WebAuthn PRF; "Kurtarma anahtarıyla aç" leads to a new
 * vault password (doc 17 §7 "Kasa şifresi unutulursa").
 */
/** A lock this recent happened while the person was here: it is not a request to open. */
const JUST_LOCKED_MS = 5000;

/**
 * Whether Windows Hello may open by itself: the page is visible and focused, and the vault did not
 * just lock (`lockedAt` this session).
 */
export function helloMayStart(lockedAt: number | null, now = Date.now()): boolean {
  if (typeof document === 'undefined') return false;
  if (document.visibilityState !== 'visible' || !document.hasFocus()) return false;
  return lockedAt === null || now - lockedAt >= JUST_LOCKED_MS;
}

export function UnlockScreen({ status }: { status: VaultKeyStatus }) {
  const { t, locale } = useI18n();
  const me = useMe();
  const qc = useQueryClient();
  const { lockedAt, lockReason } = useVaultSession();
  const [mode, setMode] = useState<'password' | 'recovery'>('password');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lockedUntil, setLockedUntil] = useState<number | null>(
    status.lockedUntil ? Date.parse(status.lockedUntil) : null,
  );
  const now = useNow(lockedUntil ? 1000 : undefined);
  const wait = lockedUntil ? Math.max(0, Math.ceil((lockedUntil - now) / 1000)) : 0;
  const input = useRef<HTMLInputElement>(null);
  const passkeys = status.unlockMethods.filter((m) => m.method === 'passkey_prf');
  // Desktop app: Windows Hello (Touch ID) first, the master password below it.
  const device = useDeviceState(me?.user.id, status);
  const lockName = deviceLockName();
  const [usePassword, setUsePassword] = useState(false);
  const [deviceNote, setDeviceNote] = useState<string | null>(null);
  const helloFirst = device.data === 'ready' && !usePassword;
  const started = useRef(false);

  const withHello = async () => {
    if (!me) return;
    setBusy(true);
    setDeviceNote(null);
    try {
      if (!(await unlockWithDevice(me.user.id))) {
        setDeviceNote(t('vault.hello.gone', { name: lockName }));
        setUsePassword(true);
        void qc.invalidateQueries({ queryKey: ['vault', 'device'] });
      }
    } catch (e) {
      if (e instanceof DOMException) setDeviceNote(t('vault.hello.cancelled', { name: lockName }));
      else {
        setDeviceNote(t('vault.hello.failed', { name: lockName }));
        setUsePassword(true);
      }
    } finally {
      setBusy(false);
    }
  };

  // Did the person come to a locked vault (then Hello opens by itself), or did the vault just
  // lock under them (by hand, idle, hidden, Windows lock)? Decided once, when this screen opens.
  const [cameToOpen] = useState(() => helloMayStart(lockedAt));

  // Hello opens by itself only on that arrival, with the vault on screen and the window in
  // focus; never later on focus, never after a lock (sonraki-isler: "alakasız yerlerde Hello").
  useEffect(() => {
    if (device.data !== 'ready' || started.current || !cameToOpen) return;
    started.current = true;
    if (!helloMayStart(null)) return;
    // After this render: the prompt is a reaction to arriving, not part of drawing the screen.
    queueMicrotask(() => void withHello());
    // withHello reads the latest state; start only on the first ready.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device.data]);

  const fail = (e: unknown) => {
    if (isApiError(e, 'vault_unlock_locked')) {
      const retry = (e.details as { retryAfter?: number } | undefined)?.retryAfter ?? 30;
      setLockedUntil(Date.now() + retry * 1000);
      setError(null);
    } else if (isApiError(e, 'vault_unlock_failed')) {
      const remaining = (e.details as { remaining?: number } | undefined)?.remaining;
      setError(
        remaining !== undefined
          ? t('vault.unlock.wrong', { remaining })
          : t('errors.vault_unlock_failed'),
      );
    } else setError(errorMessage(e, t));
    void qc.invalidateQueries({ queryKey: vaultKeys.status });
  };

  const submit = async () => {
    if (!me || !password || wait > 0) return;
    setBusy(true);
    setError(null);
    try {
      await unlockWithPassword(me.user.id, password);
      setPassword('');
      // Hello unlock on this computer counts its 14 days from here.
      if (device.data === 'ready' || device.data === 'expired') {
        passwordUnlocked(me.user.id, status);
      }
    } catch (e) {
      fail(e);
      setPassword('');
      input.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  const withPasskey = async () => {
    if (!me || !passkeys.length) return;
    setBusy(true);
    setError(null);
    try {
      // Any of the person's vault passkeys may be the one on this device.
      const { method, material } = await passkeyUnlock(passkeys);
      await unlockWithSecret(me.user.id, 'passkey_prf', method.id, material);
    } catch (e) {
      if (e instanceof Error && e.message === 'prf_unsupported') {
        setError(t('vault.passkey.unsupported'));
      } else if (e instanceof Error && e.message === 'no_passkey') {
        setError(t('vault.passkey.notOnDevice'));
      } else if (e instanceof DOMException) setError(t('vault.passkey.cancelled'));
      else fail(e);
    } finally {
      setBusy(false);
    }
  };

  if (mode === 'recovery') return <RecoveryFlow onCancel={() => setMode('password')} />;

  return (
    <Workspace crumbs={[{ label: t('vault.title') }, { label: t('vault.locked') }]}>
      <div className="m-auto flex w-full max-w-[400px] flex-col items-center gap-4 rounded-4xl bg-surface p-7 text-center shadow-line">
        <span className="relative flex size-14 items-center justify-center rounded-2xl bg-bg2">
          <Icon name="vault" size={26} />
          <span className="absolute -right-1 -bottom-1 flex size-6 items-center justify-center rounded-full bg-surface shadow-line">
            <Icon name="lock" size={13} />
          </span>
        </span>
        <div className="flex flex-col gap-1">
          <h1 className="text-h font-semibold">{t('vault.unlock.title')}</h1>
          {me ? (
            <span className="flex items-center justify-center gap-2 text-sm text-fg2">
              <Avatar name={me.user.name} src={me.user.imageUrl} size="sm" />
              {me.user.name} · {me.user.email}
            </span>
          ) : null}
        </div>
        {helloFirst ? (
          <div className="flex w-full flex-col items-center gap-3">
            <Button variant="pri" full autoFocus loading={busy} onClick={() => void withHello()}>
              <Icon name="finger" size={16} />
              {t('vault.hello.unlock', { name: lockName })}
            </Button>
            {deviceNote ? (
              <p role="alert" className="text-sm text-danger">
                {deviceNote}
              </p>
            ) : null}
            <button
              type="button"
              className="text-sm font-medium text-fg2 hover:text-fg"
              onClick={() => setUsePassword(true)}
            >
              {t('vault.hello.withPassword')}
            </button>
          </div>
        ) : null}
        {!helloFirst && (deviceNote || device.data === 'expired') ? (
          <p className="text-sm text-fg2">
            {deviceNote ?? t('vault.hello.expired', { name: lockName, days: HELLO_DAYS })}
          </p>
        ) : null}
        {helloFirst ? null : (
          <form
            className="flex w-full flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <Input
              ref={input}
              type={show ? 'text' : 'password'}
              autoComplete="current-password"
              autoFocus
              icon="key"
              aria-label={t('vault.unlock.password')}
              placeholder={t('vault.unlock.password')}
              value={password}
              disabled={wait > 0}
              onChange={(e) => setPassword(e.target.value)}
              trailing={
                <IconButton
                  aria-label={show ? t('vault.hide') : t('vault.show')}
                  tone="plain"
                  size="xs"
                  onClick={() => setShow((v) => !v)}
                >
                  <Icon name={show ? 'eyeOff' : 'eye'} size={16} />
                </IconButton>
              }
            />
            {wait > 0 ? (
              <p role="alert" className="text-sm text-danger">
                {t('vault.unlock.wait', { seconds: wait })}
              </p>
            ) : error ? (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            ) : null}
            <Button
              type="submit"
              variant="pri"
              full
              loading={busy}
              disabled={!password || wait > 0}
            >
              {t('vault.unlock.submit')}
            </Button>
          </form>
        )}
        {passkeys.length && passkeySupported() ? (
          <>
            <span className="text-xs text-fg3">{t('vault.unlock.or')}</span>
            <Button
              variant="out"
              full
              disabled={busy || wait > 0}
              onClick={() => void withPasskey()}
            >
              <Icon name="finger" size={16} />
              {t('vault.unlock.passkey')}
              {passkeys.length === 1 ? (
                <span className="font-normal text-fg3">{passkeys[0]!.label}</span>
              ) : null}
            </Button>
          </>
        ) : null}
        <button
          type="button"
          className="text-sm text-fg2 hover:text-fg"
          onClick={() => setMode('recovery')}
        >
          {t('vault.unlock.forgot')}{' '}
          <b className="font-semibold text-fg">{t('vault.unlock.useRecovery')}</b>
        </button>
      </div>
      {lockedAt && lockReason ? (
        <p className="mx-auto flex items-center gap-1.5 text-xs text-fg3">
          <Icon name="clock" size={13} />
          {t(`vault.unlock.reason.${lockReason}`, { time: formatTime(new Date(lockedAt), locale) })}
        </p>
      ) : null}
    </Workspace>
  );
}

/** Recovery key → new vault password (the old wrap is replaced). */
function RecoveryFlow({ onCancel }: { onCancel: () => void }) {
  const { t } = useI18n();
  const me = useMe();
  const strength = useStrengthModule();
  const [key, setKey] = useState('');
  const [verifier, setVerifier] = useState<Uint8Array | null>(null);
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputs = [me?.user.email ?? '', me?.user.name ?? ''];
  const ok = Boolean(strength?.vaultPasswordChecks(password, inputs).ok) && password === again;

  const open = async () => {
    if (!me) return;
    setBusy(true);
    setError(null);
    try {
      setVerifier(await unlockWithRecovery(me.user.id, key));
    } catch (e) {
      setError(errorMessage(e, t));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!verifier) return;
    setBusy(true);
    setError(null);
    try {
      await changeVaultPassword({ method: 'recovery', verifier }, password);
    } catch (e) {
      setError(errorMessage(e, t));
      setBusy(false);
    }
  };

  return (
    <Workspace crumbs={[{ label: t('vault.title') }, { label: t('vault.recoverFlow.crumb') }]}>
      <div className="m-auto flex w-full max-w-[460px] flex-col gap-4 rounded-4xl bg-surface p-7 shadow-line">
        <h1 className="text-h font-semibold">{t('vault.recoverFlow.title')}</h1>
        {!verifier ? (
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void open();
            }}
          >
            <p className="text-sm text-fg2">{t('vault.recoverFlow.body')}</p>
            <Field label={t('vault.recovery.keyLabel')}>
              <Textarea
                rows={3}
                autoFocus
                spellCheck={false}
                autoComplete="off"
                className="font-mono uppercase"
                value={key}
                onChange={(e) => setKey(e.target.value)}
              />
            </Field>
            {error ? (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            ) : null}
            <div className="flex gap-2">
              <Button variant="gh" onClick={onCancel}>
                {t('vault.back')}
              </Button>
              <Button
                type="submit"
                variant="pri"
                className="flex-1"
                loading={busy}
                disabled={!isRecoveryKeyComplete(key)}
              >
                {t('vault.recoverFlow.open')}
              </Button>
            </div>
          </form>
        ) : (
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <p className="text-sm text-fg2">{t('vault.recoverFlow.newPassword')}</p>
            <Field label={t('vault.setup.password')}>
              <Input
                type="password"
                autoComplete="new-password"
                autoFocus
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            <StrengthBar password={password} inputs={inputs} />
            <Field
              label={t('vault.setup.again')}
              error={again && again !== password ? t('vault.setup.mismatch') : undefined}
            >
              <Input
                type="password"
                autoComplete="new-password"
                value={again}
                onChange={(e) => setAgain(e.target.value)}
              />
            </Field>
            {error ? (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            ) : null}
            <Button type="submit" variant="pri" loading={busy} disabled={!ok}>
              {t('vault.recoverFlow.save')}
            </Button>
          </form>
        )}
      </div>
    </Workspace>
  );
}
