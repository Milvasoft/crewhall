import { type BoardCard, type BoardSettings } from '@crewhall/shared';
import { cn, Icon } from '@crewhall/ui';
import { forwardRef, type HTMLAttributes } from 'react';
import { cardRef } from '@/lib/boards/filters';
import { formatMinutes } from '@/lib/boards/time';
import { useI18n } from '@/lib/i18n/I18nContext';
import { AvatarStack, DueChip, Labels, Meta } from './parts';

/**
 * A kanban card (design 6.1): labels, key (MLV-142), title and one meta line: due date,
 * subtask progress, attachments, comments, assignees. Points and priority when the board
 * has those fields.
 */
export const CardTile = forwardRef<
  HTMLDivElement,
  HTMLAttributes<HTMLDivElement> & {
    card: BoardCard;
    settings: BoardSettings;
    done?: boolean;
    dragging?: boolean;
    overlay?: boolean;
    selected?: boolean;
  }
>(function CardTile(
  { card, settings, done, dragging, overlay, selected, className, ...props },
  ref,
) {
  const { t } = useI18n();
  const key = cardRef(settings.key, card.number);
  const allDone = card.checklist.total > 0 && card.checklist.done === card.checklist.total;
  return (
    <div
      ref={ref}
      {...props}
      data-card-id={card.id}
      className={cn(
        'group/card relative flex cursor-pointer flex-col gap-1.5 rounded-lg bg-surface p-2.5 text-left shadow-[0_0_0_1px_var(--line),var(--shSm)] outline-none transition-shadow select-none',
        'hover:shadow-[0_0_0_1px_var(--line2),var(--shSm)] focus-visible:shadow-[0_0_0_2px_var(--fg)]',
        selected && 'shadow-[0_0_0_2px_var(--fg)]',
        // The slot the card will land in: dashed, its content faded under the moving copy.
        dragging &&
          'bg-transparent shadow-none outline-2 -outline-offset-2 outline-accent outline-dashed [&>*]:opacity-25',
        overlay && 'rotate-[2.5deg] cursor-grabbing shadow-[0_0_0_1px_var(--line2),var(--shadow)]',
        className,
      )}
    >
      {card.labels.length || card.priority ? (
        <span className="flex flex-wrap items-center gap-1">
          {card.priority && settings.fields.priority ? (
            <span
              className={cn(
                'rounded-xs px-1.5 text-[11px] leading-5 font-bold',
                card.priority === 'p1'
                  ? 'bg-[color-mix(in_srgb,var(--danger)_14%,transparent)] text-danger'
                  : 'bg-bg2 text-fg2',
              )}
            >
              {card.priority.toUpperCase()}
            </span>
          ) : null}
          <Labels ids={card.labels} labels={settings.labels} />
        </span>
      ) : null}
      <span
        className={cn('text-[13.5px] leading-[18px] font-semibold text-fg', done && 'text-fg2')}
      >
        {card.title}
      </span>
      <span className="flex min-h-5 flex-wrap items-center gap-x-2.5 gap-y-1">
        <span className="font-mono text-[11px] text-fg3">{key}</span>
        {card.blockedBy && !done ? (
          <span
            title={t('boards.links.blockedHint', { count: card.blockedBy })}
            className="flex items-center gap-1 rounded-full bg-[color-mix(in_srgb,var(--warning)_16%,transparent)] px-1.5 text-[11px] leading-[18px] font-bold text-warning"
          >
            <Icon name="lock" size={11} />
            {t('boards.links.blocked')}
          </span>
        ) : null}
        <DueChip dueAt={card.dueAt} done={done} />
        {card.checklist.total ? (
          <Meta icon="checkC">
            <span className={cn(allDone && 'text-success')}>
              {t('boards.card.checklist', {
                done: card.checklist.done,
                total: card.checklist.total,
              })}
            </span>
          </Meta>
        ) : null}
        {card.attachmentCount ? <Meta icon="clip">{card.attachmentCount}</Meta> : null}
        {card.spentMinutes || card.estimateMinutes ? (
          <Meta icon="clock">
            <span
              className={cn(
                'tn',
                card.estimateMinutes &&
                  (card.spentMinutes ?? 0) > card.estimateMinutes &&
                  'text-warning',
              )}
            >
              {card.estimateMinutes
                ? t('boards.time.of', {
                    spent: formatMinutes(card.spentMinutes ?? 0, t),
                    estimate: formatMinutes(card.estimateMinutes, t),
                  })
                : formatMinutes(card.spentMinutes ?? 0, t)}
            </span>
          </Meta>
        ) : null}
        {card.commentCount ? <Meta icon="comment">{card.commentCount}</Meta> : null}
        {card.points !== null && settings.fields.points ? (
          <span
            title={t('boards.card.points', { points: card.points })}
            className="rounded-full bg-bg2 px-1.5 text-[11px] leading-[18px] font-bold text-fg2 tn"
          >
            {card.points}
          </span>
        ) : null}
        <span className="ml-auto">
          <AvatarStack people={card.assignees} />
        </span>
      </span>
      {overlay ? <Icon name="grip" size={14} className="absolute top-2 right-2 text-fg3" /> : null}
    </div>
  );
});
