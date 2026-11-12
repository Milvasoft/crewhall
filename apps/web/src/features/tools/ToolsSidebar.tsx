import { cn, Icon } from '@crewhall/ui';
import { Link } from '@tanstack/react-router';
import { useMemo } from 'react';
import { ModuleSidebar } from '@/components/shell/ModuleSidebar';
import { useI18n } from '@/lib/i18n/I18nContext';
import { categoryKey, useLocalizedTool } from './i18n';
import { getAllDefinitions, getDefinition } from './lib/registry';
import { useFavorites } from './lib/preferences/hooks';
import { CATEGORIES, type ToolCategoryId } from './lib/tool-sdk';

const ROW =
  'flex h-[var(--nv-h)] shrink-0 items-center gap-2.5 rounded-sm px-2.5 text-[13.5px] leading-[18px] font-medium text-fg2 hover:bg-bg2 hover:text-fg';
const ACTIVE = 'bg-capsule font-semibold text-fg';

/** Tools sidebar: all tools, favorites (by name) and the twelve categories with counts. */
export function ToolsSidebar({ category, toolId }: { category?: ToolCategoryId; toolId?: string }) {
  const { t } = useI18n();
  const localize = useLocalizedTool();
  const { favorites } = useFavorites();
  const counts = useMemo(() => {
    const out = new Map<ToolCategoryId, number>();
    for (const d of getAllDefinitions()) out.set(d.category, (out.get(d.category) ?? 0) + 1);
    return out;
  }, []);
  const favs = favorites
    .map((id) => getDefinition(id))
    .filter((d) => d !== undefined)
    .map(localize);

  return (
    <ModuleSidebar label={t('tools.title')} className="gap-px overflow-y-auto px-2.5 py-3">
      <Link
        to="/tools"
        search={{}}
        className={cn(ROW, !category && !toolId && ACTIVE)}
        activeOptions={{ exact: true, includeSearch: true }}
      >
        <Icon name="tool" size={16} />
        <span className="min-w-0 flex-1 truncate">{t('tools.nav.home')}</span>
      </Link>
      {favs.length > 0 ? (
        <>
          <span className="eyebrow mt-3 mb-1 px-2.5">{t('tools.nav.favorites')}</span>
          {favs.map((d) => (
            <Link
              key={d.id}
              to="/tools/$toolId"
              params={{ toolId: d.id }}
              className={cn(ROW, toolId === d.id && ACTIVE)}
            >
              <Icon name="star" size={15} className="text-accent-text" fill="currentColor" />
              <span className="min-w-0 flex-1 truncate">{d.name}</span>
            </Link>
          ))}
        </>
      ) : null}
      <span className="eyebrow mt-3 mb-1 px-2.5">{t('tools.nav.categories')}</span>
      {CATEGORIES.map((c) => (
        <Link
          key={c.id}
          to="/tools"
          search={{ category: c.id }}
          className={cn(ROW, category === c.id && ACTIVE)}
        >
          <span className="min-w-0 flex-1 truncate">{t(categoryKey(c.id, 'name'))}</span>
          <span className="text-xs text-fg3 tn">{counts.get(c.id) ?? 0}</span>
        </Link>
      ))}
    </ModuleSidebar>
  );
}
