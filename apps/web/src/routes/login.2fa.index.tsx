import { Button, CheckboxRow, Icon, OtpInput } from '@crewhall/ui';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useState, type FormEvent } from 'react';
import { z } from 'zod';
import { AuthHeading, AuthLayout, linkClass, WhoRow } from '@/components/auth/AuthLayout';
import { CodeError } from '@/components/auth/CodeError';
import { LockedView } from '@/components/auth/LockedView';
import { signInPasskey, verifyTotp, type AuthFailure, type LockInfo } from '@/lib/auth/auth';
import { getPendingIdentity, setPendingIdentity } from '@/lib/auth/pending';
import { useI18n } from '@/lib/i18n/I18nContext';
import { safeRedirect } from '@/lib/redirect';

export const Route = createFileRoute('/login/2fa/')({
  validateSearch: z.object({ redirect: z.string().optional() }),
  component: TwoFactorPage,
});

/** Code step after the password (doc 01 · 1.3). Returns to /login after 5 minutes. */
function TwoFactorPage() {
  const { t } = useI18n();
  const { redirect } = Route.useSearch();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const who = getPendingIdentity();
  const [code, setCode] = useState('');
  const [trust, setTrust] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AuthFailure | null>(null);
  const [locked, setLocked] = useState<LockInfo | null>(null);

  useEffect(() => {
    const id = window.setTimeout(
      () => void navigate({ to: '/login', search: { email: who?.email, redirect }, replace: true }),
      5 * 60_000,
    );
    return () => window.clearTimeout(id);
  }, [navigate, who?.email, redirect]);

  async function finish() {
    setPendingIdentity(null);
    await qc.invalidateQueries();
    await navigate({ href: safeRedirect(redirect), replace: true });
  }

  async function submit(value = code) {
    if (value.length !== 6 || busy) return;
    setBusy(true);
    setError(null);
    const res = await verifyTotp(value, trust);
    setBusy(false);
    if (res.ok) return finish();
    if (res.kind === 'locked') {
      return setLocked({
        lockedUntil: res.lockedUntil,
        lastFailedAt: res.lastFailedAt,
        lastFailedIp: res.lastFailedIp,
      });
    }
    if (res.kind === 'expired') {
      await navigate({ to: '/login', search: { email: who?.email, redirect } });
      return;
    }
    setError(res);
    setCode('');
  }

  async function passkey() {
    const res = await signInPasskey();
    if (res.ok) return finish();
    setError({ kind: 'cancelled' });
  }

  const footer = t('auth.twoFactor.lostDevice');

  if (locked !== null) {
    return (
      <AuthLayout footer={footer}>
        <LockedView
          email={who?.email ?? ''}
          lock={locked}
          onExpired={() => void navigate({ to: '/login', search: { email: who?.email } })}
        />
      </AuthLayout>
    );
  }

  return (
    <AuthLayout footer={footer}>
      <AuthHeading title={t('auth.twoFactor.title')} subtitle={t('auth.twoFactor.subtitle')} />
      {who ? (
        <WhoRow
          name={who.name}
          email={who.email}
          action={
            <Button variant="gh" size="sm" asChild>
              <Link to="/login" search={{ email: who.email, redirect }}>
                {t('auth.twoFactor.change')}
              </Link>
            </Button>
          }
        />
      ) : null}
      {error ? <CodeError error={error} invalidKey="auth.twoFactor.invalid" /> : null}
      <form
        className="flex flex-col gap-[18px]"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void submit();
        }}
      >
        <OtpInput
          aria-label={t('auth.twoFactor.codeLabel')}
          value={code}
          onChange={setCode}
          onComplete={(v) => void submit(v)}
          invalid={error?.kind === 'invalid'}
          autoFocus
          disabled={busy}
        />
        <CheckboxRow checked={trust} onCheckedChange={(v) => setTrust(v === true)}>
          {t('auth.twoFactor.trust')}
        </CheckboxRow>
        <Button type="submit" variant="pri" full loading={busy} disabled={code.length !== 6}>
          {t('auth.twoFactor.submit')}
        </Button>
      </form>
      <div className="flex items-center justify-between gap-3">
        <Link to="/login/2fa/backup" search={{ redirect }} className={linkClass}>
          {t('auth.twoFactor.useBackup')}
        </Link>
        <button
          type="button"
          onClick={() => void passkey()}
          className={`${linkClass} inline-flex items-center gap-1.5`}
        >
          <Icon name="finger" size={15} />
          {t('auth.twoFactor.usePasskey')}
        </button>
      </div>
    </AuthLayout>
  );
}
