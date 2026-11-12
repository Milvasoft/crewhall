import { localize } from '@crewhall/plugin-sdk';
import { cn, Icon } from '@crewhall/ui';
import { useI18n } from '@/lib/i18n/I18nContext';
import { PluginFrame } from './PluginFrame';
import { usePluginSurfaces } from './surfaces';

const HEIGHT = {
  s: { min: 120, max: 240 },
  m: { min: 200, max: 420 },
  l: { min: 280, max: 640 },
} as const;

/** Home cards of the org's plugins, under the personal surface (docs/contracts/eklentiler.md). */
export function PluginCards() {
  const { t, locale } = useI18n();
  const cards = usePluginSurfaces().flatMap((s) => s.cards.map((card) => ({ s, card })));
  if (cards.length === 0) return null;
  return (
    <section aria-label={t('plugins.home.cards')} className="mt-6 flex flex-col gap-3">
      <h2 className="eyebrow m-0">{t('plugins.home.cards')}</h2>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {cards.map(({ s, card }) => (
          <article
            key={`${s.installationId}:${card.id}`}
            className={cn(
              'flex flex-col overflow-hidden rounded-2xl bg-surface shadow-line',
              card.size === 'l' && 'md:col-span-2',
            )}
          >
            <header className="flex h-10 items-center gap-2 px-4 text-cap font-semibold">
              {s.icon ? (
                <img
                  src={s.icon}
                  alt=""
                  className="size-4 rounded-xs"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <Icon name="plug" size={15} />
              )}
              <span className="truncate">{localize(card.title, locale)}</span>
            </header>
            <PluginFrame surface={s} entry={card} placement="card" autoHeight={HEIGHT[card.size]} />
          </article>
        ))}
      </div>
    </section>
  );
}
