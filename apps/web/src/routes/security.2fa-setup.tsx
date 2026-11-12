import { formatBackupCode } from '@crewhall/shared';
import {
  Avatar,
  Button,
  CheckboxRow,
  Field,
  Icon,
  Input,
  OtpInput,
  Skeleton,
  toast,
} from '@crewhall/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router';
import QRCode from 'qrcode';
import { useEffect, useState, type FormEvent } from 'react';
import { z } from 'zod';
import { AuthLayout, Notice } from '@/components/auth/AuthLayout';
import { isApiError } from '@/lib/api';
import {
  addPasskey,
  enableTwoFactor,
  forgetPassword,
  signOut,
  takePassword,
  totpSecretFromUri,
  verifyTotp,
} from '@/lib/auth/auth';
import { useI18n } from '@/lib/i18n/I18nContext';
import { meQuery } from '@/lib/queries';
import { useBootstrap } from '@/lib/useBranding';

export const Route = createFileRoute('/security/2fa-setup')({
  validateSearch: z.object({ from: z.enum(['setup', 'policy', 'account']).optional() }),
  beforeLoad: async ({ context, location }) => {
    try {
      await context.queryClient.ensureQueryData(meQuery);
    } catch (e) {
      if (isApiError(e, 'unauthenticated')) {
        throw redirect({ to: '/login', search: { redirect: location.href } });
      }
      throw e;
    }
  },
  component: TwoFactorSetupPage,
});

type Phase = 'password' | 'connect' | 'codes';

/** Forced 2FA enrolment (doc 01 · 1.14 connect the app, 1.15 backup codes). */
function TwoFactorSetupPage() {
  const { t } = useI18n();
  const { from } = Route.useSearch();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: me } = useQuery(meQuery);
  const { branding } = useBootstrap();
  const [verified, setVerified] = useState(false);
  // Password kept from sign-in (memory only) starts enrolment right away; else we ask for it.
  const [pw, setPw] = useState<string | null>(takePassword);
  const [password, setPassword] = useState('');
  const [qr, setQr] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A query (not an effect) so StrictMode and re-renders never call enable twice:
  // a second call would rotate the secret behind an already scanned QR code.
  const enable = useQuery({
    queryKey: ['two-factor', 'enable', pw],
    queryFn: async () => {
      const res = await enableTwoFactor(pw ?? '');
      if (!res.ok) throw new Error(res.kind);
      forgetPassword();
      return res.data;
    },
    enabled: pw !== null && !verified,
    retry: false,
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnMount: false,
  });
  const uri = enable.data?.totpURI ?? null;
  const codes = enable.data?.backupCodes ?? [];
  const phase: Phase = verified ? 'codes' : enable.data ? 'connect' : 'password';
  const enableError = enable.isError ? t('account.security.wrongPassword') : null;

  useEffect(() => {
    if (!uri) return;
    void QRCode.toString(uri, { type: 'svg', margin: 0, errorCorrectionLevel: 'M' }).then(setQr);
  }, [uri]);

  function start(value: string) {
    setError(null);
    setPw(value);
  }

  async function verify(value = code) {
    if (value.length !== 6) return;
    setBusy(true);
    setError(null);
    const res = await verifyTotp(value, false);
    setBusy(false);
    if (res.ok) {
      setVerified(true);
      return;
    }
    setCode('');
    setError(t('auth.twoFactor.invalid'));
  }

  async function finish() {
    setBusy(true);
    qc.removeQueries({ queryKey: ['two-factor'] });
    await qc.invalidateQueries();
    await navigate({ to: '/', replace: true });
  }

  async function passkeyInstead() {
    const res = await addPasskey(t('account.security.thisDevice'));
    if (res.ok) await finish();
    else setError(t('auth.passkey.failed'));
  }

  function download() {
    const lines = [
      `${branding.orgName} · ${t('setup2fa.codes.fileTitle')}`,
      me?.user.email ?? '',
      new Date().toISOString().slice(0, 10),
      '',
      ...codes.map(formatBackupCode),
    ];
    const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${branding.orgName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-backup-codes.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const topRight = me ? (
    <div className="flex items-center gap-2.5">
      <Avatar name={me.user.name} size="sm" />
      <span className="text-cap text-fg2">{me.user.email}</span>
      <Button
        variant="gh"
        size="sm"
        onClick={async () => {
          await signOut();
          qc.clear();
          await navigate({ to: '/login' });
        }}
      >
        {t('shell.signOut')}
      </Button>
    </div>
  ) : null;

  return (
    <AuthLayout wide topRight={topRight}>
      <Stepper phase={phase} />
      {phase === 'codes' ? (
        <>
          <div className="flex h-12 items-center gap-3 rounded-lg bg-[color-mix(in_srgb,var(--success)_12%,transparent)] px-3.5 text-sm">
            <Icon name="checkC" size={18} className="text-success" />
            <span className="font-semibold">{t('setup2fa.codes.connected')}</span>
          </div>
          <Heading title={t('setup2fa.codes.title')} subtitle={t('setup2fa.codes.subtitle')} />
          <ol className="m-0 grid grid-flow-col grid-rows-5 list-none grid-cols-2 gap-x-6 gap-y-1.5 rounded-2xl bg-bg2 px-5 py-4 font-mono text-[15px] leading-[22px] font-medium tracking-[.04em]">
            {codes.map((c, i) => (
              <li key={c} className="flex gap-2.5">
                <i className="w-[18px] text-right text-fg3 not-italic">{i + 1}</i>
                {formatBackupCode(c)}
              </li>
            ))}
          </ol>
          <div className="flex gap-2">
            <Button size="sm" onClick={download}>
              <Icon name="download" size={16} />
              {t('setup2fa.codes.download')}
            </Button>
            <Button
              size="sm"
              onClick={() => {
                void navigator.clipboard?.writeText(codes.map(formatBackupCode).join('\n'));
                toast(t('setup2fa.codes.copied'));
              }}
            >
              <Icon name="copy" size={16} />
              {t('setup2fa.codes.copy')}
            </Button>
            <Button size="sm" onClick={() => window.print()}>
              {t('setup2fa.codes.print')}
            </Button>
          </div>
          <CheckboxRow checked={saved} onCheckedChange={(v) => setSaved(v === true)}>
            {t('setup2fa.codes.saved')}
          </CheckboxRow>
          <Button variant="pri" full disabled={!saved} loading={busy} onClick={() => void finish()}>
            {t('setup2fa.codes.finish', { app: branding.appName })}
          </Button>
        </>
      ) : (
        <>
          <Heading title={t('setup2fa.title')} subtitle={t('setup2fa.subtitle')} />
          {from !== 'account' ? (
            <Notice tone="warn" icon="shield">
              {t('setup2fa.policy', { org: branding.orgName })}
            </Notice>
          ) : null}
          {error || enableError ? <Notice tone="error">{error ?? enableError}</Notice> : null}
          {phase === 'password' ? (
            <form
              className="flex flex-col gap-3"
              onSubmit={(e: FormEvent) => {
                e.preventDefault();
                start(password);
              }}
            >
              <Field label={t('setup2fa.confirmPassword')}>
                <Input
                  icon="lock"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoFocus
                />
              </Field>
              <Button type="submit" variant="pri" loading={enable.isFetching} disabled={!password}>
                {t('common.actions.continue')}
              </Button>
            </form>
          ) : (
            <>
              <div className="flex flex-col gap-3">
                <span className="text-sm font-semibold">{t('setup2fa.scan')}</span>
                <div className="flex items-start gap-5">
                  <div className="size-[156px] shrink-0 rounded-[14px] bg-white p-2.5 shadow-line2">
                    {qr ? (
                      <div
                        role="img"
                        aria-label={t('setup2fa.qrAlt')}
                        className="size-full [&>svg]:size-full"
                        // Generated locally by the qrcode library from the otpauth URI.
                        dangerouslySetInnerHTML={{ __html: qr }}
                      />
                    ) : (
                      <Skeleton className="size-full" />
                    )}
                  </div>
                  <div className="flex min-w-0 flex-col gap-2 text-cap text-fg2">
                    <span>{t('setup2fa.manual')}</span>
                    <span className="rounded-md bg-bg2 px-3 py-2 font-mono text-sm font-medium tracking-[.06em] text-fg">
                      {uri ? totpSecretFromUri(uri) : ''}
                    </span>
                    <span>
                      {t('setup2fa.account', {
                        org: branding.orgName,
                        email: me?.user.email ?? '',
                      })}
                    </span>
                  </div>
                </div>
              </div>
              <div className="flex flex-col gap-3">
                <span className="text-sm font-semibold">{t('setup2fa.enterCode')}</span>
                <OtpInput
                  aria-label={t('auth.twoFactor.codeLabel')}
                  value={code}
                  onChange={setCode}
                  onComplete={(v) => void verify(v)}
                  size="sm"
                  invalid={Boolean(error)}
                />
              </div>
              <Button
                variant="pri"
                full
                loading={busy}
                disabled={code.length !== 6}
                onClick={() => void verify()}
              >
                {t('setup2fa.verify')}
              </Button>
            </>
          )}
          <button
            type="button"
            onClick={() => void passkeyInstead()}
            className="flex items-center gap-2 self-start text-cap font-medium text-fg2 hover:text-fg"
          >
            <Icon name="finger" size={16} />
            {t('setup2fa.passkeyInstead')}
          </button>
        </>
      )}
    </AuthLayout>
  );
}

function Heading({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <h1 className="m-0 text-[26px] leading-8 font-bold tracking-[-.02em]">{title}</h1>
      <p className="m-0 text-sm text-fg2">{subtitle}</p>
    </div>
  );
}

function Stepper({ phase }: { phase: Phase }) {
  const { t } = useI18n();
  const second = phase === 'codes';
  return (
    <div className="flex items-center gap-2 text-[12.5px] leading-4 font-medium text-fg3">
      <span
        className={
          second
            ? 'flex size-5 items-center justify-center rounded-full bg-fg text-bg'
            : 'flex size-5 items-center justify-center rounded-full text-fg shadow-[inset_0_0_0_2px_var(--accent)]'
        }
      >
        {second ? <Icon name="check" size={11} strokeWidth={3} /> : '1'}
      </span>
      <b className={second ? 'font-medium' : 'font-semibold text-fg'}>{t('setup2fa.step1')}</b>
      <span className="h-px w-[22px] bg-line2" />
      <span
        className={
          second
            ? 'flex size-5 items-center justify-center rounded-full text-fg shadow-[inset_0_0_0_2px_var(--accent)]'
            : 'flex size-5 items-center justify-center rounded-full shadow-[inset_0_0_0_1.5px_var(--line2)]'
        }
      >
        2
      </span>
      <b className={second ? 'font-semibold text-fg' : 'font-medium'}>{t('setup2fa.step2')}</b>
    </div>
  );
}
