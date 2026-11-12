import { type Space } from '@crewhall/shared';
import { cn, Icon } from '@crewhall/ui';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { SpaceSidebar } from '@/components/spaces/SpaceSidebar';
import { useI18n } from '@/lib/i18n/I18nContext';
import { usePermissions } from '@/lib/session';
import { tablesQuery } from '@/lib/tables/api';
import { NewTableDialog } from './NewTableDialog';

/** Tables sidebar: the space's tables and "new table". */
export function TablesSidebar({ space, activeTableId }: { space: Space | undefined; activeTableId?: string }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { canSpace } = usePermissions();
  const tables = useQuery({ ...tablesQuery(space?.id ?? ''), enabled: Boolean(space) });
  const canCreate = space ? canSpace('tables.edit', space.myRole) : false;
  const [creating, setCreating] = useState(false);

  return (
    <SpaceSidebar space={space} onSelect={(s) => void navigate({ to: '/tables/$spaceSlug', params: { spaceSlug: s.slug } })}>
      <div className="mt-2 flex min-h-0 flex-1 flex-col gap-px overflow-y-auto">
        <span className="eyebrow mt-1 mb-1 px-2.5">{t('tables.nav.tables')}</span>
        {tables.data?.items.map((tb) => (
          <Link
            key={tb.id}
            to="/tables/t/$tableId"
            params={{ tableId: tb.id }}
            className={cn(
              'flex h-[var(--nv-h)] items-center gap-2.5 rounded-sm px-2.5 text-[13.5px] font-medium text-fg2 hover:bg-bg2 hover:text-fg',
              tb.id === activeTableId && 'bg-bg2 font-semibold text-fg',
            )}
          >
            <Icon name="table" size={16} />
            <span className="min-w-0 flex-1 truncate">{tb.name}</span>
            <span className="text-xs text-fg3 tabular-nums">{tb.rowCount}</span>
          </Link>
        ))}
        {tables.data && tables.data.items.length === 0 ? <p className="px-2.5 py-1 text-xs text-fg3">{t('tables.nav.none')}</p> : null}
        {canCreate ? (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="mt-3 flex h-[var(--nv-h)] items-center gap-2.5 rounded-sm px-2.5 text-[13.5px] font-medium text-fg2 hover:bg-bg2 hover:text-fg"
          >
            <Icon name="plus" size={16} />
            {t('tables.nav.new')}
          </button>
        ) : null}
      </div>
      {space && canCreate ? <NewTableDialog space={space} open={creating} onClose={() => setCreating(false)} /> : null}
    </SpaceSidebar>
  );
}
