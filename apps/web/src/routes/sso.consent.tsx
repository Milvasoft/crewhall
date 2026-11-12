import { OidcAuthorizeRequest, type OidcConsentInfo, type OidcScope } from '@crewhall/shared';
import { Button, CrewhallMark, Icon, Skeleton, type IconName } from '@crewhall/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { z } from 'zod';
import { AuthLayout, Notice, WhoRow } from '@/components/auth/AuthLayout';
import { AppMark } from '@/components/identity/parts';
import { api, isApiError } from '@/lib/api';
import { signOut } from '@/lib/auth/auth';
import { useI18n } from '@/lib/i18n/I18nContext';
import { oidcConsentQuery } from '@/lib/identity/queries';
import { meQuery } from '@/lib/queries';
import { useBootstrap } from '@/lib/useBranding';

/** Every authorize parameter is optional here; the page validates the whole request itself. */
const Search = z.object(
  Object.fromEntries(
    Object.keys(OidcAuthorizeRequest.shape).map((k) => [k, z.string().optional()]),
  ) as Record<keyof OidcAuthorizeRequest, z.ZodOptional<z.ZodString>>,
);

export const Route = createFileRoute('/sso/consent')({
  validateSearch: Search,
  // Signed out: the normal sign-in (password + 2FA, passkey or SSO) first, then back here.
  beforeLoad: async ({ context: { queryClient }, location }) => {
    try {
      await queryClient.ensureQueryData(meQuery);
    } catch (e) {
      if (isApiError(e, 'unauthenticated')) {
        throw redirect({ to: '/login', search: { redirect: location.href } });
      }
      throw e;
    }
  },
  component: SsoConsentPage,
});

const SCOPE_ICON: Record<OidcScope, IconName> = {
  openid: 'id',
  profile: 'user',
  email: 'mail',
  groups: 'users',
  offline_access: 'refresh',
};

/**
 * Consent of Crewhall as an OpenID Connect provider (design 01 layout, 9.12): another app of
 * the org asks to sign the person in. Internal apps and earlier grants skip the screen.
 */
function SsoConsentPage() {
  const { t } = useI18n();
  const search = Route.useSearch();
  const parsed = OidcAuthorizeRequest.safeParse(search);
  if (!parsed.success) {
    return (
      <Problem title={t('identity.consent.invalidTitle')} body={t('errors.oidc_consent_invalid')} />
    );
  }
  return <Consent request={parsed.data} />;
}

function Problem({ title, body, children }: { title: string; body: string; children?: ReactNode }) {
  return (
    <AuthLayout>
      <span className="flex size-12 items-center justify-center rounded-[14px] bg-[color-mix(in_srgb,var(--danger)_12%,transparent)] text-danger">
        <Icon name="alert" size={24} />
      </span>
      <div className="flex flex-col gap-1.5">
        <h1 className="m-0 text-[26px] leading-8 font-bold tracking-[-.02em]">{title}</h1>
        <p className="m-0 text-sm text-fg2">{body}</p>
      </div>
      {children}
    </AuthLayout>
  );
}

function Leaving({ client }: { client: string }) {
  const { t } = useI18n();
  return (
    <AuthLayout>
      <div className="flex items-center gap-3 text-sm text-fg2" role="status">
        <Icon name="refresh" size={18} className="animate-spin" />
        {t('identity.consent.returning', { client })}
      </div>
    </AuthLayout>
  );
}

function Consent({ request }: { request: OidcAuthorizeRequest }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const consent = useQuery(oidcConsentQuery(request));
  const twoFactor = consent.isError && isApiError(consent.error, 'two_factor_required');

  useEffect(() => {
    // The org requires 2FA and this person has none yet: enrol first (01 · 1.14).
    if (twoFactor) void navigate({ to: '/security/2fa-setup', search: { from: 'policy' } });
  }, [twoFactor, navigate]);

  if (consent.isError) {
    const e = consent.error;
    if (twoFactor) return <Leaving client="" />;
    if (isApiError(e, 'oidc_access_denied')) {
      return (
        <Problem title={t('identity.consent.deniedTitle')} body={t('errors.oidc_access_denied')} />
      );
    }
    return (
      <Problem
        title={t('identity.consent.invalidTitle')}
        body={isApiError(e) ? t(`errors.${e.code}`) : t('errors.internal')}
      />
    );
  }
  if (!consent.data) {
    return (
      <AuthLayout>
        <Skeleton className="h-10 w-2/3" />
        <Skeleton className="h-12" />
        <Skeleton className="h-48" />
      </AuthLayout>
    );
  }
  return <ConsentForm request={request} info={consent.data} />;
}

function ConsentForm({ request, info }: { request: OidcAuthorizeRequest; info: OidcConsentInfo }) {
  const { t } = useI18n();
  const { branding } = useBootstrap();
  const qc = useQueryClient();
  const [leaving, setLeaving] = useState(false);
  const client = info.client.name;
  const auto = useRef(false);

  const body = { ...request, consentToken: info.consentToken };
  const finish = (redirectTo: string) => {
    setLeaving(true);
    window.location.assign(redirectTo);
  };
  const approve = useMutation({
    mutationFn: () => api.call('approveOidcConsent', { body }),
    onSuccess: (res) => finish(res.redirectTo),
  });
  const deny = useMutation({
    mutationFn: () => api.call('denyOidcConsent', { body }),
    onSuccess: (res) => finish(res.redirectTo),
  });

  useEffect(() => {
    // Internal app or an earlier grant: approve without showing the screen.
    if (info.autoApprove && !auto.current) {
      auto.current = true;
      approve.mutate();
    }
  }, [info.autoApprove, approve]);

  async function otherAccount() {
    await signOut();
    qc.clear();
    window.location.reload();
  }

  const failure = approve.error ?? deny.error;
  const error = failure
    ? isApiError(failure)
      ? t(`errors.${failure.code}`)
      : t('errors.internal')
    : null;

  if (leaving || (info.autoApprove && !failure)) return <Leaving client={client} />;

  return (
    <AuthLayout footer={t('identity.consent.footer')}>
      <div className="flex items-center gap-2">
        <AppMark name={client} logoUrl={info.client.logoUrl} size={40} className="rounded-[11px]" />
        <span className="w-8 border-t-2 border-dotted border-line2" />
        <span className="flex size-10 items-center justify-center rounded-[11px] bg-bg2 text-fg">
          {branding.markUrl ? (
            <img src={branding.markUrl} alt="" className="size-7 rounded-sm" />
          ) : (
            <CrewhallMark size={24} />
          )}
        </span>
      </div>
      <div className="flex flex-col gap-1.5">
        <h1 className="m-0 text-[24px] leading-[30px] font-bold tracking-[-.02em]">
          {t('identity.consent.title', { client, org: info.user.orgName })}
        </h1>
        <p className="m-0 text-cap text-fg2">
          {t('identity.consent.redirect')}{' '}
          <code className="font-mono text-xs break-all text-fg">{info.client.redirectHost}</code>
        </p>
      </div>
      <WhoRow
        name={info.user.name}
        email={`${info.user.email} · ${info.user.orgName}`}
        action={
          <Button size="xs" variant="gh" onClick={() => void otherAccount()}>
            {t('identity.consent.change')}
          </Button>
        }
      />
      <div className="flex flex-col gap-1.5">
        <span className="text-cap font-semibold">{t('identity.consent.what', { client })}</span>
        <ul className="m-0 flex list-none flex-col overflow-hidden rounded-lg p-0 shadow-line2">
          {info.scopes.map((s) => (
            <li
              key={s.scope}
              className="flex min-h-11 items-center gap-2.5 border-b border-line px-3 py-2 last:border-b-0"
            >
              <Icon name={SCOPE_ICON[s.scope]} size={16} className="text-fg2" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-cap font-semibold">
                  {t(`identity.scopes.${s.scope}.title`)}
                </span>
                <span className="text-xs text-fg2">{t(`identity.scopes.${s.scope}.body`)}</span>
              </span>
              {s.required ? (
                <span className="text-tag text-fg3">{t('identity.consent.required')}</span>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
      <Notice tone="info" icon="lock">
        {t('identity.consent.noPassword', { client })}
      </Notice>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className="grid grid-cols-2 gap-3">
        <Button
          variant="out"
          loading={deny.isPending}
          disabled={approve.isPending}
          onClick={() => deny.mutate()}
        >
          {t('identity.consent.deny')}
        </Button>
        <Button
          variant="pri"
          loading={approve.isPending}
          disabled={deny.isPending}
          onClick={() => approve.mutate()}
        >
          {t('identity.consent.allow')}
        </Button>
      </div>
    </AuthLayout>
  );
}
