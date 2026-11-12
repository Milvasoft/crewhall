import { type SignInDiscovery } from '@crewhall/shared';
import { Button, Icon } from '@crewhall/ui';
import { useState } from 'react';
import { Notice } from '@/components/auth/AuthLayout';
import { useI18n } from '@/lib/i18n/I18nContext';
import { loginPath, ssoStartUrl, startSso } from '@/lib/identity/sso';
import { safeRedirect } from '@/lib/redirect';

export interface SsoProviderRef {
  id: string;
  name: string;
  kind: 'oidc' | 'saml';
}

/** Starts SSO with a provider and keeps the login's redirect target (e.g. `/mobile-login?…`). */
export function useSsoStart(redirect: string | undefined) {
  const [leaving, setLeaving] = useState<string | null>(null);
  return {
    leaving,
    start(providerId: string, loginHint?: string) {
      setLeaving(providerId);
      const url = ssoStartUrl(providerId, {
        callbackPath: safeRedirect(redirect),
        errorPath: loginPath(redirect),
        loginHint,
      });
      void startSso(url).catch(() => setLeaving(null));
    },
  };
}

/** "<IdP> ile giriş yap" buttons from `bootstrap.auth.sso` (design 01 · 1.1 form column). */
export function SsoButtons({
  providers,
  leaving,
  onStart,
  primary,
}: {
  providers: SsoProviderRef[];
  leaving: string | null;
  onStart: (providerId: string) => void;
  /** The first button is the screen's primary action (no password form). */
  primary?: boolean;
}) {
  const { t } = useI18n();
  if (providers.length === 0) return null;
  return (
    <div className="flex flex-col gap-2.5">
      {providers.map((p, i) => (
        <Button
          key={p.id}
          variant={primary && i === 0 ? 'pri' : 'out'}
          full
          loading={leaving === p.id}
          disabled={leaving !== null && leaving !== p.id}
          onClick={() => onStart(p.id)}
        >
          <Icon name={p.kind === 'saml' ? 'shield' : 'key'} size={18} />
          {t('identity.login.ssoWith', { name: p.name })}
        </Button>
      ))}
    </div>
  );
}

/** Discovery said this e-mail domain signs in through an IdP. */
export function DomainSsoNotice({
  discovery,
  leaving,
  onStart,
}: {
  discovery: SignInDiscovery;
  leaving: string | null;
  onStart: (providerId: string) => void;
}) {
  const { t } = useI18n();
  const p = discovery.provider;
  if (discovery.method !== 'sso' || !p) return null;
  return (
    <Notice tone="info" icon="key">
      <div className="flex flex-col gap-2.5">
        <span>{t('identity.login.domainSso', { name: p.name })}</span>
        <Button variant="inv" size="sm" loading={leaving === p.id} onClick={() => onStart(p.id)}>
          {t('identity.login.continueWith', { name: p.name })}
        </Button>
      </div>
    </Notice>
  );
}
