import { type MyBoardCard } from '@crewhall/shared';
import { EmptyState, Skeleton } from '@crewhall/ui';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { myCardsQuery } from '@/lib/boards/api';
import { cardRef } from '@/lib/boards/filters';
import { useI18n } from '@/lib/i18n/I18nContext';
import { AvatarStack, DueChip, Labels } from './parts';

/**
 * "Bana atananlar" and "Süresi yaklaşanlar" (design 6.1 views, 6.9): open cards assigned to
 * me across every board I can see. `compact` is the quick access card body.
 */
export function AssignedList({
  scope,
  spaceId,
  compact,
  limit = 50,
}: {
  scope: 'assigned' | 'due';
  spaceId?: string;
  compact?: boolean;
  limit?: number;
}) {
  const { t } = useI18n();
  const q = useQuery(myCardsQuery({ scope, spaceId, limit }));
  if (q.isLoading) {
    return (
      <div className="flex flex-col gap-2">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }
  const items = q.data?.items ?? [];
  if (!items.length) {
    return compact ? (
      <p className="py-3 text-center text-xs text-fg3">
        {scope === 'due' ? t('boards.assigned.dueEmpty') : t('boards.assigned.empty')}
      </p>
    ) : (
      <EmptyState
        className="m-auto"
        icon="checkC"
        title={scope === 'due' ? t('boards.assigned.dueEmpty') : t('boards.assigned.empty')}
      />
    );
  }
  return (
    <ul className="flex flex-col">
      {items.map((c) => (
        <Row key={c.id} card={c} compact={compact} />
      ))}
    </ul>
  );
}

function Row({ card, compact }: { card: MyBoardCard; compact?: boolean }) {
  const { t } = useI18n();
  const key = cardRef(card.board.key, card.number);
  return (
    <li>
      <Link
        to="/b/$boardId/$cardRef"
        params={{ boardId: card.board.id, cardRef: key }}
        className="flex items-center gap-3 rounded-md px-2 py-2 hover:bg-bg2"
      >
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-[13.5px] font-semibold text-fg">{card.title}</span>
          <span className="flex items-center gap-2 text-[11.5px] text-fg3">
            <span className="font-mono">{key}</span>
            <span className="truncate">
              {t('boards.assigned.inBoard', { board: card.board.name, column: card.column.name })}
            </span>
          </span>
        </span>
        {!compact ? <Labels ids={card.labels} labels={[]} /> : null}
        <DueChip dueAt={card.dueAt} />
        {!compact ? <AvatarStack people={card.assignees} /> : null}
      </Link>
    </li>
  );
}
