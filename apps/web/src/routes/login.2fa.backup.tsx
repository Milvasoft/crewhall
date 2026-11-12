import { Button, Field, Input } from '@crewhall/ui';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { normalizeBackupCode } from '@crewhall/shared';
import { z } from 'zod';
import { AuthHeading, AuthLayout, linkClass, Notice, WhoRow } from '@/components/auth/AuthLayout';
import { CodeError } from '@/components/auth/CodeError';
import { LockedView } from '@/components/auth/LockedView';
import { verifyBackupCode, type AuthFailure, type LockInfo } from '@/lib/auth/auth';
import { getPendingIdentity, setPendingIdentity } from '@/lib/auth/pending';
import { useI18n } from '@/lib/i18n/I18nContext';
import { safeRedirect } from '@/lib/redirect';

export const Route = createFileRoute('/login/2fa/backup')({
  validateSearch: z.object({ redirect: z.string().optional() }),
  component: BackupCodePage,
});

/** Backup code sign-in (doc 01 · 1.4): 8 characters, dash optional, case-insensitive. */
function BackupCodePage() {
  const { t } = useI18n();
  const { redirect } = Route.useSearch();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const who = getPendingIdentity();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AuthFailure | null>(null);
  const [locked, setLocked] = useState<LockInfo | null>(null);
  const ready = normalizeBackupCode(code).length >= 8;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await verifyBackupCode(code);
    setBusy(false);
    if (res.ok) {
      setPendingIdentity(null);
      await qc.invalidateQueries();
      await navigate({ href: safeRedirect(redirect), replace: true });
      return;
    }
    if (res.kind === 'locked') {
      setLocked({
        lockedUntil: res.lockedUntil,
        lastFailedAt: res.lastFailedAt,
        lastFailedIp: res.lastFailedIp,
      });
    } else if (res.kind === 'expired') {
      await navigate({ to: '/login', search: { email: who?.email } });
    } else {
      setError(res);
    }
  }

  if (locked !== null) {
    return (
      <AuthLayout>
        <LockedView
          email={who?.email ?? ''}
          lock={locked}
          onExpired={() => void navigate({ to: '/login', search: { email: who?.email } })}
        />
      </AuthLayout>
    );
  }

  return (
    <AuthLayout footer={t('auth.backup.adminHelp')}>
      <AuthHeading title={t('auth.backup.title')} subtitle={t('auth.backup.subtitle')} />
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
      {error ? <CodeError error={error} invalidKey="auth.backup.invalid" /> : null}
      <form className="flex flex-col gap-[18px]" onSubmit={onSubmit}>
        <Field label={t('auth.backup.label')} hint={t('auth.backup.hint')}>
          <Input
            size="lg"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoComplete="one-time-code"
            autoCapitalize="off"
            spellCheck={false}
            autoFocus
            placeholder="4F7K-92QD"
            className="font-mono tracking-[.08em]"
            invalid={error?.kind === 'invalid'}
          />
        </Field>
        <Button type="submit" variant="pri" full loading={busy} disabled={!ready}>
          {t('auth.backup.submit')}
        </Button>
      </form>
      <Notice tone="info">{t('auth.backup.afterUse')}</Notice>
      <Link to="/login/2fa" search={{ redirect }} className={linkClass}>
        ← {t('auth.backup.back')}
      </Link>
    </AuthLayout>
  );
}
