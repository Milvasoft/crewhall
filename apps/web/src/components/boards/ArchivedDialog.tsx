import { type BoardDetail } from '@crewhall/shared';
import { Button, Dialog, DialogContent, DialogHeader, Skeleton } from '@crewhall/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useBoardActions } from '@/lib/boards/actions';
import { archivedQuery, boardKeys } from '@/lib/boards/api';
import { cardRef } from '@/lib/boards/filters';
import { formatDate } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';

/** Archived cards of a board (design 6.1 sidebar "Arşivlenen kartlar"); restorable. */
export function ArchivedDialog({
  detail,
  open,
  canEdit,
  onClose,
}: {
  detail: BoardDetail;
  open: boolean;
  canEdit: boolean;
  onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const actions = useBoardActions(detail.board.id);
  const q = useQuery({ ...archivedQuery(detail.board.id), enabled: open });
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent width={560}>
        <DialogHeader icon="archive" title={t('boards.archived.title')} />
        {q.isLoading ? <Skeleton className="h-10 w-full" /> : null}
        {q.data && q.data.items.length === 0 ? (
          <p className="py-6 text-center text-sm text-fg3">{t('boards.archived.empty')}</p>
        ) : null}
        <ul className="flex max-h-[420px] flex-col overflow-y-auto">
          {q.data?.items.map((c) => (
            <li
              key={c.id}
              className="flex items-center gap-3 border-b border-line py-2 last:border-0"
            >
              <span className="font-mono text-xs text-fg3">
                {cardRef(detail.board.settings.key, c.number)}
              </span>
              <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold">{c.title}</span>
              <span className="text-xs text-fg3">
                {c.archivedAt
                  ? t('boards.archived.archivedAt', {
                      date: formatDate(c.archivedAt, locale, { day: 'numeric', month: 'short' }),
                    })
                  : null}
              </span>
              {canEdit ? (
                <Button
                  size="xs"
                  variant="out"
                  onClick={async () => {
                    await actions.updateCard(c.id, { archived: false });
                    void qc.invalidateQueries({ queryKey: boardKeys.archived(detail.board.id) });
                  }}
                >
                  {t('boards.archived.restore')}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
