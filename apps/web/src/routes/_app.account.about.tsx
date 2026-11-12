import { createFileRoute } from '@tanstack/react-router';
import { PageHeader, SettingsCard } from '@/components/admin/Settings';
import { VersionLines } from '@/components/common/VersionLines';
import { Workspace } from '@/components/shell/Workspace';
import { useI18n } from '@/lib/i18n/I18nContext';

export const Route = createFileRoute('/_app/account/about')({
  component: AboutPage,
});

/**
 * Hesabım › Hakkında: the running versions, and the third-party works the product ships with
 * whose licenses ask for attribution (the full list is THIRD_PARTY_NOTICES.md at the repository root).
 */
const CREDITS = [
  {
    key: 'notoAnimated',
    name: 'Noto Animated Emoji',
    by: 'Google',
    license: 'CC BY 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    url: 'https://googlefonts.github.io/noto-emoji-animation/',
  },
  {
    key: 'emojibase',
    name: 'Emojibase',
    by: 'Miles Johnson',
    license: 'MIT',
    licenseUrl: 'https://github.com/milesj/emojibase/blob/master/LICENSE',
    url: 'https://emojibase.dev',
  },
  {
    key: 'cldr',
    name: 'Unicode CLDR',
    by: 'Unicode, Inc.',
    license: 'Unicode License v3',
    licenseUrl: 'https://www.unicode.org/license.txt',
    url: 'https://cldr.unicode.org',
  },
  {
    key: 'lottie',
    name: 'lottie-web',
    by: 'Airbnb',
    license: 'MIT',
    licenseUrl: 'https://github.com/airbnb/lottie-web/blob/master/LICENSE.md',
    url: 'https://github.com/airbnb/lottie-web',
  },
  // Copied source (features/tools/THIRD_PARTY.md); its home sits under the org's own account.
  {
    key: 'tooMuchTools',
    name: 'Too Much Tools',
    by: 'Too Much Tools contributors',
    license: 'MIT',
  },
] as const satisfies readonly Credit[];

type Credit = {
  key: string;
  name: string;
  by: string;
  license: string;
  licenseUrl?: string;
  url?: string;
};

/** An external link, or plain text when the credit has no public address. */
function Ref({
  href,
  className,
  children,
}: {
  href: string | undefined;
  className: string;
  children: string;
}) {
  return href ? (
    <a href={href} target="_blank" rel="noreferrer noopener" className={className}>
      {children}
    </a>
  ) : (
    <span>{children}</span>
  );
}

function AboutPage() {
  const { t } = useI18n();
  return (
    <Workspace crumbs={[{ label: t('account.title') }, { label: t('account.nav.about') }]}>
      <PageHeader title={t('account.about.title')} subtitle={t('account.about.subtitle')} />
      <div className="flex max-w-[860px] flex-col gap-5">
        <SettingsCard title={t('shell.version.title')}>
          <VersionLines />
        </SettingsCard>
        <SettingsCard title={t('account.about.credits')}>
          <p className="m-0 text-cap text-fg2">{t('account.about.creditsHint')}</p>
          <ul className="m-0 flex list-none flex-col divide-y divide-line p-0">
            {CREDITS.map((c) => (
              <li key={c.key} className="flex flex-col gap-0.5 py-3">
                <span className="text-sm font-semibold">
                  <Ref href={'url' in c ? c.url : undefined} className="hover:underline">
                    {c.name}
                  </Ref>{' '}
                  <span className="font-normal text-fg2">· {c.by}</span>
                </span>
                <span className="text-cap text-fg2">
                  {t(`account.about.uses.${c.key}`)} ·{' '}
                  <Ref
                    href={'licenseUrl' in c ? c.licenseUrl : undefined}
                    className="font-medium text-info underline-offset-2 hover:underline"
                  >
                    {c.license}
                  </Ref>
                </span>
              </li>
            ))}
          </ul>
          <p className="m-0 text-xs text-fg3">{t('account.about.others')}</p>
        </SettingsCard>
      </div>
    </Workspace>
  );
}
