import { type BoardLabel, type UserSummary } from '@crewhall/shared';
import { Checkbox, cn, Icon, Popover, PopoverContent, PopoverTrigger } from '@crewhall/ui';
import { useState, type ReactNode } from 'react';
import { useI18n } from '@/lib/i18n/I18nContext';
import { LabelChip, PersonOption } from './parts';

/**
 * Checkbox list in a popover with a search box: people (with "Ben" and "Atanmamış"
 * shortcuts in filters) and labels. Used by the filter bar, card detail and bulk actions.
 */
export interface PickOption {
  id: string;
  search: string;
  node: ReactNode;
  count?: number;
}

export function MultiPicker({
  trigger,
  options,
  value,
  onChange,
  placeholder,
  single,
  align = 'start',
}: {
  trigger: ReactNode;
  options: PickOption[];
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  single?: boolean;
  align?: 'start' | 'end';
}) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const shown = q.trim()
    ? options.filter((o) => o.search.toLocaleLowerCase('tr').includes(q.toLocaleLowerCase('tr')))
    : options;
  const toggle = (id: string) => {
    if (single) {
      onChange(value.includes(id) ? [] : [id]);
      setOpen(false);
      return;
    }
    onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent align={align} className="w-[260px] p-1.5">
        {placeholder ? (
          <label className="mb-1 flex h-9 items-center gap-2 rounded-md bg-bg2 px-2.5">
            <Icon name="search" size={15} className="text-fg3" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={placeholder}
              className="min-w-0 flex-1 bg-transparent text-[13.5px] outline-none placeholder:text-fg3"
            />
          </label>
        ) : null}
        <div
          role="listbox"
          aria-multiselectable={!single}
          className="flex max-h-[280px] flex-col overflow-y-auto"
        >
          {shown.map((o) => {
            const on = value.includes(o.id);
            return (
              <button
                key={o.id}
                type="button"
                role="option"
                aria-selected={on}
                onClick={() => toggle(o.id)}
                className={cn(
                  'flex h-9 shrink-0 items-center gap-2.5 rounded-sm px-2 text-left text-[13.5px] hover:bg-bg2',
                  on && 'font-semibold',
                )}
              >
                {single ? null : (
                  <Checkbox
                    checked={on}
                    tabIndex={-1}
                    aria-hidden="true"
                    className="pointer-events-none"
                  />
                )}
                <span className="min-w-0 flex-1 truncate">{o.node}</span>
                {o.count !== undefined ? (
                  <span className="text-xs text-fg3 tn">{o.count}</span>
                ) : null}
                {single && on ? <Icon name="check" size={15} /> : null}
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function peopleOptions(
  people: UserSummary[],
  meId: string,
  counts?: Map<string, number>,
): PickOption[] {
  const me = people.find((p) => p.id === meId);
  const rest = people.filter((p) => p.id !== meId);
  return [...(me ? [me] : []), ...rest].map((p) => ({
    id: p.id,
    search: `${p.name} ${p.email}`,
    node: <PersonOption person={p} me={p.id === meId} />,
    count: counts?.get(p.id),
  }));
}

export function labelOptions(labels: BoardLabel[], counts?: Map<string, number>): PickOption[] {
  return labels.map((l) => ({
    id: l.id,
    search: l.name,
    node: <LabelChip label={l} />,
    count: counts?.get(l.id),
  }));
}

export function useNoMatchText() {
  const { t } = useI18n();
  return t('boards.filters.noMatch');
}
