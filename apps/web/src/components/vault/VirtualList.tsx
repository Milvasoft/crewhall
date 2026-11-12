import { cn } from '@crewhall/ui';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Windowed list with fixed row height (H13): only the rows in view, plus a few above and
 * below, are in the DOM, so 1000 items scroll like 20. Before the first measurement (and in
 * tests, where layout is zero) the window is assumed one screen tall.
 */
export function VirtualList<T>({
  items,
  rowHeight,
  getKey,
  renderRow,
  className,
  activeIndex,
  footer,
  overscan = 8,
  'aria-label': ariaLabel,
}: {
  items: T[];
  rowHeight: number;
  getKey: (item: T) => string;
  renderRow: (item: T, index: number) => ReactNode;
  className?: string;
  /** Kept in view when it changes (keyboard / URL selection). */
  activeIndex?: number;
  footer?: ReactNode;
  overscan?: number;
  'aria-label'?: string;
}) {
  const ref = useRef<HTMLUListElement>(null);
  const frame = useRef(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(() =>
    typeof window === 'undefined' ? 800 : window.innerHeight,
  );

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      if (el.clientHeight > 0) setHeight(el.clientHeight);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el || activeIndex === undefined || activeIndex < 0) return;
    const top = activeIndex * rowHeight;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + rowHeight > el.scrollTop + el.clientHeight) {
      el.scrollTop = top + rowHeight - el.clientHeight;
    }
  }, [activeIndex, rowHeight]);

  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const last = Math.min(items.length, Math.ceil((scrollTop + height) / rowHeight) + overscan);

  return (
    <ul
      ref={ref}
      aria-label={ariaLabel}
      className={cn('relative min-h-0 flex-1 overflow-y-auto', className)}
      onScroll={(e) => {
        const top = e.currentTarget.scrollTop;
        cancelAnimationFrame(frame.current);
        frame.current = requestAnimationFrame(() => setScrollTop(top));
      }}
    >
      <li aria-hidden="true" style={{ height: first * rowHeight }} />
      {items.slice(first, last).map((item, i) => (
        <li key={getKey(item)} style={{ height: rowHeight }}>
          {renderRow(item, first + i)}
        </li>
      ))}
      <li aria-hidden="true" style={{ height: (items.length - last) * rowHeight }} />
      {footer}
    </ul>
  );
}
