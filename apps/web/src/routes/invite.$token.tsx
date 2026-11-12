import { paths } from '@crewhall/shared';
import { Avatar, Button, Field, Icon, Input, Skeleton } from '@crewhall/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { AuthHeading, AuthLayout, linkClass, Notice } from '@/components/auth/AuthLayout';
import { ContinueInApp } from '@/components/auth/ContinueInApp';
import { MIN_PASSWORD, PasswordStrength } from '@/components/auth/PasswordStrength';
import { api, isApiError } from '@/lib/api';
import { signOut, signUpEmail } from '@/lib/auth/auth';
import { formatDateLong } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { mobilePlatform } from '@/lib/open-in-app';
import { meQuery } from '@/lib/queries';
import { useNow } from '@/lib/useNow';

export const Route = createFileRoute('/invite/$token')({
  component: InvitePage,
});

/** Accept an invitation and create the account (doc 01 · 1.9). */
function InvitePage() {
  const { t, rich, locale } = useI18n();
  const { token } = Route.useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const preview = useQuery({
    queryKey: ['invitation', token],
    queryFn: () => api.call('getInvitation', { params: { token } }),
    retry: false,
  });
  const me = useQuery({ ...meQuery, retry: false });
  const now = useNow();
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [platform] = useState(() => mobilePlatform());
  /** Joined in a phone browser: the org's name for the "continue in the app" step. */
  const [joinedOrg, setJoinedOrg] = useState<string | null>(null);

  async function accept() {
    await api.call('acceptInvitation', { params: { token } });
    await qc.invalidateQueries();
    if (platform) setJoinedOrg(preview.data?.orgName ?? '');
    else await navigate({ to: '/', replace: true });
  }

  async function acceptSignedIn() {
    setBusy(true);
    setError(null);
    try {
      await accept();
    } catch (err) {
      setBusy(false);
      setError(isApiError(err) ? t(`errors.${err.code}`) : t('errors.internal'));
    }
  }

  async function switchAccount() {
    await signOut();
    qc.removeQueries({ queryKey: meQuery.queryKey });
    await me.refetch();
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!preview.data) return;
    if (password.length < MIN_PASSWORD) {
      setError(t('auth.password.tooShort', { min: MIN_PASSWORD, count: password.length }));
      return;
    }
    setBusy(true);
    setError(null);
    const res = await signUpEmail({ name: name.trim(), email: preview.data.email, password });
    if (!res.ok) {
      setBusy(false);
      setError(res.kind === 'other' ? t('auth.invite.exists') : t('errors.internal'));
      return;
    }
    await qc.invalidateQueries({ queryKey: meQuery.queryKey });
    try {
      await accept();
    } catch (err) {
      setBusy(false);
      setError(isApiError(err) ? t(`errors.${err.code}`) : t('errors.internal'));
    }
  }

  // Before the preview: the accepted invitation no longer resolves once the queries refetch.
  if (platform && joinedOrg !== null) {
    return (
      <AuthLayout>
        <ContinueInApp
          platform={platform}
          orgName={joinedOrg}
          onStay={() => void navigate({ to: '/', replace: true })}
        />
      </AuthLayout>
    );
  }

  if (preview.isLoading) {
    return (
      <AuthLayout>
        <Skeleton className="h-16 w-full rounded-2xl" />
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-11 w-full rounded-lg" />
      </AuthLayout>
    );
  }

  if (preview.isError || !preview.data) {
    return (
      <AuthLayout>
        <span className="flex size-12 items-center justify-center rounded-[14px] bg-bg2 text-fg2">
          <Icon name="mail" size={24} />
        </span>
        <AuthHeading
          title={t('auth.invite.invalidTitle')}
          subtitle={t('auth.invite.invalidBody')}
        />
        <Button variant="inv" full asChild>
          <Link to="/login">{t('auth.forgot.backToLogin')}</Link>
        </Button>
      </AuthLayout>
    );
  }

  const inv = preview.data;
  const daysLeft = Math.max(0, Math.ceil((new Date(inv.expiresAt).getTime() - now) / 86_400_000));
  const signedIn = me.data?.user.email;
  const signedInAsInvitee = signedIn === inv.email;
  const loginLink = { email: inv.email, redirect: paths.invite(token) };

  return (
    <AuthLayout wide footer={t('auth.invite.terms', { org: inv.orgName })}>
      <div className="flex flex-col gap-3 rounded-2xl bg-surface p-4 shadow-line">
        <div className="flex items-center gap-3">
          <Avatar name={inv.invitedByName} />
          <div className="flex min-w-0 flex-col">
            <span className="text-sm">
              {rich('auth.invite.invitedBy', { name: inv.invitedByName, org: inv.orgName })}
            </span>
            <span className="text-xs text-fg2">
              {t('auth.invite.validFor', {
                date: formatDateLong(inv.expiresAt, locale),
                days: daysLeft,
              })}
            </span>
          </div>
        </div>
        <div className="flex items-center justify-between border-t border-line pt-3 text-cap">
          <span className="text-fg2">{t('auth.invite.orgRole')}</span>
          <span className="font-semibold">{t(`common.roles.org.${inv.role}`)}</span>
        </div>
        {inv.spaces?.length ? (
          <div className="flex items-start justify-between gap-3 border-t border-line pt-3 text-cap">
            <span className="text-fg2">{t('auth.invite.spaces')}</span>
            <span className="flex flex-wrap justify-end gap-1.5">
              {inv.spaces.map((sp) => (
                <span
                  key={sp.id}
                  className="inline-flex h-6 items-center gap-1.5 rounded-xs bg-bg2 px-2 text-xs"
                >
                  <b className="font-semibold">{sp.name}</b>
                  <span className="text-fg2">{t(`common.roles.space.${sp.role}`)}</span>
                </span>
              ))}
            </span>
          </div>
        ) : null}
      </div>

      {error ? <Notice tone="error">{error}</Notice> : null}

      {signedInAsInvitee ? (
        <>
          <AuthHeading title={t('auth.invite.acceptTitle')} />
          <Button variant="pri" full loading={busy} onClick={() => void acceptSignedIn()}>
            {t('auth.invite.accept')}
          </Button>
        </>
      ) : signedIn ? (
        <>
          <Notice tone="warn">
            {t('auth.invite.mismatch', { invited: inv.email, current: signedIn })}
          </Notice>
          <Button variant="inv" full onClick={() => void switchAccount()}>
            {t('auth.invite.switchAccount')}
          </Button>
        </>
      ) : inv.hasAccount ? (
        <>
          <AuthHeading
            title={t('auth.invite.signInTitle')}
            subtitle={t('auth.invite.signInBody', { email: inv.email })}
          />
          <Button variant="pri" full asChild>
            <Link to="/login" search={loginLink}>
              {t('auth.login.submit')}
            </Link>
          </Button>
        </>
      ) : (
        <>
          <AuthHeading title={t('auth.invite.createTitle')} />
          <form className="flex flex-col gap-3.5" onSubmit={onSubmit} noValidate>
            <Field label={t('auth.fields.name')}>
              <Input
                icon="user"
                autoComplete="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                autoFocus
              />
            </Field>
            <Field label={t('auth.fields.email')} hint={t('auth.invite.emailFixed')}>
              <Input icon="mail" value={inv.email} readOnly disabled />
            </Field>
            <Field label={t('auth.fields.password')}>
              <Input
                icon="lock"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </Field>
            <PasswordStrength password={password} email={inv.email} name={name} />
            <Button
              type="submit"
              variant="pri"
              full
              loading={busy}
              disabled={!name.trim() || !password}
              className="mt-1"
            >
              {t('auth.invite.submit')}
            </Button>
          </form>
          <span className="text-center text-cap text-fg2">
            {t('auth.invite.haveAccount')}{' '}
            <Link to="/login" search={loginLink} className={linkClass}>
              {t('auth.login.submit')}
            </Link>
          </span>
        </>
      )}
    </AuthLayout>
  );
}
