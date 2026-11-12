import { Button, Field, Icon, Input } from '@crewhall/ui';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { z } from 'zod';
import { AuthHeading, AuthLayout, Notice } from '@/components/auth/AuthLayout';
import { MIN_PASSWORD, PasswordStrength } from '@/components/auth/PasswordStrength';
import { resetPassword } from '@/lib/auth/auth';
import { useI18n } from '@/lib/i18n/I18nContext';

export const Route = createFileRoute('/reset-password')({
  // The reset e-mail links to ?t=<token>; better-auth's own redirect uses ?token= (or ?error=).
  validateSearch: z.object({
    t: z.string().optional(),
    token: z.string().optional(),
    error: z.string().optional(),
  }),
  component: ResetPasswordPage,
});

/** Doc 01 · 1.8. Saving signs out every session; 2FA is asked again on next sign-in. */
function ResetPasswordPage() {
  const { t } = useI18n();
  const search = Route.useSearch();
  const token = search.t ?? search.token;
  const linkError = search.error;
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [expired, setExpired] = useState(!token || Boolean(linkError));
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (password.length < MIN_PASSWORD) {
      setError(t('auth.password.tooShort', { min: MIN_PASSWORD, count: password.length }));
      return;
    }
    if (password !== repeat) {
      setError(t('auth.reset.mismatch'));
      return;
    }
    setBusy(true);
    setError(null);
    const res = await resetPassword(token ?? '', password);
    setBusy(false);
    if (res.ok) {
      await navigate({ to: '/login', search: {}, replace: true });
      return;
    }
    if (res.kind === 'expired' || res.kind === 'invalid') setExpired(true);
    else setError(t('errors.internal'));
  }

  if (expired) {
    return (
      <AuthLayout>
        <span className="flex size-12 items-center justify-center rounded-[14px] bg-bg2 text-fg2">
          <Icon name="clock" size={24} />
        </span>
        <AuthHeading title={t('auth.reset.expiredTitle')} subtitle={t('auth.reset.expiredBody')} />
        <Button variant="pri" full asChild>
          <Link to="/forgot-password">{t('auth.reset.newLink')}</Link>
        </Button>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <AuthHeading title={t('auth.reset.title')} subtitle={t('auth.reset.subtitle')} />
      {error ? <Notice tone="error">{error}</Notice> : null}
      <form className="flex flex-col gap-[18px]" onSubmit={onSubmit} noValidate>
        <Field label={t('auth.reset.newPassword')}>
          <Input
            icon="lock"
            type={show ? 'text' : 'password'}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
            trailing={
              <button
                type="button"
                aria-label={t(show ? 'auth.fields.hidePassword' : 'auth.fields.showPassword')}
                onClick={() => setShow((v) => !v)}
                className="text-fg3 hover:text-fg"
              >
                <Icon name={show ? 'eyeOff' : 'eye'} size={18} />
              </button>
            }
          />
        </Field>
        <PasswordStrength password={password} />
        <Field label={t('auth.reset.repeat')}>
          <Input
            icon="lock"
            type={show ? 'text' : 'password'}
            autoComplete="new-password"
            value={repeat}
            onChange={(e) => setRepeat(e.target.value)}
            invalid={repeat.length > 0 && repeat !== password}
          />
        </Field>
        <span className="flex items-center gap-2 text-cap text-fg2">
          <Icon name="logout" size={16} />
          {t('auth.reset.signOutAll')}
        </span>
        <Button type="submit" variant="pri" full loading={busy}>
          {t('auth.reset.submit')}
        </Button>
      </form>
    </AuthLayout>
  );
}
