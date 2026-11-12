import { Button, EmptyState, Icon, Skeleton } from '@crewhall/ui';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link, notFound } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { z } from 'zod';
import { AssignedList } from '@/components/boards/AssignedList';
import { BoardsSidebar } from '@/components/boards/BoardsSidebar';
import { NewBoardDialog } from '@/components/boards/NewBoardDialog';
import { NodeListItem, useNodeListMenu } from '@/components/boards/NodeListMenu';
import { WorkloadView } from '@/components/boards/WorkloadView';
import { Workspace } from '@/components/shell/Workspace';
import { spaceName } from '@/components/spaces/spaceUtils';
import { boardKeys, boardsQuery } from '@/lib/boards/api';
import { formatRelative } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { cachedSpaceId, warm } from '@/lib/prefetch';
import { spacesQuery } from '@/lib/queries';
import { usePermissions } from '@/lib/session';
import { rememberSpace, useSpaces } from '@/lib/useSpaces';

/** Boards of a space (design 6.1 sidebar), or one of the personal views. */
export const Route = createFileRoute('/_app/boards/$spaceSlug')({
  validateSearch: z.object({
    view: z.enum(['mine', 'upcoming', 'workload']).optional().catch(undefined),
  }),
  beforeLoad: async ({ params, context: { queryClient } }) => {
    const { items } = await queryClient.ensureQueryData(spacesQuery());
    if (!items.some((s) => s.slug === params.spaceSlug)) throw notFound({ routeId: '/_app' });
  },
  loader: ({ params, context: { queryClient } }) => {
    const spaceId = cachedSpaceId(queryClient, params.spaceSlug);
    if (spaceId) warm(queryClient, boardsQuery(spaceId));
  },
  component: BoardsHome,
});

function BoardsHome() {
  const { t, locale } = useI18n();
  const { spaceSlug } = Route.useParams();
  const { view } = Route.useSearch();
  const { bySlug } = useSpaces();
  const { canSpace } = usePermissions();
  const space = bySlug(spaceSlug);
  const boards = useQuery({ ...boardsQuery(space?.id ?? ''), enabled: Boolean(space) });
  const [creating, setCreating] = useState(false);
  const menu = useNodeListMenu('board', boardKeys.list(space?.id ?? ''));
  useEffect(() => rememberSpace(spaceSlug), [spaceSlug]);
  if (!space) return null;
  const canCreate = canSpace('space.edit_content', space.myRole);

  return (
    <Workspace
      sidebar={<BoardsSidebar space={space} activeView={view} />}
      crumbs={[
        { label: spaceName(space, t) },
        {
          label:
            view === 'mine'
              ? t('boards.assigned.title')
              : view === 'upcoming'
                ? t('boards.assigned.dueTitle')
                : view === 'workload'
                  ? t('boards.workload.title')
                  : t('boards.title'),
        },
      ]}
      tools={
        canCreate && !view ? (
          <Button size="sm" variant="inv" onClick={() => setCreating(true)}>
            <Icon name="plus" size={16} />
            {t('boards.nav.newBoard')}
          </Button>
        ) : null
      }
    >
      {view === 'workload' ? (
        <section className="flex min-h-0 flex-1 flex-col gap-3">
          <h1 className="text-title font-bold">{t('boards.workload.title')}</h1>
          <WorkloadView source={{ spaceId: space.id }} />
        </section>
      ) : view ? (
        <section className="flex flex-col gap-3">
          <h1 className="text-title font-bold">
            {view === 'mine' ? t('boards.assigned.title') : t('boards.assigned.dueTitle')}
          </h1>
          <AssignedList scope={view === 'mine' ? 'assigned' : 'due'} spaceId={space.id} />
        </section>
      ) : (
        <section className="flex flex-col gap-4">
          <h1 className="text-title font-bold">
            {t('boards.home.title', { space: spaceName(space, t) })}
          </h1>
          {boards.isLoading ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
              <Skeleton className="h-28" />
              <Skeleton className="h-28" />
            </div>
          ) : boards.data?.items.length ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
              {boards.data.items.map((b) => (
                <NodeListItem key={b.id} item={b} myRole={space.myRole} menu={menu}>
                  {({ onKeyDown }) => (
                    <Link
                      to="/b/$boardId"
                      params={{ boardId: b.id }}
                      onKeyDown={onKeyDown}
                      className="flex flex-col gap-3 rounded-2xl bg-surface p-4 shadow-[0_0_0_1px_var(--line)] hover:shadow-[0_0_0_1px_var(--line2),var(--shSm)]"
                    >
                      <span className="flex items-center gap-2">
                        <span className="flex size-9 items-center justify-center rounded-lg bg-bg2">
                          <Icon name="board" size={18} />
                        </span>
                        <span className="font-mono text-xs text-fg3">{b.key}</span>
                      </span>
                      <span className="text-sub font-semibold text-fg">{b.name}</span>
                      <span className="text-xs text-fg3">
                        {t('boards.home.cards', { count: b.cardCount })} ·{' '}
                        {t('boards.home.updated', { date: formatRelative(b.updatedAt, locale) })}
                      </span>
                    </Link>
                  )}
                </NodeListItem>
              ))}
            </div>
          ) : (
            <EmptyState
              className="m-auto"
              icon="board"
              title={t('boards.home.empty')}
              description={t('boards.home.emptyBody')}
            >
              {canCreate ? (
                <Button variant="inv" size="sm" onClick={() => setCreating(true)}>
                  {t('boards.nav.newBoard')}
                </Button>
              ) : null}
            </EmptyState>
          )}
        </section>
      )}
      <NewBoardDialog space={space} open={creating} onClose={() => setCreating(false)} />
    </Workspace>
  );
}
