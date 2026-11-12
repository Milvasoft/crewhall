import { type BoardLabel, type LabelColor, type UserSummary } from '@crewhall/shared';
import { Avatar, cn, Icon } from '@crewhall/ui';
import { dueState } from '@/lib/boards/filters';
import { formatDate } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';

/** Category palette (design 6.1): label colours are category tones, never the accent yellow. */
export const LABEL_VAR: Record<LabelColor, string> = {
  s1: 'var(--s1)',
  s2: 'var(--s2)',
  s3: 'var(--s3)',
  s4: 'var(--s4)',
  s5: 'var(--s5)',
  s6: 'var(--s6)',
  info: 'var(--info)',
  success: 'var(--success)',
  warning: 'var(--warning)',
  danger: 'var(--danger)',
};

export const LABEL_COLORS = Object.keys(LABEL_VAR) as LabelColor[];

export function LabelChip({
  label,
  className,
  onRemove,
}: {
  label: BoardLabel;
  className?: string;
  onRemove?: () => void;
}) {
  const c = LABEL_VAR[label.color];
  return (
    <span
      className={cn(
        'inline-flex h-5 max-w-full shrink-0 items-center gap-1 truncate rounded-xs px-1.5 text-[11.5px] leading-4 font-semibold',
        className,
      )}
      style={{ color: c, background: `color-mix(in srgb, ${c} 14%, transparent)` }}
    >
      <span className="truncate">{label.name}</span>
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          aria-label={label.name}
          className="-mr-0.5 rounded-xs hover:opacity-70"
        >
          <Icon name="x" size={11} />
        </button>
      ) : null}
    </span>
  );
}

export function Labels({
  ids,
  labels,
  className,
}: {
  ids: string[];
  labels: BoardLabel[];
  className?: string;
}) {
  const known = ids
    .map((id) => labels.find((l) => l.id === id))
    .filter((l): l is BoardLabel => !!l);
  if (!known.length) return null;
  return (
    <span className={cn('flex flex-wrap gap-1', className)}>
      {known.map((l) => (
        <LabelChip key={l.id} label={l} />
      ))}
    </span>
  );
}

export function AvatarStack({
  people,
  max = 3,
  size = 'xs',
}: {
  people: UserSummary[];
  max?: number;
  size?: 'xs' | 'sm';
}) {
  const small = size === 'xs' ? 'size-[22px] text-[9px]' : '';
  if (!people.length) return null;
  const shown = people.slice(0, max);
  return (
    <span className="flex -space-x-1.5">
      {shown.map((p) => (
        <Avatar
          key={p.id}
          name={p.name}
          src={p.imageUrl}
          size="sm"
          className={cn('ring-2 ring-surface', small)}
        />
      ))}
      {people.length > max ? (
        <span className="flex size-5 items-center justify-center rounded-full bg-bg2 text-[10px] font-bold text-fg2 ring-2 ring-surface">
          +{people.length - max}
        </span>
      ) : null}
    </span>
  );
}

/** Due date chip: warning tone when close, danger once past (design 6.1). */
export function DueChip({ dueAt, done }: { dueAt: string | null; done?: boolean }) {
  const { t, locale } = useI18n();
  const st = dueState(dueAt);
  if (!dueAt || !st) return null;
  const tone = done ? 'none' : st.tone;
  return (
    <span
      title={
        tone === 'danger'
          ? t('boards.card.overdue', { days: st.days })
          : t('boards.card.dueIn', { days: st.days })
      }
      className={cn(
        'inline-flex items-center gap-1 text-[11.5px] font-semibold tn',
        tone === 'danger' ? 'text-danger' : tone === 'warn' ? 'text-warning' : 'text-fg3',
      )}
    >
      <Icon name="calendar" size={12} />
      {formatDate(dueAt, locale, { day: 'numeric', month: 'short' })}
    </span>
  );
}

export function Meta({
  icon,
  children,
}: {
  icon: Parameters<typeof Icon>[0]['name'];
  children: React.ReactNode;
}) {
  return (
    <span className="inline-flex items-center gap-1 text-[11.5px] font-semibold text-fg3 tn">
      <Icon name={icon} size={12} />
      {children}
    </span>
  );
}

/** Column count, "3/3" when a WIP limit exists; over the limit in warning colour. */
export function WipCount({ count, limit }: { count: number; limit: number | null }) {
  const { t } = useI18n();
  const over = limit !== null && count > limit;
  const full = limit !== null && count === limit;
  return (
    <span
      className={cn(
        'rounded-full px-1.5 text-[11.5px] leading-5 font-bold tn',
        over
          ? 'bg-[color-mix(in_srgb,var(--warning)_16%,transparent)] text-warning'
          : full
            ? 'text-fg'
            : 'text-fg3',
      )}
      title={over ? t('boards.column.wipExceeded', { count, limit: limit ?? 0 }) : undefined}
    >
      {limit !== null
        ? t('boards.column.wip', { count, limit })
        : t('boards.column.count', { count })}
    </span>
  );
}

export function PersonOption({ person, me }: { person: UserSummary; me?: boolean }) {
  const { t } = useI18n();
  return (
    <span className="flex min-w-0 items-center gap-2">
      <Avatar
        name={person.name}
        src={person.imageUrl}
        size="sm"
        className="size-[22px] text-[9px]"
      />
      <span className="truncate">
        {me
          ? t('boards.filters.me', { name: person.name.split(' ')[0] ?? person.name })
          : person.name}
      </span>
    </span>
  );
}
