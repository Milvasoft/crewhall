import { useCallback, useEffect, useMemo, useState } from 'react';

/**
 * Row selection of a list or table (doc "Tablolarda tümünü seç"): kept to the rows on screen (a
 * filter or a refresh drops rows that went away), with the header box state and the shortcuts
 * Ctrl A (select all shown rows) and Esc (clear).
 */
export interface Selection {
  selected: ReadonlySet<string>;
  count: number;
  /** For the header box: nothing, some or every shown row. */
  state: 'none' | 'some' | 'all';
  has: (id: string) => boolean;
  toggle: (id: string) => void;
  /** Header box: select every shown row, or clear. */
  setAll: (all: boolean) => void;
  clear: () => void;
  replace: (ids: Iterable<string>) => void;
}

export function useSelection(ids: readonly string[]): Selection {
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  const key = ids.join('\u0000');
  const selected = useMemo(() => {
    const shown = new Set(ids);
    return new Set([...picked].filter((id) => shown.has(id)));
    // `key` stands for the ids' content; the array itself may be new on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked, key]);
  const count = selected.size;
  const state = count === 0 ? 'none' : count === ids.length ? 'all' : 'some';
  const clear = useCallback(() => setPicked(new Set()), []);
  return {
    selected,
    count,
    state,
    has: (id) => selected.has(id),
    toggle: (id) =>
      setPicked((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    setAll: (all) => setPicked(all ? new Set(ids) : new Set()),
    clear,
    replace: (next) => setPicked(new Set(next)),
  };
}

/**
 * Ctrl A selects every shown row, Esc clears, while `enabled`; typing in a field, an open menu
 * or dialog keep their keys.
 */
export function useSelectionKeys(selection: Selection, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName))) {
        return;
      }
      if (document.querySelector('[role="dialog"],[role="menu"]')) return;
      if (e.key.toLowerCase() === 'a' && (e.ctrlKey || e.metaKey) && !e.altKey) {
        e.preventDefault();
        selection.setAll(true);
      } else if (e.key === 'Escape' && selection.count) {
        selection.clear();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
}
