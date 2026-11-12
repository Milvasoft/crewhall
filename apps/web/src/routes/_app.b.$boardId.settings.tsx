import { useQuery } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { BoardSettingsDialog } from '@/components/boards/BoardSettingsDialog';
import { boardQuery } from '@/lib/boards/api';
import { toSearch } from '@/lib/boards/filters';

/** Board settings (design 6.6): `/b/<boardId>/settings`. */
export const Route = createFileRoute('/_app/b/$boardId/settings')({
  component: function SettingsRoute() {
    const { boardId } = Route.useParams();
    const search = Route.useSearch();
    const navigate = useNavigate();
    const board = useQuery(boardQuery(boardId));
    if (!board.data) return null;
    return (
      <BoardSettingsDialog
        detail={board.data}
        onClose={() =>
          void navigate({ to: '/b/$boardId', params: { boardId }, search: toSearch(search) })
        }
      />
    );
  },
});
