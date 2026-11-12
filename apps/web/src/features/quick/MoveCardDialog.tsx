import { type Card, type CardMoveTarget } from '@crewhall/shared';
import {
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Icon,
  Input,
  Skeleton,
  SpaceDot,
} from '@crewhall/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n/I18nContext';

/**
 * "Başka space'e taşı": the homes the caller may write to, from the server. What the card
 * points to stays where it is, so a target whose people cannot open it gets a warning.
 */
export function MoveCardDialog({
  card,
  onMove,
  onClose,
}: {
  card: Card;
  onMove: (surfaceId: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [q, setQ] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const targets = useQuery({
    queryKey: ['cards', card.id, 'move-targets'],
    queryFn: ({ signal }) =>
      api.call('listCardMoveTargets', { params: { cardId: card.id }, signal }),
    staleTime: 0,
  });
  const nameOf = ({ surface }: CardMoveTarget) =>
    surface.owner.type === 'space' ? surface.owner.spaceName : t('home.mine');
  const items = targets.data?.items ?? [];
  const term = q.trim().toLocaleLowerCase('tr');
  const shown = term
    ? items.filter((x) => nameOf(x).toLocaleLowerCase('tr').includes(term))
    : items;
  const selected = items.find((x) => x.surface.id === selectedId);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent width={460}>
        <DialogHeader
          icon="arrowR"
          title={t('quick.moveDialog.title')}
          description={t('quick.moveDialog.body')}
        />
        <Input
          value={q}
          autoFocus
          placeholder={t('quick.moveDialog.search')}
          aria-label={t('quick.moveDialog.search')}
          onChange={(e) => setQ(e.target.value)}
        />
        {targets.isLoading ? <Skeleton className="h-24 w-full" /> : null}
        {targets.data && items.length === 0 ? (
          <p className="py-4 text-center text-sm text-fg3">{t('quick.moveDialog.empty')}</p>
        ) : null}
        {items.length > 0 && shown.length === 0 ? (
          <p className="py-4 text-center text-sm text-fg3">{t('quick.moveDialog.none')}</p>
        ) : null}
        <ul className="flex max-h-[280px] flex-col gap-px overflow-y-auto">
          {shown.map((x) => {
            const on = x.surface.id === selectedId;
            return (
              <li key={x.surface.id}>
                <button
                  type="button"
                  aria-pressed={on}
                  onClick={() => setSelectedId(x.surface.id)}
                  className={cn(
                    'flex h-10 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-[13.5px] font-semibold text-fg hover:bg-bg2',
                    on && 'bg-bg2',
                  )}
                >
                  <SpaceDot
                    color={x.surface.owner.type === 'space' ? x.surface.owner.spaceColor : 's6'}
                  />
                  <span className="min-w-0 flex-1 truncate">{nameOf(x)}</span>
                  {x.cannotOpen ? <Icon name="alert" size={15} className="text-warning" /> : null}
                  {on ? <Icon name="check" size={15} /> : null}
                </button>
              </li>
            );
          })}
        </ul>
        {selected?.cannotOpen ? (
          <p role="status" className="rounded-md bg-bg2 px-3 py-2 text-[13px] text-fg2">
            {t('quick.moveDialog.warning', { count: selected.cannotOpen })}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="gh" onClick={onClose}>
            {t('quick.moveDialog.cancel')}
          </Button>
          <Button
            variant="inv"
            disabled={!selected}
            onClick={() => selected && onMove(selected.surface.id)}
          >
            {t('quick.moveDialog.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
