import { Button, EmptyState, Icon, Skeleton } from '@crewhall/ui';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link, notFound } from '@tanstack/react-router';
import { useEffect } from 'react';
import { DrawingsSidebar } from '@/components/drawings/DrawingsSidebar';
import { useNewDrawing } from '@/components/drawings/useNewDrawing';
import { NodeListItem, useNodeListMenu } from '@/components/boards/NodeListMenu';
import { Workspace } from '@/components/shell/Workspace';
import { spaceName } from '@/components/spaces/spaceUtils';
import { rawPreviewUrl } from '@/features/drive/urls';
import { boardKeys, drawingsQuery } from '@/lib/boards/api';
import { formatRelative } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { spacesQuery } from '@/lib/queries';
import { usePermissions } from '@/lib/session';
import { rememberSpace, useSpaces } from '@/lib/useSpaces';

/** Drawings of a space with their thumbnails (Drive previews of `drawing` nodes). */
export const Route = createFileRoute('/_app/drawings/$spaceSlug')({
  beforeLoad: async ({ params, context: { queryClient } }) => {
    const { items } = await queryClient.ensureQueryData(spacesQuery());
    if (!items.some((s) => s.slug === params.spaceSlug)) throw notFound({ routeId: '/_app' });
  },
  component: DrawingsHome,
});

function DrawingsHome() {
  const { t, locale } = useI18n();
  const { spaceSlug } = Route.useParams();
  const { bySlug } = useSpaces();
  const { canSpace } = usePermissions();
  const space = bySlug(spaceSlug);
  const list = useQuery({ ...drawingsQuery(space?.id ?? ''), enabled: Boolean(space) });
  const { create: createIn, busy } = useNewDrawing();
  const menu = useNodeListMenu('drawing', boardKeys.drawings(space?.id ?? ''));
  useEffect(() => rememberSpace(spaceSlug), [spaceSlug]);
  if (!space) return null;
  const canCreate = canSpace('space.edit_content', space.myRole);

  return (
    <Workspace
      sidebar={<DrawingsSidebar space={space} />}
      crumbs={[{ label: spaceName(space, t) }, { label: t('boards.drawingsTitle') }]}
      tools={
        canCreate ? (
          <Button
            size="sm"
            variant="inv"
            loading={busy}
            onClick={() => void createIn(space.id, null)}
          >
            <Icon name="plus" size={16} />
            {t('boards.drawings.new')}
          </Button>
        ) : null
      }
    >
      <h1 className="text-title font-bold">
        {t('boards.drawings.home', { space: spaceName(space, t) })}
      </h1>
      {list.isLoading ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3">
          <Skeleton className="h-44" />
          <Skeleton className="h-44" />
        </div>
      ) : list.data?.items.length ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3">
          {list.data.items.map((d) => (
            <NodeListItem key={d.id} item={d} myRole={space.myRole} menu={menu}>
              {({ onKeyDown }) => (
                <Link
                  to="/d/$drawingId"
                  params={{ drawingId: d.id }}
                  onKeyDown={onKeyDown}
                  className="flex flex-col overflow-hidden rounded-2xl bg-surface shadow-[0_0_0_1px_var(--line)] hover:shadow-[0_0_0_1px_var(--line2),var(--shSm)]"
                >
                  <span className="flex h-[150px] items-center justify-center bg-bg2">
                    {d.thumbnailReady ? (
                      <img
                        src={`${rawPreviewUrl(d.id, 'thumb_256')}&v=${Date.parse(d.updatedAt)}`}
                        alt=""
                        loading="lazy"
                        className="size-full object-contain"
                      />
                    ) : (
                      <Icon name="vector" size={32} className="text-fg3" />
                    )}
                  </span>
                  <span className="flex flex-col gap-0.5 px-3.5 py-3">
                    <span className="truncate text-[14px] font-semibold text-fg">{d.name}</span>
                    <span className="text-xs text-fg3">
                      {t('boards.drawings.elements', { count: d.elementCount })} ·{' '}
                      {formatRelative(d.updatedAt, locale)}
                    </span>
                  </span>
                </Link>
              )}
            </NodeListItem>
          ))}
        </div>
      ) : (
        <EmptyState
          className="m-auto"
          icon="vector"
          title={t('boards.drawings.empty')}
          description={t('boards.drawings.emptyBody')}
        >
          {canCreate ? (
            <Button
              variant="inv"
              size="sm"
              loading={busy}
              onClick={() => void createIn(space.id, null)}
            >
              {t('boards.drawings.new')}
            </Button>
          ) : null}
        </EmptyState>
      )}
    </Workspace>
  );
}
