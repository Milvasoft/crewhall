import { Input } from '@crewhall/ui';
import { Link, useNavigate } from '@tanstack/react-router';
import { useMemo } from 'react';
import { Workspace } from '@/components/shell/Workspace';
import { useI18n } from '@/lib/i18n/I18nContext';
import { ExecutionBadge } from './components/ui/ExecutionBadge';
import { FavoriteButton } from './components/ui/FavoriteButton';
import { categoryKey, useLocalizedTool, type LocalizedTool } from './i18n';
import { getAllDefinitions, getDefinition, searchTools } from './lib/registry';
import { useFavorites, useRecents } from './lib/preferences/hooks';
import { CATEGORIES, type ToolCategoryId } from './lib/tool-sdk';
import { ToolsSidebar } from './ToolsSidebar';

/** /tools: search, favorites and recents, then every tool by category (or one category). */
export function ToolsHome({ category, q }: { category?: ToolCategoryId; q?: string }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const localize = useLocalizedTool();
  const { favorites } = useFavorites();
  const { recents } = useRecents();
  const all = useMemo(() => getAllDefinitions().map(localize), [localize]);
  const query = q ?? '';
  const hits = useMemo(
    () => (query.trim() ? searchTools(query, all).map((r) => r.definition as LocalizedTool) : null),
    [query, all],
  );
  const pick = (ids: string[]) =>
    ids
      .map((id) => getDefinition(id))
      .filter((d) => d !== undefined)
      .map(localize);
  const set = (next: { q?: string }) =>
    void navigate({ to: '/tools', search: { category, q: next.q || undefined }, replace: true });
  const shownCategories = category ? CATEGORIES.filter((c) => c.id === category) : CATEGORIES;

  return (
    <Workspace
      sidebar={<ToolsSidebar category={category} />}
      crumbs={[
        { label: t('tools.title') },
        ...(category ? [{ label: t(categoryKey(category, 'name')) }] : []),
      ]}
    >
      <div className="flex flex-col gap-1">
        <h1 className="m-0 text-wtitle font-bold">
          {category ? t(categoryKey(category, 'name')) : t('tools.title')}
        </h1>
        <p className="m-0 text-sm text-fg2">
          {category ? t(categoryKey(category, 'description')) : t('tools.home.subtitle')}
        </p>
      </div>
      <Input
        autoFocus
        icon="search"
        size="lg"
        value={query}
        onChange={(e) => set({ q: e.target.value })}
        placeholder={t('tools.home.search')}
        aria-label={t('tools.home.search')}
      />
      {hits ? (
        hits.length ? (
          <ToolGrid label={t('tools.home.all')} tools={hits} />
        ) : (
          <p className="m-0 py-10 text-center text-sm text-fg3">
            {t('tools.home.noResults', { q: query.trim() })}
          </p>
        )
      ) : (
        <>
          {!category && favorites.length ? (
            <ToolGrid label={t('tools.home.favorites')} tools={pick(favorites)} />
          ) : null}
          {!category && recents.length ? (
            <ToolGrid label={t('tools.home.recent')} tools={pick(recents.slice(0, 6))} />
          ) : null}
          {shownCategories.map((c) => (
            <ToolGrid
              key={c.id}
              label={t(categoryKey(c.id, 'name'))}
              tools={all.filter((d) => d.category === c.id)}
            />
          ))}
        </>
      )}
    </Workspace>
  );
}

function ToolGrid({ label, tools }: { label: string; tools: LocalizedTool[] }) {
  return (
    <section aria-label={label} className="flex flex-col gap-2.5">
      <h2 className="eyebrow m-0">{label}</h2>
      <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-2.5 p-0">
        {tools.map((d) => (
          <li key={d.id} className="relative">
            <Link
              to="/tools/$toolId"
              params={{ toolId: d.id }}
              className="flex h-full flex-col gap-1 rounded-xl bg-surface px-3.5 py-3 pr-10 shadow-line hover:shadow-line2"
            >
              <span className="truncate text-cap font-semibold">{d.name}</span>
              <span className="line-clamp-2 text-xs text-fg2">{d.description}</span>
              <ExecutionBadge execution={d.execution} className="mt-1 self-start" />
            </Link>
            <FavoriteButton toolId={d.id} className="absolute top-2 right-2" />
          </li>
        ))}
      </ul>
    </section>
  );
}
