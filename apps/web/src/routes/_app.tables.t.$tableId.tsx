import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { TablePage } from '@/components/tables/TablePage';

/** A table: `?view=` picks the view, `?row=` opens a row. */
export const Route = createFileRoute('/_app/tables/t/$tableId')({
  validateSearch: z.object({
    view: z.string().uuid().optional().catch(undefined),
    row: z.string().uuid().optional().catch(undefined),
  }),
  component: function TableRoute() {
    const { tableId } = Route.useParams();
    const { view, row } = Route.useSearch();
    return <TablePage key={tableId} tableId={tableId} viewId={view} rowId={row} />;
  },
});
