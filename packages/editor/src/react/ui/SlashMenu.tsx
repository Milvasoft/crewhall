import { useLayoutEffect, useRef, useState, useSyncExternalStore, type JSX } from 'react';
import { createPortal } from 'react-dom';
import type { SlashStore } from '../extensions/slash';
import type { EditorLabels } from '../labels';
import { Icon } from './icons';

const GAP = 6;

/** The "/" popup: absolutely positioned under the caret, flips above near the viewport bottom. */
export function SlashMenu({
  store,
  labels,
  idPrefix,
}: {
  store: SlashStore;
  labels: EditorLabels;
  idPrefix: string;
}): JSX.Element | null {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const menuRef = useRef<HTMLDivElement>(null);
  const [above, setAbove] = useState(false);

  const rect = state?.rect ?? null;
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el || !rect) return;
    const height = el.offsetHeight;
    setAbove(rect.bottom + GAP + height > window.innerHeight && rect.top - GAP - height > 0);
  }, [rect]);

  useLayoutEffect(() => {
    if (!state) return;
    const active = menuRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    active?.scrollIntoView?.({ block: 'nearest' });
  }, [state]);

  if (!state || typeof document === 'undefined') return null;
  const left = rect ? rect.left + window.scrollX : 0;
  const top = rect
    ? above
      ? rect.top + window.scrollY - GAP
      : rect.bottom + window.scrollY + GAP
    : 0;

  const menu = (
    <div
      ref={menuRef}
      className="ch-editor-layer ch-slash"
      style={{
        position: 'absolute',
        left,
        top,
        transform: above ? 'translateY(-100%)' : undefined,
      }}
      onMouseDown={(e) => e.preventDefault()}
    >
      {state.items.length ? (
        <div role="listbox" aria-label={labels.slashMenu} className="ch-slash-list">
          {state.items.map((item, i) => (
            <div
              key={item.id}
              id={`${idPrefix}-${item.id}`}
              role="option"
              aria-selected={i === state.selected}
              className="ch-slash-item"
              onMouseEnter={() => store.select(i)}
              onClick={() => state.choose(item)}
            >
              <span className="ch-slash-icon">
                <Icon name={item.icon} size={18} />
              </span>
              <span className="ch-slash-text">
                <span className="ch-slash-title">{item.title}</span>
                <span className="ch-slash-desc">{item.description}</span>
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div className="ch-slash-empty" role="status">
          {labels.slashEmpty}
        </div>
      )}
    </div>
  );
  return createPortal(menu, document.body);
}
