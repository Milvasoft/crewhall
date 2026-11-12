import { Button, EmptyState, Icon, Skeleton } from '@crewhall/ui';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link, notFound } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { Workspace } from '@/components/shell/Workspace';
import { spaceName } from '@/components/spaces/spaceUtils';
import { NewTableDialog } from '@/components/tables/NewTableDialog';
import { TablesSidebar } from '@/components/tables/TablesSidebar';
import { formatRelative } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { spacesQuery } from '@/lib/queries';
import { usePermissions } from '@/lib/session';
import { tablesQuery } from '@/lib/tables/api';
import { rememberSpace, useSpaces } from '@/lib/useSpaces';

/** Tables of a space. */
export const Route = createFileRoute('/_app/tables/$spaceSlug')({
  beforeLoad: async ({ params, context: { queryClient } }) => {
    const { items } = await queryClient.ensureQueryData(spacesQuery());
    if (!items.some((s) => s.slug === params.spaceSlug)) throw notFound({ routeId: '/_app' });
  },
  component: TablesHome,
});

function TablesHome() {
  const { t, locale } = useI18n();
  const { spaceSlug } = Route.useParams();
  const { bySlug } = useSpaces();
  const { canSpace } = usePermissions();
  const space = bySlug(spaceSlug);
  const tables = useQuery({ ...tablesQuery(space?.id ?? ''), enabled: Boolean(space) });
  const [creating, setCreating] = useState(false);
  useEffect(() => rememberSpace(spaceSlug), [spaceSlug]);
  if (!space) return null;
  const editor = canSpace('tables.edit', space.myRole);

  const newButton = editor ? (
    <Button size="sm" variant="inv" onClick={() => setCreating(true)}>
      <Icon name="plus" size={16} />
      {t('tables.nav.new')}
    </Button>
  ) : null;

  return (
    <Workspace
      sidebar={<TablesSidebar space={space} />}
      crumbs={[{ label: spaceName(space, t) }, { label: t('tables.title') }]}
      tools={newButton}
    >
      <section className="flex flex-col gap-4">
        <h1 className="text-title font-bold">{t('tables.home.title', { space: spaceName(space, t) })}</h1>
        {tables.isLoading ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
            <Skeleton className="h-28" />
            <Skeleton className="h-28" />
          </div>
        ) : tables.data?.items.length ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
            {tables.data.items.map((tb) => (
              <Link
                key={tb.id}
                to="/tables/t/$tableId"
                params={{ tableId: tb.id }}
                className="flex flex-col gap-3 rounded-2xl bg-surface p-4 shadow-[0_0_0_1px_var(--line)] hover:shadow-[0_0_0_1px_var(--line2),var(--shSm)]"
              >
                <span className="flex size-9 items-center justify-center rounded-lg bg-bg2">
                  <Icon name="table" size={18} />
                </span>
                <span className="text-sub font-semibold break-words text-fg">{tb.name}</span>
                {tb.description ? <span className="line-clamp-2 text-xs text-fg2">{tb.description}</span> : null}
                <span className="text-xs text-fg3">
                  {t('tables.home.rows', { count: tb.rowCount })} · {formatRelative(tb.updatedAt, locale)}
                </span>
              </Link>
            ))}
          </div>
        ) : (
          <EmptyState
            className="m-auto"
            icon="table"
            title={t('tables.home.empty')}
            description={editor ? t('tables.home.emptyBody') : t('tables.home.emptyViewer')}
          >
            {newButton}
          </EmptyState>
        )}
      </section>
      {editor ? <NewTableDialog space={space} open={creating} onClose={() => setCreating(false)} /> : null}
    </Workspace>
  );
}
