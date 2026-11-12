import { createFileRoute, Outlet, useParams } from '@tanstack/react-router';
import { BoardPage } from '@/components/boards/BoardPage';
import { boardSearch } from '@/lib/boards/filters';

/** A board (design 6.1): `/b/<boardId>`, filters in the search; card and settings as children. */
export const Route = createFileRoute('/_app/b/$boardId')({
  validateSearch: boardSearch,
  component: function BoardRoute() {
    const { boardId } = Route.useParams();
    const search = Route.useSearch();
    const child = useParams({ strict: false }) as { cardRef?: string };
    return (
      <BoardPage boardId={boardId} search={search} openCardId={child.cardRef ?? null}>
        <Outlet />
      </BoardPage>
    );
  },
});
