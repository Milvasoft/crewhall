import { pagePath } from '@crewhall/shared';
import { Button, EmptyState, Icon, Skeleton } from '@crewhall/ui';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect } from 'react';
import { Workspace } from '@/components/shell/Workspace';
import { spaceName } from '@/components/spaces/spaceUtils';
import { formatRelative } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { rememberSpace, useSpaces } from '@/lib/useSpaces';
import { pageTreeQuery } from '@/lib/wiki/api';
import { openWikiDialog } from './dialogs';
import { WikiDialogs } from './WikiDialogs';
import { useCreatePage } from './useCreatePage';
import { WikiSidebar } from './WikiSidebar';

/** Pages of a space: recently changed pages and the ways to start one. */
export function SpaceHome({ spaceSlug }: { spaceSlug: string }) {
  const { t, locale } = useI18n();
  const { bySlug } = useSpaces();
  const space = bySlug(spaceSlug);
  const tree = useQuery({ ...pageTreeQuery(space?.id ?? ''), enabled: Boolean(space) });
  const create = useCreatePage();
  useEffect(() => rememberSpace(spaceSlug), [spaceSlug]);
  const recent = [...(tree.data?.items ?? [])]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 24);

  return (
    <Workspace
      sidebar={<WikiSidebar space={space} />}
      crumbs={[{ label: space ? spaceName(space, t) : '' }, { label: t('shell.modules.pages') }]}
      searchLabel={t('wiki.search.placeholder')}
    >
      <WikiDialogs />
      <div className="mx-auto flex w-full max-w-[860px] flex-col gap-5">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="mr-auto text-wtitle font-bold">{t('wiki.home.title')}</h1>
          {space && tree.data?.canCreate ? (
            <>
              <Button
                size="sm"
                variant="out"
                onClick={() =>
                  openWikiDialog({ kind: 'import', spaceId: space.id, parentId: null })
                }
              >
                <Icon name="upload" size={16} /> {t('wiki.home.import')}
              </Button>
              <Button
                size="sm"
                variant="out"
                onClick={() =>
                  openWikiDialog({ kind: 'templates', spaceId: space.id, parentId: null })
                }
              >
                <Icon name="layers" size={16} /> {t('wiki.home.templates')}
              </Button>
              <Button size="sm" variant="pri" onClick={() => void create(space.id, null)}>
                <Icon name="plus" size={16} /> {t('wiki.nav.newPage')}
              </Button>
            </>
          ) : null}
        </div>
        {tree.isPending ? (
          <div className="grid grid-cols-3 gap-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-24" />
            ))}
          </div>
        ) : recent.length === 0 ? (
          <EmptyState
            className="mt-10"
            icon="page"
            title={t('wiki.home.emptyTitle')}
            description={t('wiki.home.emptyBody')}
          >
            {space && tree.data?.canCreate ? (
              <Button variant="inv" onClick={() => void create(space.id, null)}>
                {t('wiki.nav.newPage')}
              </Button>
            ) : null}
          </EmptyState>
        ) : (
          <>
            <span className="eyebrow">{t('wiki.home.recent')}</span>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3">
              {recent.map((p) => (
                <Link
                  key={p.id}
                  to="/p/$pageRef"
                  params={{ pageRef: pagePath(p).slice(3) }}
                  className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-4 hover:shadow-overlay"
                >
                  <span className="text-[22px] leading-none">
                    {p.icon ?? <Icon name="page" size={22} />}
                  </span>
                  <span className="truncate text-[15px] font-semibold">{p.name}</span>
                  <span className="text-cap text-fg3">{formatRelative(p.updatedAt, locale)}</span>
                </Link>
              ))}
            </div>
          </>
        )}
      </div>
    </Workspace>
  );
}
