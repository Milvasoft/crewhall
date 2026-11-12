import { Button, EmptyState } from '@crewhall/ui';
import { createFileRoute, Link, notFound, redirect, useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { Workspace } from '@/components/shell/Workspace';
import { SpaceSidebar } from '@/components/spaces/SpaceSidebar';
import { spaceName } from '@/components/spaces/spaceUtils';
import { useI18n } from '@/lib/i18n/I18nContext';
import { MODULE_BY_SEGMENT, MODULES, type ModuleId } from '@/lib/modules';
import { spacesQuery } from '@/lib/queries';
import { usePermissions } from '@/lib/session';
import { rememberSpace, useSpaces } from '@/lib/useSpaces';

/**
 * Modules that have their own pages now. A space URL they don't have (e.g. /meetings/<space>)
 * goes to the module instead of a "coming soon" page (H5); that page is only for modules that
 * are not built yet.
 */
const READY: ReadonlySet<ModuleId> = new Set([
  'chat',
  'drive',
  'pages',
  'boards',
  'drawings',
  'meet',
  'vault',
  'forms',
  'automations',
  'tables',
]);

export const Route = createFileRoute('/_app/$module/$spaceSlug')({
  beforeLoad: async ({ params, context: { queryClient } }) => {
    const id = MODULE_BY_SEGMENT[params.module];
    if (!id) throw notFound({ routeId: '/_app' });
    const ready = MODULES.find((m) => m.id === id);
    if (ready && READY.has(id)) throw redirect({ href: ready.path });
    const { items } = await queryClient.ensureQueryData(spacesQuery());
    // Unknown or hidden spaces are 404 so their existence does not leak.
    if (!items.some((s) => s.slug === params.spaceSlug)) throw notFound({ routeId: '/_app' });
  },
  component: ModulePage,
});

/** Space area of a module that is not built yet: the space selector and a placeholder. */
function ModulePage() {
  const { t } = useI18n();
  const { module, spaceSlug } = Route.useParams();
  const navigate = useNavigate();
  const { bySlug } = useSpaces();
  const { canSpace } = usePermissions();
  const space = bySlug(spaceSlug);
  const id = MODULE_BY_SEGMENT[module] ?? 'drive';
  const mod = MODULES.find((m) => m.id === id) ?? MODULES[1];

  useEffect(() => {
    rememberSpace(spaceSlug);
  }, [spaceSlug]);

  return (
    <Workspace
      sidebar={
        <SpaceSidebar
          space={space}
          onSelect={(s) =>
            void navigate({ to: '/$module/$spaceSlug', params: { module, spaceSlug: s.slug } })
          }
        />
      }
      crumbs={[{ label: space ? spaceName(space, t) : '' }, { label: t(`shell.modules.${id}`) }]}
      searchLabel={space ? t('shell.searchIn', { name: spaceName(space, t) }) : undefined}
    >
      <EmptyState
        className="m-auto"
        icon={mod.icon}
        title={t('modules.comingTitle', { module: t(`shell.modules.${id}`) })}
        description={t('modules.comingBody')}
      >
        {space && space.kind === 'shared' && canSpace('space.update_settings', space.myRole) ? (
          <Button variant="inv" asChild>
            <Link to="/spaces/$spaceSlug/settings" params={{ spaceSlug: space.slug }}>
              {t('spaces.settings')}
            </Link>
          </Button>
        ) : null}
      </EmptyState>
    </Workspace>
  );
}
