import { Button, Icon } from '@crewhall/ui';
import { AuthHeading } from '@/components/auth/AuthLayout';
import { useStoreUrl } from '@/components/common/OpenInAppBanner';
import { useI18n } from '@/lib/i18n/I18nContext';
import { appOpenUrl, launchApp, type MobilePlatform } from '@/lib/open-in-app';

/**
 * After an invitation is accepted in a phone browser: continue in the mobile app. The app gets
 * this server's home as `crewhall://open?url=`, picks the server from the address and signs in
 * there (password, or the browser sign-in through `/mobile-login`, which the app starts itself).
 */
export function ContinueInApp({
  platform,
  orgName,
  onStay,
}: {
  platform: MobilePlatform;
  orgName: string;
  onStay: () => void;
}) {
  const { t } = useI18n();
  const store = useStoreUrl(platform);

  return (
    <>
      <span className="flex size-12 items-center justify-center rounded-[14px] bg-accent text-accent-fg">
        <Icon name="phone" size={24} />
      </span>
      <AuthHeading
        title={t('openInApp.continue.title', { org: orgName })}
        subtitle={t('openInApp.continue.body')}
      />
      <Button
        variant="pri"
        full
        onClick={() => launchApp(appOpenUrl(`${window.location.origin}/`), store)}
      >
        {t('openInApp.continue.open')}
      </Button>
      {store ? (
        <Button variant="out" full asChild>
          <a href={store} rel="noreferrer noopener">
            {t('openInApp.continue.install')}
          </a>
        </Button>
      ) : null}
      <Button variant="gh" full onClick={onStay}>
        {t('openInApp.continue.stay')}
      </Button>
    </>
  );
}
