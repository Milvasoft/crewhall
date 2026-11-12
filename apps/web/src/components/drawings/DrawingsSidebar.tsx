import { type Space } from '@crewhall/shared';
import { Icon } from '@crewhall/ui';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Item } from '@/components/boards/BoardsSidebar';
import { SpaceSidebar } from '@/components/spaces/SpaceSidebar';
import { favoritesQuery, recentQuery } from '@/features/drive/api';
import { drawingsQuery } from '@/lib/boards/api';
import { useI18n } from '@/lib/i18n/I18nContext';
import { usePermissions } from '@/lib/session';
import { useNewDrawing } from './useNewDrawing';

const RECENT = 6;

/**
 * Drawings sidebar (own module since 2026-10-29): the space selector, the space's drawings,
 * recently opened and favourite drawings across spaces, a new drawing and the Drive trash.
 */
export function DrawingsSidebar({
  space,
  activeDrawingId,
}: {
  space: Space | undefined;
  activeDrawingId?: string;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { canSpace } = usePermissions();
  const { create, busy } = useNewDrawing();
  const list = useQuery({ ...drawingsQuery(space?.id ?? ''), enabled: Boolean(space) });
  const recent = useQuery(recentQuery);
  const favorites = useQuery(favoritesQuery);
  const recentDrawings = (recent.data?.items ?? [])
    .filter((n) => n.type === 'drawing')
    .slice(0, RECENT);
  const favoriteDrawings = (favorites.data?.items ?? []).filter((n) => n.type === 'drawing');
  const canCreate = space ? canSpace('space.edit_content', space.myRole) : false;

  return (
    <SpaceSidebar
      space={space}
      onSelect={(s) => void navigate({ to: '/drawings/$spaceSlug', params: { spaceSlug: s.slug } })}
    >
      <div className="mt-2 flex min-h-0 flex-1 flex-col gap-px overflow-y-auto">
        <span className="eyebrow mt-1 mb-1 px-2.5">{t('boards.drawings.nav.all')}</span>
        {list.data?.items.map((d) => (
          <Item
            key={d.id}
            icon="vector"
            active={d.id === activeDrawingId}
            to="/d/$drawingId"
            params={{ drawingId: d.id }}
            label={d.name}
          />
        ))}
        {list.data && list.data.items.length === 0 ? (
          <p className="px-2.5 py-1 text-xs text-fg3">{t('boards.drawings.nav.none')}</p>
        ) : null}
        {recentDrawings.length ? (
          <>
            <span className="eyebrow mt-3 mb-1 px-2.5">{t('boards.drawings.nav.recent')}</span>
            {recentDrawings.map((d) => (
              <Item
                key={d.id}
                icon="clock"
                active={d.id === activeDrawingId}
                to="/d/$drawingId"
                params={{ drawingId: d.id }}
                label={d.name}
              />
            ))}
          </>
        ) : null}
        {favoriteDrawings.length ? (
          <>
            <span className="eyebrow mt-3 mb-1 px-2.5">{t('boards.drawings.nav.favorites')}</span>
            {favoriteDrawings.map((d) => (
              <Item
                key={d.id}
                icon="star"
                active={d.id === activeDrawingId}
                to="/d/$drawingId"
                params={{ drawingId: d.id }}
                label={d.name}
              />
            ))}
          </>
        ) : null}
        <div className="mt-3 flex flex-col gap-px">
          {canCreate && space ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void create(space.id, null)}
              className="flex h-[var(--nv-h)] items-center gap-2.5 rounded-sm px-2.5 text-[13.5px] font-medium text-fg2 hover:bg-bg2 hover:text-fg disabled:opacity-50"
            >
              <Icon name="plus" size={16} />
              {t('boards.nav.newDrawing')}
            </button>
          ) : null}
          {space ? (
            <Item
              icon="trash"
              to="/drive/$spaceSlug/trash"
              params={{ spaceSlug: space.slug }}
              label={t('boards.nav.trash')}
            />
          ) : null}
        </div>
      </div>
    </SpaceSidebar>
  );
}
