import { type PublicBootstrap } from '@crewhall/shared';
import { Icon } from '@crewhall/ui';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useBootstrap } from '@/lib/useBranding';
import { useNow } from '@/lib/useNow';

type DemoAccount = NonNullable<PublicBootstrap['demo']>['accounts'][number];

/** Live demo: the sample accounts on the sign-in page; a click fills the form. */
export function DemoAccounts({ onPick }: { onPick: (a: DemoAccount) => void }) {
  const { t } = useI18n();
  const demo = useBootstrap().data?.demo;
  if (!demo) return null;
  return (
    <section
      aria-label={t('identity.demo.accounts')}
      className="flex flex-col gap-2 rounded-xl bg-accent10 p-3.5"
    >
      <span className="flex items-center gap-1.5 text-cap font-semibold">
        <Icon name="sparkle" size={14} />
        {t('identity.demo.accounts')}
      </span>
      <span className="text-xs text-fg2">{t('identity.demo.accountsHint')}</span>
      <div className="flex flex-wrap gap-1.5">
        {demo.accounts.map((a) => (
          <button
            key={a.email}
            type="button"
            onClick={() => onPick(a)}
            className="flex h-8 items-center gap-1.5 rounded-full bg-surface px-3 text-cap font-medium shadow-line hover:bg-capsule"
          >
            {a.name}
            <span className="text-fg3">· {t(`common.roles.org.${a.role}`)}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

/** Live demo: a small reminder that the data goes back to the sample every hour. */
export function DemoBanner() {
  const { t } = useI18n();
  const demo = useBootstrap().data?.demo;
  const now = useNow(30_000);
  if (!demo) return null;
  const minutes = Math.max(0, Math.ceil((Date.parse(demo.resetAt) - now) / 60_000));
  return (
    <div
      role="status"
      className="pointer-events-none fixed bottom-3 left-1/2 z-40 -translate-x-1/2 rounded-full bg-fg px-3.5 py-1.5 text-xs font-semibold text-bg shadow-lg"
    >
      {t('identity.demo.banner', { minutes })}
    </div>
  );
}
