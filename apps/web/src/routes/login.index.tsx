import { type SignInDiscovery } from '@crewhall/shared';
import { Button, CheckboxRow, Field, Icon, IconButton, Input, Segmented } from '@crewhall/ui';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { z } from 'zod';
import {
  AuthHeading,
  AuthLayout,
  linkClass,
  Notice,
  OrDivider,
} from '@/components/auth/AuthLayout';
import { LockedView } from '@/components/auth/LockedView';
import { PasskeyWaiting } from '@/components/auth/PasskeyWaiting';
import {
  DomainSsoNotice,
  SsoButtons,
  useSsoStart,
  type SsoProviderRef,
} from '@/components/identity/LoginSso';
import { api } from '@/lib/api';
import {
  signInEmail,
  signInLdap,
  signInPasskey,
  type AuthFailure,
  type LockInfo,
} from '@/lib/auth/auth';
import { setPendingIdentity } from '@/lib/auth/pending';
import { useI18n } from '@/lib/i18n/I18nContext';
import { ssoErrorCode } from '@/lib/identity/sso';
import { readStorage, StorageKey, writeStorage } from '@/lib/storage';
import { useBootstrap } from '@/lib/useBranding';
import { DemoAccounts } from '@/components/identity/Demo';
import { safeRedirect } from '@/lib/redirect';
import { DesktopDownloadLink } from '@/components/account/DesktopDownload';

const search = z.object({
  redirect: z.string().optional(),
  email: z.string().optional(),
  /** Set by the api when an SSO round trip failed (an error code). */
  ssoError: z.string().optional(),
});

export const Route = createFileRoute('/login/')({
  validateSearch: search,
  component: LoginPage,
});

type Phase = { kind: 'form' } | { kind: 'passkey' } | { kind: 'locked'; lock: LockInfo };
/** email: local password (or directory password when discovery says so); ldap: directory name. */
type Mode = 'email' | 'ldap';

function LoginPage() {
  const { t } = useI18n();
  const { branding, data } = useBootstrap();
  const { redirect, email: emailParam, ssoError } = Route.useSearch();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const passwordRef = useRef<HTMLInputElement>(null);

  const [email, setEmail] = useState(emailParam ?? '');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [remember, setRemember] = useState(true);
  const [capsLock, setCapsLock] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AuthFailure | null>(null);
  const [ssoFailure, setSsoFailure] = useState(() => ssoErrorCode(ssoError));
  const [phase, setPhase] = useState<Phase>({ kind: 'form' });
  const passkeyEnabled = data?.auth.passkey ?? true;
  const passkeyFirst = passkeyEnabled && readStorage(StorageKey.passkeyUsed) === '1';

  // Identity module: SSO buttons, directory (LDAP) sign-in, password sign-in turned off.
  const ssoProviders: SsoProviderRef[] = data?.auth.sso ?? [];
  const ldap = data?.auth.ldap ?? null;
  const passwordAllowed = data?.auth.password !== false;
  const [emergency, setEmergency] = useState(false);
  const modes: Mode[] = [
    ...(passwordAllowed || emergency ? (['email'] as const) : []),
    ...(ldap ? (['ldap'] as const) : []),
  ];
  const [modeChoice, setModeChoice] = useState<Mode | null>(null);
  const preferred: Mode = modeChoice ?? (passwordAllowed || !ldap ? 'email' : 'ldap');
  const mode: Mode | null = modes.includes(preferred) ? preferred : (modes[0] ?? null);
  const [discovery, setDiscovery] = useState<{ email: string; result: SignInDiscovery } | null>(
    null,
  );
  const sso = useSsoStart(redirect);

  useEffect(() => {
    if (data?.needsSetup) void navigate({ to: '/setup', replace: true });
  }, [data?.needsSetup, navigate]);

  /** Which way this e-mail signs in (SSO-only domain, directory password); best effort. */
  async function discover(value: string): Promise<SignInDiscovery | null> {
    const trimmed = value.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(trimmed)) return null;
    if (discovery?.email === trimmed) return discovery.result;
    try {
      const result = await api.call('discoverSignIn', { body: { email: trimmed } });
      setDiscovery({ email: trimmed, result });
      return result;
    } catch {
      return null;
    }
  }

  async function done() {
    await qc.invalidateQueries();
    await navigate({ href: safeRedirect(redirect), replace: true });
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSsoFailure(null);
    const login = email.trim();
    const viaDirectory = mode === 'ldap' || (await discover(login))?.ldap === true;
    const res = viaDirectory
      ? await signInLdap({ username: login, password, rememberMe: remember })
      : await signInEmail({ email: login, password, rememberMe: remember });
    setBusy(false);
    if (res.ok) {
      setPendingIdentity({ email: login });
      if (res.data.twoFactor) {
        await navigate({ to: '/login/2fa', search: { redirect } });
      } else {
        await done();
      }
      return;
    }
    if (res.kind === 'locked') {
      setPhase({
        kind: 'locked',
        lock: {
          lockedUntil: res.lockedUntil,
          lastFailedAt: res.lastFailedAt,
          lastFailedIp: res.lastFailedIp,
        },
      });
      return;
    }
    setError(res);
    setPassword('');
    passwordRef.current?.focus();
  }

  async function onPasskey() {
    setPhase({ kind: 'passkey' });
    setError(null);
    setSsoFailure(null);
    const res = await signInPasskey();
    if (res.ok) {
      writeStorage(StorageKey.passkeyUsed, '1');
      await done();
      return;
    }
    setPhase({ kind: 'form' });
    setError(res.kind === 'cancelled' ? { kind: 'cancelled' } : res);
  }

  const footer = t('auth.login.noAccount');

  if (phase.kind === 'locked') {
    return (
      <AuthLayout footer={footer}>
        <LockedView
          email={email}
          lock={phase.lock}
          onPasskey={passkeyEnabled ? onPasskey : undefined}
          onExpired={() => setPhase({ kind: 'form' })}
        />
      </AuthLayout>
    );
  }

  if (phase.kind === 'passkey') {
    return (
      <AuthLayout footer={footer}>
        <PasskeyWaiting onCancel={() => setPhase({ kind: 'form' })} />
      </AuthLayout>
    );
  }

  const passkeyButton = passkeyEnabled ? (
    <Button variant={passkeyFirst ? 'pri' : 'out'} full onClick={onPasskey}>
      <Icon name="finger" size={18} />
      {t('auth.login.passkey')}
    </Button>
  ) : null;
  const policyProvider =
    error?.kind === 'policy' && error.code === 'sso_required'
      ? (ssoProviders.find((p) => p.id === error.providerId) ??
        discovery?.result.provider ??
        ssoProviders[0] ??
        null)
      : null;
  const showDivider =
    mode !== null && (ssoProviders.length > 0 || (!passkeyFirst && passkeyButton));

  return (
    <AuthLayout footer={footer}>
      <AuthHeading
        title={t('auth.login.title')}
        subtitle={t('auth.login.subtitle', { org: branding.orgName })}
      />
      <DemoAccounts
        onPick={(a) => {
          setModeChoice('email');
          setEmail(a.email);
          setPassword(a.password);
          setError(null);
        }}
      />
      {passkeyFirst ? (
        <>
          {passkeyButton}
          <OrDivider>{t('auth.login.or')}</OrDivider>
        </>
      ) : null}
      {mode === null ? (
        <SsoButtons
          providers={ssoProviders}
          leaving={sso.leaving}
          onStart={(id) => sso.start(id)}
          primary={!passkeyFirst}
        />
      ) : null}
      {ssoFailure ? <Notice tone="error">{t(`errors.${ssoFailure}`)}</Notice> : null}
      {error ? (
        <LoginError
          error={error}
          ssoProvider={policyProvider}
          onSso={(id) => sso.start(id, email.trim() || undefined)}
        />
      ) : null}
      {mode === 'email' && !policyProvider && discovery && discovery.email === email.trim() ? (
        <DomainSsoNotice
          discovery={discovery.result}
          leaving={sso.leaving}
          onStart={(id) => sso.start(id, email.trim())}
        />
      ) : null}
      {modes.length > 1 && mode ? (
        <Segmented
          aria-label={t('identity.login.modeLabel')}
          value={mode}
          onValueChange={(m) => {
            setModeChoice(m);
            setError(null);
          }}
          options={[
            { value: 'email', label: t('identity.login.modeEmail'), icon: 'mail' },
            { value: 'ldap', label: t('identity.login.modeDirectory'), icon: 'server' },
          ]}
        />
      ) : null}
      {mode === null ? null : (
        <form className="flex flex-col gap-[18px]" onSubmit={onSubmit} noValidate>
          <div className="flex flex-col gap-3.5">
            {mode === 'ldap' && ldap ? (
              <Field label={ldap.label} hint={t('identity.login.directoryHint')}>
                <Input
                  icon="user"
                  type="text"
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoFocus={!emailParam}
                />
              </Field>
            ) : (
              <Field label={t('auth.fields.email')}>
                <Input
                  icon="mail"
                  type="email"
                  autoComplete="username webauthn"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onBlur={(e) => void discover(e.target.value)}
                  required
                  autoFocus={!emailParam}
                />
              </Field>
            )}
            <Field
              label={t('auth.fields.password')}
              labelAside={
                mode === 'email' ? (
                  <Link
                    to="/forgot-password"
                    search={{ email: email || undefined }}
                    className={`${linkClass} text-[12.5px]`}
                  >
                    {t('auth.login.forgot')}
                  </Link>
                ) : null
              }
              hint={capsLock ? t('auth.login.capsLock') : undefined}
            >
              <Input
                ref={passwordRef}
                icon="lock"
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyUp={(e) => setCapsLock(e.getModifierState('CapsLock'))}
                invalid={error?.kind === 'invalid'}
                required
                autoFocus={Boolean(emailParam)}
                className="tracking-[.04em]"
                trailing={
                  <IconButton
                    aria-label={t(
                      showPassword ? 'auth.fields.hidePassword' : 'auth.fields.showPassword',
                    )}
                    size="xs"
                    tone="plain"
                    onClick={() => setShowPassword((v) => !v)}
                  >
                    <Icon name={showPassword ? 'eyeOff' : 'eye'} size={18} />
                  </IconButton>
                }
              />
            </Field>
            <CheckboxRow checked={remember} onCheckedChange={(v) => setRemember(v === true)}>
              {t('auth.login.remember')}
            </CheckboxRow>
          </div>
          {emergency && mode === 'email' ? (
            <Notice tone="warn" icon="lock">
              {t('identity.login.emergencyHint')}
            </Notice>
          ) : null}
          <Button type="submit" variant={passkeyFirst ? 'inv' : 'pri'} full loading={busy}>
            {t('auth.login.submit')}
          </Button>
        </form>
      )}
      {showDivider ? <OrDivider>{t('auth.login.or')}</OrDivider> : null}
      {mode !== null ? (
        <SsoButtons
          providers={ssoProviders}
          leaving={sso.leaving}
          onStart={(id) => sso.start(id)}
        />
      ) : null}
      {passkeyFirst ? null : passkeyButton}
      {!passwordAllowed && !emergency ? (
        <button
          type="button"
          className={`${linkClass} self-center text-[12.5px] text-fg2`}
          onClick={() => {
            setEmergency(true);
            setModeChoice('email');
            setError(null);
          }}
        >
          {t('identity.login.emergency')}
        </button>
      ) : null}
      <DesktopDownloadLink />
    </AuthLayout>
  );
}

function LoginError({
  error,
  ssoProvider,
  onSso,
}: {
  error: AuthFailure;
  ssoProvider: { id: string; name: string } | null;
  onSso: (providerId: string) => void;
}) {
  const { t } = useI18n();
  if (error.kind === 'policy') {
    return (
      <Notice tone="error">
        <div className="flex flex-col gap-2.5">
          <span>{t(`errors.${error.code}`)}</span>
          {ssoProvider ? (
            <Button variant="inv" size="sm" onClick={() => onSso(ssoProvider.id)}>
              {t('identity.login.ssoWith', { name: ssoProvider.name })}
            </Button>
          ) : null}
        </div>
      </Notice>
    );
  }
  if (error.kind === 'cancelled') {
    return <Notice tone="info">{t('auth.passkey.failed')}</Notice>;
  }
  if (error.kind === 'invalid') {
    return (
      <Notice tone="error">
        {t('auth.login.invalid')}
        {error.remainingAttempts !== undefined
          ? ` ${t('auth.login.remaining', { count: error.remainingAttempts })}`
          : null}
      </Notice>
    );
  }
  if (error.kind === 'rate_limited') {
    return <Notice tone="error">{t('errors.rate_limited')}</Notice>;
  }
  if (error.kind === 'network') return <Notice tone="error">{t('auth.errors.network')}</Notice>;
  return <Notice tone="error">{t('errors.internal')}</Notice>;
}
