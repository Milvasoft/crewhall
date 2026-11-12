import { type Table, type TableView } from '@crewhall/shared';
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  EmptyState,
  Icon,
  Skeleton,
  cn,
} from '@crewhall/ui';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { CellView } from '@/components/tables/CellView';
import { TableProvider } from '@/components/tables/context';
import { isApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n/I18nContext';
import { viewFields } from '@/lib/tables/fields';
import { rowsQuery, tableQuery, tablesQuery } from '@/lib/tables/api';
import { useSpaces } from '@/lib/useSpaces';

/** Enough to read a table in a page; the rest is one click away, in the table itself. */
const SHOWN_ROWS = 10;
const SHOWN_FIELDS = 6;

/**
 * A table of the Tables module, live inside a page: the same rows, filters and sorts as its
 * views, updated as people change them. Nothing is copied and nothing is edited here; a row
 * opens in the table.
 */
export function TableEmbed({ tableId }: { tableId: string }) {
  const { t } = useI18n();
  const table = useQuery(tableQuery(tableId));
  if (table.isPending) {
    return (
      <div className="wk-table-embed">
        <Skeleton className="h-24" />
      </div>
    );
  }
  if (!table.data) {
    return (
      <div className="wk-embed-card">
        <span className="wk-muted">
          <Icon name="lock" size={14} />{' '}
          {isApiError(table.error, 'not_found')
            ? t('wiki.editor.embedNoAccess')
            : t('errors.internal')}
        </span>
      </div>
    );
  }
  return (
    <TableProvider table={table.data}>
      <Body table={table.data} />
    </TableProvider>
  );
}

function Body({ table }: { table: Table }) {
  const { t } = useI18n();
  const [viewId, setViewId] = useState<string | null>(null);
  const view: TableView = table.views.find((v) => v.id === viewId) ?? table.views[0]!;
  const rows = useInfiniteQuery(rowsQuery(table.id, view.id, ''));
  const first = rows.data?.pages[0];
  const shown = first?.items.slice(0, SHOWN_ROWS) ?? [];
  const more = (first?.total ?? 0) - shown.length;
  const fields = viewFields(table.fields, view).slice(0, SHOWN_FIELDS);
  return (
    <div className="wk-table-embed">
      <div className="wk-table-embed-head">
        <Icon name="table" size={16} />
        <span className="wk-embed-name">{table.name}</span>
        {table.views.length > 1 ? (
          <span className="wk-table-embed-views">
            {table.views.map((v) => (
              <button
                key={v.id}
                type="button"
                aria-pressed={v.id === view.id}
                className={cn(v.id === view.id && 'is-active')}
                onClick={() => setViewId(v.id)}
              >
                {v.name}
              </button>
            ))}
          </span>
        ) : null}
        <Link
          to="/tables/t/$tableId"
          params={{ tableId: table.id }}
          search={{ view: view.id }}
          className="wk-embed-open ml-auto"
        >
          {t('wiki.editor.embedOpen')}
        </Link>
      </div>
      {rows.isPending ? (
        <Skeleton className="h-16" />
      ) : shown.length ? (
        <div className="wk-table-embed-scroll">
          <table>
            <thead>
              <tr>
                {fields.map((f) => (
                  <th key={f.id} scope="col">
                    {f.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((row) => (
                <tr key={row.id}>
                  {fields.map((f) => (
                    <td key={f.id}>
                      {f.primary ? (
                        <Link
                          to="/tables/t/$tableId"
                          params={{ tableId: table.id }}
                          search={{ view: view.id, row: row.id }}
                        >
                          <CellView field={f} value={row.values[f.id]} compact />
                        </Link>
                      ) : (
                        <CellView field={f} value={row.values[f.id]} compact />
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="wk-muted">{t('wiki.tableEmbed.empty')}</p>
      )}
      {more > 0 ? (
        <p className="wk-muted wk-table-embed-more">{t('wiki.tableEmbed.more', { count: more })}</p>
      ) : null}
    </div>
  );
}

/** Which table of the page's space to link. */
export function TableEmbedDialog({
  spaceId,
  open,
  onClose,
  onPick,
}: {
  spaceId: string;
  open: boolean;
  onClose: () => void;
  onPick: (tableId: string) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(v) => (v ? null : onClose())}>
      {open ? <PickBody spaceId={spaceId} onClose={onClose} onPick={onPick} /> : null}
    </Dialog>
  );
}

function PickBody({
  spaceId,
  onClose,
  onPick,
}: {
  spaceId: string;
  onClose: () => void;
  onPick: (tableId: string) => void;
}) {
  const { t } = useI18n();
  const { items: spaces } = useSpaces();
  const slug = spaces.find((s) => s.id === spaceId)?.slug;
  const tables = useQuery(tablesQuery(spaceId));
  const items = tables.data?.items ?? [];
  return (
    <DialogContent width={520}>
      <DialogHeader
        icon="table"
        title={t('wiki.tableEmbed.pick')}
        description={t('wiki.tableEmbed.pickBody')}
      />
      {tables.isPending ? (
        <Skeleton className="h-24" />
      ) : items.length ? (
        <div className="flex max-h-80 flex-col gap-1 overflow-y-auto">
          {items.map((x) => (
            <button
              key={x.id}
              type="button"
              className="flex items-center gap-2 rounded-md px-2 py-2 text-left text-[14px] font-medium hover:bg-bg2"
              onClick={() => onPick(x.id)}
            >
              <Icon name="table" size={16} />
              {x.name}
            </button>
          ))}
        </div>
      ) : (
        <EmptyState icon="table" title={t('wiki.tableEmbed.none')} />
      )}
      <DialogFooter>
        {!items.length && slug ? (
          <Link to="/tables/$spaceSlug" params={{ spaceSlug: slug }} className="wk-embed-open">
            {t('wiki.tableEmbed.goTables')}
          </Link>
        ) : null}
        <Button variant="gh" onClick={onClose}>
          {t('common.actions.cancel')}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
