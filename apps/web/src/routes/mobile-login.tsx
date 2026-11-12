import { browserExtensionOf, isAllowedHandoffRedirect } from '@crewhall/shared';
import { Button, Icon, Skeleton, Spinner } from '@crewhall/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { useState } from 'react';
import { z } from 'zod';
import { AuthHeading, AuthLayout, Notice, WhoRow } from '@/components/auth/AuthLayout';
import { api, isApiError } from '@/lib/api';
import { signOut } from '@/lib/auth/auth';
import { openExternal } from '@/lib/external';
import { useI18n } from '@/lib/i18n/I18nContext';
import { meQuery } from '@/lib/queries';

const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

/** Same rule as the server, so a production build never offers to confirm an Expo Go link. */
const redirectAllowed = (uri: string) =>
  isAllowedHandoffRedirect(uri, { production: import.meta.env.PROD });

/** Appends `key=value` to a custom-scheme URI (no URL object: crewhall:// and exp:// are opaque). */
function withParam(uri: string, key: string, value: string): string {
  const [base, hash] = uri.split('#', 2) as [string, string | undefined];
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}${key}=${encodeURIComponent(value)}${hash !== undefined ? `#${hash}` : ''}`;
}

export const Route = createFileRoute('/mobile-login')({
  validateSearch: z.object({
    challenge: z.string().optional(),
    redirect: z.string().optional(),
  }),
  // Signed out: run the normal sign-in (password + 2FA or passkey) and come back here.
  beforeLoad: async ({ context: { queryClient }, location, search }) => {
    const valid = CHALLENGE.test(search.challenge ?? '') && redirectAllowed(search.redirect ?? '');
    if (!valid) return;
    try {
      await queryClient.ensureQueryData(meQuery);
    } catch (e) {
      if (isApiError(e, 'unauthenticated')) {
        throw redirect({ to: '/login', search: { redirect: location.href } });
      }
      throw e;
    }
  },
  component: MobileSignInPage,
});

/**
 * Browser half of the mobile sign-in (faz-0-kapanis §4): the app opens this page in the system
 * browser with a PKCE challenge; after confirmation the web asks for a one-time code and sends
 * the browser back to the app, which exchanges code + verifier for its own session.
 */
function MobileSignInPage() {
  const { t } = useI18n();
  const { challenge = '', redirect: redirectUri = '' } = Route.useSearch();
  const qc = useQueryClient();
  const valid = CHALLENGE.test(challenge) && redirectAllowed(redirectUri);
  const extension = browserExtensionOf(redirectUri) !== null;
  const key = (name: 'title' | 'subtitle' | 'confirm' | 'returning' | 'returningBody') =>
    extension ? (`mobileSignIn.extension.${name}` as const) : (`mobileSignIn.${name}` as const);
  const me = useQuery({ ...meQuery, enabled: valid, retry: false });
  const [leaving, setLeaving] = useState(false);

  const handoff = useMutation({
    mutationFn: () =>
      api.call('createMobileHandoff', { body: { codeChallenge: challenge, redirectUri } }),
    onSuccess: ({ code }) => {
      setLeaving(true);
      openExternal(withParam(redirectUri, 'code', code));
    },
  });

  if (!valid) {
    return (
      <AuthLayout>
        <span className="flex size-12 items-center justify-center rounded-[14px] bg-[color-mix(in_srgb,var(--danger)_12%,transparent)] text-danger">
          <Icon name="alert" size={24} />
        </span>
        <AuthHeading
          title={t('mobileSignIn.invalidTitle')}
          subtitle={t('mobileSignIn.invalidBody')}
        />
      </AuthLayout>
    );
  }

  if (leaving) {
    return (
      <AuthLayout>
        <div className="flex items-center gap-3">
          <Spinner />
          <AuthHeading
            title={t(key('returning'))}
            subtitle={t(key('returningBody'))}
          />
        </div>
      </AuthLayout>
    );
  }

  async function otherAccount() {
    await signOut();
    qc.clear();
    // Reload: the guard sends us through sign-in and back here with the same parameters.
    window.location.reload();
  }

  return (
    <AuthLayout>
      <span className="flex size-12 items-center justify-center rounded-[14px] bg-bg2 text-fg">
        <Icon name={extension ? 'globe' : 'phone'} size={24} />
      </span>
      <AuthHeading title={t(key('title'))} subtitle={t(key('subtitle'))} />
      {me.data ? (
        <WhoRow name={me.data.user.name} email={me.data.user.email} />
      ) : (
        <Skeleton className="h-12 w-full rounded-lg" />
      )}
      {handoff.isError ? (
        <Notice tone="error">
          {isApiError(handoff.error) ? t(`errors.${handoff.error.code}`) : t('errors.internal')}
        </Notice>
      ) : null}
      <Button
        variant="pri"
        full
        loading={handoff.isPending}
        disabled={!me.data}
        onClick={() => handoff.mutate()}
      >
        {t(key('confirm'))}
      </Button>
      <div className="flex items-center justify-between gap-3">
        <Button variant="gh" size="sm" onClick={() => void otherAccount()}>
          {t('mobileSignIn.otherAccount')}
        </Button>
        <Button
          variant="gh"
          size="sm"
          onClick={() => openExternal(withParam(redirectUri, 'error', 'access_denied'))}
        >
          {t('common.actions.cancel')}
        </Button>
      </div>
      <Notice tone="info" icon="shield">
        {t('mobileSignIn.note')}
      </Notice>
    </AuthLayout>
  );
}
