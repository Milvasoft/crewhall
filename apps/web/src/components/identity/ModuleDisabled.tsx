import { type ModuleKey } from '@crewhall/shared';
import { Button, EmptyState } from '@crewhall/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useRouterState } from '@tanstack/react-router';
import { useEffect, useState, type ReactNode } from 'react';
import { Workspace } from '@/components/shell/Workspace';
import { isApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n/I18nContext';
import {
  isModuleEnabled,
  MODULE_ICON,
  moduleForPath,
  SELF_GATED_MODULES,
} from '@/lib/identity/modules';
import { meQuery } from '@/lib/queries';
import { usePermissions } from '@/lib/session';

/** "Bu modül kurumunda kapalı": shown instead of a disabled module's page. */
export function ModuleDisabled({ module }: { module: ModuleKey | null }) {
  const { t } = useI18n();
  const { canOrg } = usePermissions();
  const name = module ? t(`identity.modules.items.${module}.name`) : null;
  return (
    <Workspace crumbs={name ? [{ label: name }] : undefined}>
      <EmptyState
        className="m-auto"
        icon={module ? MODULE_ICON[module] : 'lock'}
        title={t('identity.disabled.title')}
        description={
          name ? t('identity.disabled.body', { module: name }) : t('identity.disabled.bodyGeneric')
        }
      >
        <Button variant="inv" asChild>
          <Link to="/">{t('identity.disabled.home')}</Link>
        </Button>
        {canOrg('org.update_settings') ? (
          <Button variant="out" asChild>
            <Link to="/admin/general">{t('identity.disabled.admin')}</Link>
          </Button>
        ) : null}
      </EmptyState>
    </Workspace>
  );
}

/**
 * Wraps the signed-in outlet: a route of a module the org turned off renders the disabled
 * screen. A `403 module_disabled` from the API (switch flipped while the page was open) refreshes
 * `me` and shows the same screen on module pages until the person navigates away.
 */
export function ModuleGate({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { data: me } = useQuery(meQuery);
  const [hitPath, setHitPath] = useState<string | null>(null);
  const module = moduleForPath(pathname);

  useEffect(() => {
    const onError = (error: unknown) => {
      if (!isApiError(error, 'module_disabled')) return;
      void qc.invalidateQueries({ queryKey: meQuery.queryKey });
      const path = window.location.pathname;
      if (moduleForPath(path)) setHitPath(path);
    };
    const offQueries = qc.getQueryCache().subscribe((e) => {
      if (e.type === 'updated' && e.action.type === 'error') onError(e.action.error);
    });
    const offMutations = qc.getMutationCache().subscribe((e) => {
      if (e.type === 'updated' && e.action.type === 'error') onError(e.action.error);
    });
    return () => {
      offQueries();
      offMutations();
    };
  }, [qc]);

  if (
    module &&
    !SELF_GATED_MODULES.has(module) &&
    (!isModuleEnabled(me, module) || hitPath === pathname)
  ) {
    return <ModuleDisabled module={module} />;
  }
  return <>{children}</>;
}
