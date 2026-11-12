// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/components/ui/FavoriteButton.tsx. See THIRD_PARTY.md.
import { Icon } from '@crewhall/ui';
import { useFavorites } from '@/features/tools/lib/preferences/hooks';
import { useI18n } from '@/lib/i18n/I18nContext';
import { cn } from './cn';

export function FavoriteButton({ toolId, className }: { toolId: string; className?: string }) {
  const { t } = useI18n();
  const { isFavorite, toggle } = useFavorites();
  const active = isFavorite(toolId);

  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        toggle(toolId);
      }}
      aria-pressed={active}
      aria-label={active ? t('tools.common.favoriteRemove') : t('tools.common.favoriteAdd')}
      title={active ? t('tools.common.favoriteRemove') : t('tools.common.favoriteAdd')}
      className={cn(
        'inline-flex h-7 w-7 items-center justify-center rounded-md text-sm transition-colors hover:bg-bg2',
        active ? 'text-accent-text' : 'text-fg3 hover:text-fg',
        className,
      )}
    >
      <Icon name="star" size={16} fill={active ? 'currentColor' : 'none'} />
    </button>
  );
}
