import { type Space } from '@crewhall/shared';
import { cn, Icon, type IconName } from '@crewhall/ui';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';
import { SpaceSidebar } from '@/components/spaces/SpaceSidebar';
import { boardsQuery, myCardsQuery } from '@/lib/boards/api';
import { useI18n } from '@/lib/i18n/I18nContext';
import { usePermissions } from '@/lib/session';
import { NewBoardDialog } from './NewBoardDialog';

/**
 * Boards sidebar (design 6.1): the space's boards with open card counts, the personal
 * views, new board, archived cards (of the open board) and the Drive trash.
 */
export function BoardsSidebar({
  space,
  activeBoardId,
  activeView,
  onArchived,
}: {
  space: Space | undefined;
  activeBoardId?: string;
  activeView?: 'mine' | 'upcoming' | 'workload';
  onArchived?: () => void;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { canSpace } = usePermissions();
  const [creating, setCreating] = useState(false);
  const boards = useQuery({ ...boardsQuery(space?.id ?? ''), enabled: Boolean(space) });
  const mine = useQuery({ ...myCardsQuery({ spaceId: space?.id }), enabled: Boolean(space) });
  const due = useQuery({
    ...myCardsQuery({ spaceId: space?.id, scope: 'due' }),
    enabled: Boolean(space),
  });
  const canCreate = space ? canSpace('space.edit_content', space.myRole) : false;

  return (
    <SpaceSidebar
      space={space}
      onSelect={(s) => void navigate({ to: '/boards/$spaceSlug', params: { spaceSlug: s.slug } })}
    >
      <div className="mt-2 flex min-h-0 flex-1 flex-col gap-px overflow-y-auto">
        <span className="eyebrow mt-1 mb-1 px-2.5">{t('boards.nav.boards')}</span>
        {boards.data?.items.map((b) => (
          <Item
            key={b.id}
            icon="board"
            active={b.id === activeBoardId}
            to="/b/$boardId"
            params={{ boardId: b.id }}
            label={b.name}
            count={b.cardCount}
          />
        ))}
        {boards.data && boards.data.items.length === 0 ? (
          <p className="px-2.5 py-1 text-xs text-fg3">{t('boards.nav.noBoards')}</p>
        ) : null}
        <span className="eyebrow mt-3 mb-1 px-2.5">{t('boards.nav.views')}</span>
        {space ? (
          <>
            <Item
              icon="user"
              active={activeView === 'mine'}
              to="/boards/$spaceSlug"
              params={{ spaceSlug: space.slug }}
              search={{ view: 'mine' }}
              label={t('boards.nav.assigned')}
              count={mine.data?.items.length}
            />
            <Item
              icon="clock"
              active={activeView === 'upcoming'}
              to="/boards/$spaceSlug"
              params={{ spaceSlug: space.slug }}
              search={{ view: 'upcoming' }}
              label={t('boards.nav.dueSoon')}
              count={due.data?.items.length}
            />
            <Item
              icon="users"
              active={activeView === 'workload'}
              to="/boards/$spaceSlug"
              params={{ spaceSlug: space.slug }}
              search={{ view: 'workload' }}
              label={t('boards.nav.workload')}
            />
          </>
        ) : null}
        <div className="mt-3 flex flex-col gap-px">
          {canCreate ? (
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="flex h-[var(--nv-h)] items-center gap-2.5 rounded-sm px-2.5 text-[13.5px] font-medium text-fg2 hover:bg-bg2 hover:text-fg"
            >
              <Icon name="plus" size={16} />
              {t('boards.nav.newBoard')}
            </button>
          ) : null}
          {onArchived ? (
            <button
              type="button"
              onClick={onArchived}
              className="flex h-[var(--nv-h)] items-center gap-2.5 rounded-sm px-2.5 text-[13.5px] font-medium text-fg2 hover:bg-bg2 hover:text-fg"
            >
              <Icon name="archive" size={16} />
              {t('boards.nav.archived')}
            </button>
          ) : null}
          {space ? (
            <>
              <Item
                icon="trash"
                to="/drive/$spaceSlug/trash"
                params={{ spaceSlug: space.slug }}
                label={t('boards.nav.trash')}
              />
            </>
          ) : null}
        </div>
      </div>
      {space ? (
        <NewBoardDialog space={space} open={creating} onClose={() => setCreating(false)} />
      ) : null}
    </SpaceSidebar>
  );
}

/** A sidebar row link (boards and drawings menus). */
export function Item({
  icon,
  label,
  count,
  active,
  ...link
}: {
  icon: IconName;
  label: ReactNode;
  count?: number;
  active?: boolean;
  to: string;
  params?: Record<string, string>;
  search?: Record<string, string>;
}) {
  return (
    <Link
      {...(link as { to: '/' })}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex h-[var(--nv-h)] shrink-0 items-center gap-2.5 rounded-sm px-2.5 text-[13.5px] leading-[18px] font-medium',
        active ? 'bg-capsule font-semibold text-fg' : 'text-fg2 hover:bg-bg2 hover:text-fg',
      )}
    >
      <Icon name={icon} size={16} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count ? <span className="text-xs text-fg3 tn">{count}</span> : null}
    </Link>
  );
}
