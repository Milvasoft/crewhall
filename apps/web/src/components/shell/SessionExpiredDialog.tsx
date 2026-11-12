import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  Field,
  Icon,
  Input,
  OtpInput,
} from '@crewhall/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { Notice, OrDivider, WhoRow } from '@/components/auth/AuthLayout';
import { signInEmail, signInPasskey, signOut, verifyTotp } from '@/lib/auth/auth';
import { useI18n } from '@/lib/i18n/I18nContext';
import { clearSessionExpired, useSessionExpired } from '@/lib/sessionEvents';
import { useMe } from '@/lib/session';

/**
 * Re-authentication over the current page when the session ends (doc 01 · 1.17).
 * The page stays mounted so unsaved local state survives; same account only.
 */
export function SessionExpiredDialog() {
  const expired = useSessionExpired();
  return <Dialog open={expired}>{expired ? <ReauthForm /> : null}</Dialog>;
}

function ReauthForm() {
  const { t } = useI18n();
  const me = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'password' | 'code'>('password');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function resume() {
    clearSessionExpired();
    await qc.invalidateQueries();
  }

  async function onPassword(e: FormEvent) {
    e.preventDefault();
    if (!me) return;
    setBusy(true);
    setError(null);
    const res = await signInEmail({ email: me.user.email, password, rememberMe: true });
    setBusy(false);
    if (!res.ok) {
      setError(res.kind === 'locked' ? t('auth.locked.title') : t('auth.login.invalid'));
      setPassword('');
      return;
    }
    if (res.data.twoFactor) setStep('code');
    else await resume();
  }

  async function onCode(value: string) {
    setBusy(true);
    const res = await verifyTotp(value, false);
    setBusy(false);
    if (res.ok) await resume();
    else {
      setCode('');
      setError(t('auth.twoFactor.invalid'));
    }
  }

  async function onPasskey() {
    const res = await signInPasskey();
    if (res.ok) await resume();
    else setError(t('auth.passkey.failed'));
  }

  async function otherAccount() {
    await signOut();
    clearSessionExpired();
    qc.clear();
    await navigate({ to: '/login' });
  }

  return (
    <DialogContent
      width={440}
      onEscapeKeyDown={(e) => e.preventDefault()}
      onPointerDownOutside={(e) => e.preventDefault()}
      onInteractOutside={(e) => e.preventDefault()}
    >
      <DialogHeader
        icon="clock"
        title={t('session.expired.title')}
        description={t('session.expired.subtitle')}
      />
      {me ? <WhoRow name={me.user.name} email={me.user.email} /> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {step === 'password' && me?.user.hasPasskey ? (
        <>
          <Button variant="pri" full autoFocus onClick={() => void onPasskey()}>
            <Icon name="finger" size={18} />
            {t('identity.stepup.passkey')}
          </Button>
          <OrDivider>{t('identity.stepup.or')}</OrDivider>
        </>
      ) : null}
      {step === 'password' ? (
        <form className="flex flex-col gap-3" onSubmit={onPassword}>
          <Field label={t('auth.fields.password')}>
            <Input
              icon="lock"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus={!me?.user.hasPasskey}
            />
          </Field>
          <div className="flex min-w-0 flex-wrap gap-2">
            <Button
              type="submit"
              variant="pri"
              className="min-w-[120px] flex-1"
              loading={busy}
              disabled={!password}
            >
              {t('common.actions.continue')}
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-col gap-3">
          <span className="text-sm text-fg2">{t('auth.twoFactor.subtitle')}</span>
          <OtpInput
            aria-label={t('auth.twoFactor.codeLabel')}
            value={code}
            onChange={setCode}
            onComplete={(v) => void onCode(v)}
            size="sm"
            autoFocus
            disabled={busy}
          />
        </div>
      )}
      <button
        type="button"
        onClick={() => void otherAccount()}
        className="self-start text-cap font-medium text-fg2 underline decoration-line2 underline-offset-[3px] hover:text-fg"
      >
        {t('session.expired.otherAccount')}
      </button>
    </DialogContent>
  );
}
