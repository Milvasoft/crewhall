import { useQuery } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { CardDetail } from '@/components/boards/CardDetail';
import { boardQuery, cardByNumberQuery, cardQuery } from '@/lib/boards/api';
import { toSearch } from '@/lib/boards/filters';
import { useMe } from '@/lib/session';

/** Card detail (design 6.3): `/b/<boardId>/MLV-142`, a shareable address over the board. */
export const Route = createFileRoute('/_app/b/$boardId/$cardRef')({
  component: function CardRoute() {
    const { boardId, cardRef } = Route.useParams();
    const search = Route.useSearch();
    const navigate = useNavigate();
    const me = useMe();
    const board = useQuery(boardQuery(boardId));
    const byNumber = useQuery(cardByNumberQuery(boardId, cardRef));
    const id = byNumber.data?.id ?? '';
    // Writes and live refreshes update the card by id.
    const card = useQuery({ ...cardQuery(id), enabled: Boolean(id), initialData: byNumber.data });
    if (!board.data) return null;
    return (
      <CardDetail
        board={board.data}
        card={id ? card.data : undefined}
        loading={byNumber.isLoading}
        meId={me?.user.id ?? ''}
        onClose={() =>
          void navigate({ to: '/b/$boardId', params: { boardId }, search: toSearch(search) })
        }
      />
    );
  },
});
