import { Button, Field, Icon, Input } from '@crewhall/ui';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useEffect, useState, type FormEvent } from 'react';
import { z } from 'zod';
import { AuthHeading, AuthLayout, linkClass, Notice } from '@/components/auth/AuthLayout';
import { requestPasswordReset } from '@/lib/auth/auth';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useBootstrap } from '@/lib/useBranding';

export const Route = createFileRoute('/forgot-password')({
  validateSearch: z.object({ email: z.string().optional() }),
  component: ForgotPasswordPage,
});

const RESEND_SEC = 60;

/** Doc 01 · 1.6 and 1.7. The answer never reveals whether the account exists. */
function ForgotPasswordPage() {
  const { t, rich } = useI18n();
  const { email: initial } = Route.useSearch();
  const [email, setEmail] = useState(initial ?? '');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wait, setWait] = useState(0);
  const emailEnabled = useBootstrap().data?.auth.emailEnabled !== false;

  useEffect(() => {
    if (wait <= 0) return;
    const id = window.setTimeout(() => setWait((w) => w - 1), 1000);
    return () => window.clearTimeout(id);
  }, [wait]);

  async function send(e?: FormEvent) {
    e?.preventDefault();
    if (!email.includes('@')) {
      setError(t('auth.fields.emailInvalid'));
      return;
    }
    setBusy(true);
    setError(null);
    const res = await requestPasswordReset(email.trim());
    setBusy(false);
    if (!res.ok && res.kind === 'rate_limited') {
      setError(t('errors.rate_limited'));
      return;
    }
    if (!res.ok && res.kind === 'network') {
      setError(t('auth.errors.network'));
      return;
    }
    setSent(true);
    setWait(RESEND_SEC);
  }

  if (!emailEnabled) {
    // No SMTP: a reset link cannot be delivered, an admin resets the password (doc 01 · 1.6).
    return (
      <AuthLayout>
        <Link to="/login" search={{ email: email || undefined }} className={linkClass}>
          ← {t('auth.forgot.backToLogin')}
        </Link>
        <AuthHeading title={t('auth.forgot.title')} subtitle={t('auth.forgot.noEmailBody')} />
        <Notice tone="info" icon="users">
          {t('auth.forgot.noEmailHint')}
        </Notice>
      </AuthLayout>
    );
  }

  if (sent) {
    return (
      <AuthLayout footer={t('auth.forgot.closeTab')}>
        <span className="flex size-12 items-center justify-center rounded-[14px] bg-bg2 text-fg">
          <Icon name="mail" size={24} />
        </span>
        <AuthHeading
          title={t('auth.forgot.sentTitle')}
          subtitle={rich('auth.forgot.sentBody', { email })}
        />
        <div className="flex flex-col gap-2 rounded-2xl bg-bg2 px-4 py-3.5 text-cap text-fg2">
          <span className="font-semibold text-fg">{t('auth.forgot.notArrived')}</span>
          <span className="flex items-center gap-2">
            <Icon name="inbox" size={16} />
            {t('auth.forgot.checkSpam')}
          </span>
          <span className="flex items-center gap-2">
            <Icon name="check" size={16} />
            {t('auth.forgot.checkAddress')}
          </span>
        </div>
        <div className="flex gap-2">
          <Button full disabled={wait > 0} loading={busy} onClick={() => void send()}>
            {wait > 0
              ? t('auth.forgot.resendIn', { time: `0:${String(wait).padStart(2, '0')}` })
              : t('auth.forgot.resend')}
          </Button>
          <Button variant="out" full onClick={() => setSent(false)}>
            {t('auth.forgot.otherAddress')}
          </Button>
        </div>
        <Button variant="inv" full asChild>
          <Link to="/login" search={{ email }}>
            {t('auth.forgot.backToLogin')}
          </Link>
        </Button>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <Link to="/login" search={{ email: email || undefined }} className={linkClass}>
        ← {t('auth.forgot.backToLogin')}
      </Link>
      <AuthHeading title={t('auth.forgot.title')} subtitle={t('auth.forgot.subtitle')} />
      <form className="flex flex-col gap-[18px]" onSubmit={send} noValidate>
        <Field label={t('auth.fields.email')} error={error ?? undefined}>
          <Input
            icon="mail"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoFocus
          />
        </Field>
        <Button type="submit" variant="pri" full loading={busy}>
          {t('auth.forgot.submit')}
        </Button>
      </form>
      <Notice tone="warn" icon="vault">
        {rich('auth.forgot.vaultNote')}
      </Notice>
      <span className="text-cap text-fg2">{t('auth.forgot.passkeyHint')}</span>
    </AuthLayout>
  );
}
