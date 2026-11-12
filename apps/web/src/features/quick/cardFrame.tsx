import { type Card, type SpaceColor } from '@crewhall/shared';
import { cn, Icon, IconButton, type IconName } from '@crewhall/ui';
import { type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { useI18n } from '@/lib/i18n/I18nContext';
import { CardContextMenu, CardDropdown } from './CardMenu';
import { type QuickContextValue, useQuick } from './context';
import { canEditCard } from './EditCardDialog';
import { openLink } from './LinkBits';

/** Shared frame of every quick access card: article, context menu and the edit-mode chrome. */

export const DOT_BG: Record<SpaceColor, string> = {
  s1: 'bg-s1',
  s2: 'bg-s2',
  s3: 'bg-s3',
  s4: 'bg-s4',
  s5: 'bg-s5',
  s6: 'bg-s6',
};

/** Cards opt out of grid dragging inside these (inputs, menus, links in view mode). */
export const NO_DRAG = 'qc-nodrag';

export function CardFrame({
  card,
  label,
  className,
  style,
  children,
}: {
  card: Card;
  label: string;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const q = useQuick();
  const { editing, canEdit } = q;
  return (
    <CardContextMenu card={card}>
      <article
        aria-label={label}
        data-card-id={card.id}
        style={style}
        tabIndex={0}
        onKeyDown={(e) => onCardKey(e, card, q)}
        className={cn(
          'relative flex h-full min-h-0 min-w-0 flex-col gap-2.5 overflow-hidden rounded-2xl bg-surface p-3.5 text-fg shadow-[inset_0_0_0_1px_var(--line)] outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--fg)]',
          editing && canEdit && 'cursor-grab shadow-[inset_0_0_0_1px_var(--line2)] select-none',
          className,
        )}
      >
        {children}
        {editing && canEdit ? <EditChrome card={card} label={label} /> : null}
      </article>
    </CardContextMenu>
  );
}

/**
 * The shortcuts the card menu shows: E or F2 edits, Del removes, Ctrl D duplicates, Enter on a
 * link card opens it. Keys typed into the card's own inputs (note, todo, chat reply) stay there.
 */
function onCardKey(e: KeyboardEvent<HTMLElement>, card: Card, q: QuickContextValue) {
  const el = e.target as HTMLElement;
  if (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) return;
  const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
  if (e.key === 'Enter' && plain && e.target === e.currentTarget && card.type === 'link') {
    const link = card.links[card.config.item.linkId];
    if (link) {
      e.preventDefault();
      openLink(link);
    }
    return;
  }
  if (!q.canEdit) return;
  if (plain && (e.key === 'F2' || e.key.toLowerCase() === 'e') && canEditCard(card)) {
    e.preventDefault();
    q.openEdit(card);
  } else if (plain && e.key === 'Delete') {
    e.preventDefault();
    q.remove(card);
  } else if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'd') {
    e.preventDefault();
    q.duplicate(card);
  }
}

function EditChrome({ card, label }: { card: Card; label: string }) {
  const { t } = useI18n();
  const q = useQuick();
  return (
    <div className={cn('absolute top-2 right-2 z-[1] flex gap-1', NO_DRAG)}>
      <CardDropdown card={card}>
        <IconButton size="xs" tone="plain" aria-label={t('quick.edit.cardMenu', { name: label })}>
          <Icon name="settings" size={14} />
        </IconButton>
      </CardDropdown>
      <IconButton
        size="xs"
        tone="plain"
        aria-label={t('quick.edit.removeCard', { name: label })}
        onClick={() => q.remove(card)}
      >
        <Icon name="x" size={14} />
      </IconButton>
    </div>
  );
}

export function CardHeader({
  icon,
  dot,
  title,
  aside,
  style,
}: {
  icon?: IconName;
  dot?: SpaceColor | null;
  title: ReactNode;
  aside?: ReactNode;
  style?: CSSProperties;
}) {
  const { editing } = useQuick();
  return (
    <header
      style={style}
      className={cn(
        'flex min-w-0 shrink-0 items-center gap-2 text-[13px] leading-[18px] font-semibold',
        editing && 'pr-16',
      )}
    >
      {dot ? <span className={cn('size-2 shrink-0 rounded-full', DOT_BG[dot])} /> : null}
      {icon ? <Icon name={icon} size={16} className="shrink-0 opacity-70" /> : null}
      <span className="min-w-0 flex-1 truncate">{title}</span>
      {aside}
    </header>
  );
}
