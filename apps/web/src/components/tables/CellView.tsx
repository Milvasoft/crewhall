import { type CellValue, type TableAttachment, type TableField } from '@crewhall/shared';
import { Avatar, cn, Icon } from '@crewhall/ui';
import { formatDate, formatTime } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { CHOICE_CLASS, formatNumber, isEmptyCell } from '@/lib/tables/fields';
import { useTableCtx } from './context';

export function ChoiceChip({ label, color }: { label: string; color: keyof typeof CHOICE_CLASS }) {
  return (
    <span className={cn('inline-flex h-6 max-w-full items-center truncate rounded-full px-2 text-xs font-semibold', CHOICE_CLASS[color])}>
      {label}
    </span>
  );
}

/** A cell, read-only: chips, avatars, stars, links, dates in the reader's language. */
export function CellView({ field, value, compact }: { field: TableField; value: CellValue | undefined; compact?: boolean }) {
  const { locale } = useI18n();
  const { people, titles } = useTableCtx();
  if (field.type === 'checkbox') {
    return (
      <span
        className={cn(
          'flex size-[18px] items-center justify-center rounded-[5px]',
          value === true ? 'bg-accent text-accent-fg' : 'shadow-[inset_0_0_0_1.5px_var(--fg3)]',
        )}
        aria-label={value === true ? '✓' : ''}
      >
        {value === true ? <Icon name="check" size={12} strokeWidth={3} /> : null}
      </span>
    );
  }
  if (isEmptyCell(value)) return null;
  switch (field.type) {
    case 'single_select': {
      const c = field.options.choices?.find((x) => x.id === value);
      return c ? <ChoiceChip label={c.label} color={c.color} /> : null;
    }
    case 'multi_select':
      return (
        <span className={cn('flex gap-1', compact ? 'overflow-hidden' : 'flex-wrap')}>
          {(value as string[]).map((id) => {
            const c = field.options.choices?.find((x) => x.id === id);
            return c ? <ChoiceChip key={id} label={c.label} color={c.color} /> : null;
          })}
        </span>
      );
    case 'person':
      return (
        <span className={cn('flex gap-1.5', compact ? 'overflow-hidden' : 'flex-wrap')}>
          {(value as string[]).map((id) => {
            const u = people.get(id);
            return (
              <span key={id} className="flex shrink-0 items-center gap-1.5 text-sm">
                <Avatar name={u?.name ?? '?'} src={u?.imageUrl} size="sm" />
                {compact && (value as string[]).length > 1 ? null : <span className="truncate">{u?.name ?? id}</span>}
              </span>
            );
          })}
        </span>
      );
    case 'relation': {
      const map = titles.get(field.options.tableId ?? '');
      return (
        <span className={cn('flex gap-1', compact ? 'overflow-hidden' : 'flex-wrap')}>
          {(value as string[]).map((id) => (
            <span key={id} className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md bg-bg2 px-2 text-xs font-semibold">
              <Icon name="layers" size={12} />
              {map?.get(id) || '…'}
            </span>
          ))}
        </span>
      );
    }
    case 'attachment':
      return (
        <span className={cn('flex gap-1', compact ? 'overflow-hidden' : 'flex-wrap')}>
          {(value as TableAttachment[]).map((a) => (
            <span key={a.nodeId} className="inline-flex h-6 max-w-[180px] shrink-0 items-center gap-1 rounded-md bg-bg2 px-2 text-xs">
              <Icon name="file" size={12} />
              <span className="truncate">{a.name}</span>
            </span>
          ))}
        </span>
      );
    case 'rating': {
      const max = field.options.max ?? 5;
      return (
        <span className="flex text-accent" aria-label={`${String(value)} / ${max}`}>
          {Array.from({ length: max }, (_, i) => (
            <Icon key={i} name="star" size={14} className={i < Number(value) ? 'fill-current' : 'text-fg3'} />
          ))}
        </span>
      );
    }
    case 'number':
    case 'currency':
      return <span className="block w-full text-right tabular-nums">{formatNumber(field, value, locale)}</span>;
    case 'rollup':
    case 'formula':
      return typeof value === 'number' ? (
        <span className="block w-full text-right tabular-nums">{formatNumber(field, value, locale)}</span>
      ) : (
        <span className="truncate">{Array.isArray(value) ? value.join(', ') : String(value)}</span>
      );
    case 'date':
    case 'created_at':
    case 'updated_at': {
      const s = String(value);
      const withTime = field.type !== 'date' || field.options.includeTime === true;
      return (
        <span className="truncate tabular-nums">
          {formatDate(s.length === 10 ? `${s}T12:00:00Z` : s, locale)}
          {withTime && s.length > 10 ? ` ${formatTime(s, locale)}` : ''}
        </span>
      );
    }
    case 'url':
      return (
        <a href={String(value)} target="_blank" rel="noreferrer" className="truncate text-fg underline underline-offset-2" onClick={(e) => e.stopPropagation()}>
          {String(value).replace(/^https?:\/\//, '')}
        </a>
      );
    case 'email':
      return (
        <a href={`mailto:${String(value)}`} className="truncate underline underline-offset-2" onClick={(e) => e.stopPropagation()}>
          {String(value)}
        </a>
      );
    case 'lookup':
      return <span className="truncate">{(value as unknown[]).map((x) => (x === null ? '' : String(x))).join(', ')}</span>;
    default:
      return <span className={cn(compact ? 'truncate' : 'whitespace-pre-wrap break-words')}>{String(value)}</span>;
  }
}
