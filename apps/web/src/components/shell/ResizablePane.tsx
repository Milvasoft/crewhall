import { cn } from '@crewhall/ui';
import {
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react';
import { useI18n } from '@/lib/i18n/I18nContext';
import { readStorage, StorageKey, writeStorage } from '@/lib/storage';

/**
 * A side panel or list column whose width the person drags, like the module sidebar: the right
 * detail panels (Drive, card, event, comments...) take their handle on the left edge, list
 * columns (mail, vault, approvals) on the right one. Double-click resets, ←/→ step 16 px. Widths
 * are kept per panel on this device. The handle only shows from `md`; a caller's `max-md:` class
 * (or the Workspace's phone panel slot) decides the phone width.
 */

const STEP = 16;
const PANE_MIN = 240;

function load(): Record<string, number> {
  try {
    const raw = readStorage(StorageKey.paneWidths);
    const v = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const out: Record<string, number> = {};
    for (const [k, w] of Object.entries(v)) {
      if (typeof w === 'number' && Number.isFinite(w)) out[k] = w;
    }
    return out;
  } catch {
    return {};
  }
}

let widths = load();
const listeners = new Set<() => void>();

function setPaneWidth(id: string, width: number | null) {
  const next = { ...widths };
  if (width === null) delete next[id];
  else next[id] = width;
  widths = next;
  writeStorage(StorageKey.paneWidths, JSON.stringify(widths));
  listeners.forEach((l) => l());
}

/** Tests: forget every width. */
export function clearPaneWidths(): void {
  widths = {};
  listeners.forEach((l) => l());
}

function usePaneWidth(id: string): number | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => widths[id] ?? null,
    () => null,
  );
}

/**
 * A panel beside the content: at most 720 px and 60 % of the window, and it leaves the rail, a
 * sidebar and a readable middle (~640 px together). A panel over the content (the assistant):
 * up to 960 px, the rail stays visible. Never under the minimum.
 */
function paneMax(min: number, overlay: boolean): number {
  const viewport = typeof window === 'undefined' ? 1440 : window.innerWidth;
  const cap = overlay
    ? Math.min(960, viewport - 64)
    : Math.min(720, Math.round(viewport * 0.6), viewport - 640);
  return Math.max(min, cap);
}

export interface PaneSize {
  id: string;
  side: 'right' | 'left';
  width: number;
  min: number;
  max: number;
}

/** The panel's width (stored or default, within bounds), for a panel that renders `PaneEdge` itself. */
export function usePaneSize(
  id: string,
  side: 'right' | 'left',
  defaultWidth: number,
  min = PANE_MIN,
  /** Floats over the content instead of taking room beside it. */
  overlay = false,
): PaneSize {
  const stored = usePaneWidth(id);
  const max = paneMax(min, overlay);
  const width = Math.round(Math.min(max, Math.max(min, stored ?? defaultWidth)));
  return { id, side, width, min, max };
}

/** `style` for the element whose width follows the pane (`w-(--pane-w)` in its classes). */
export const paneStyle = (size: PaneSize) => ({ '--pane-w': `${size.width}px` }) as CSSProperties;

/**
 * The draggable edge. During a drag the width is written straight to `target` (its `--pane-w`),
 * no re-render per move; the store follows on release.
 */
export function PaneEdge({
  size,
  target,
}: {
  size: PaneSize;
  target: RefObject<HTMLElement | null>;
}) {
  const { t } = useI18n();
  const { id, side, width, min, max } = size;
  const drag = useRef<{ x: number; from: number; now: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const clamp = (w: number) => Math.round(Math.min(max, Math.max(min, w)));
  // Dragging away from the content widens: leftwards for a right panel.
  const dir = side === 'right' ? -1 : 1;

  const end = (commit: boolean) => {
    const d = drag.current;
    drag.current = null;
    setDragging(false);
    document.documentElement.style.removeProperty('cursor');
    document.documentElement.style.removeProperty('user-select');
    if (!d) return;
    if (commit) setPaneWidth(id, d.now);
    else target.current?.style.setProperty('--pane-w', `${width}px`);
  };

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={t('shell.resizePanel')}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={width}
      aria-valuetext={`${width} px`}
      data-dragging={dragging || undefined}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        drag.current = { x: e.clientX, from: width, now: width };
        setDragging(true);
        document.documentElement.style.cursor = 'col-resize';
        document.documentElement.style.userSelect = 'none';
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        d.now = clamp(d.from + dir * (e.clientX - d.x));
        target.current?.style.setProperty('--pane-w', `${d.now}px`);
      }}
      onPointerUp={() => end(true)}
      onPointerCancel={() => end(false)}
      onLostPointerCapture={() => drag.current && end(true)}
      onDoubleClick={() => setPaneWidth(id, null)}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        const outward = (e.key === 'ArrowRight' ? 1 : -1) * dir;
        setPaneWidth(id, clamp(width + outward * STEP));
      }}
      className={cn(
        'group absolute inset-y-0 z-20 w-2 cursor-col-resize touch-none outline-none max-md:hidden',
        side === 'right' ? '-left-1' : '-right-1',
      )}
    >
      <span
        aria-hidden="true"
        className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-transparent transition-colors duration-[var(--t-fast)] group-hover:bg-line2 group-focus-visible:bg-fg3 group-data-[dragging]:bg-accent"
      />
    </div>
  );
}

/**
 * A panel in the page flow: a frame of the stored width with the edge on it, so a panel that
 * scrolls itself neither clips nor scrolls the handle.
 */
export function ResizablePane({
  id,
  side,
  defaultWidth,
  min,
  className,
  children,
}: {
  /** Key of the stored width ("drive-detail"). */
  id: string;
  /** Where the panel sits: a right panel resizes from its left edge, a left column from its right. */
  side: 'right' | 'left';
  defaultWidth: number;
  min?: number;
  /** Classes of the frame (e.g. its `max-md:` layout); the panel inside fills it. */
  className?: string;
  children: ReactNode;
}) {
  const size = usePaneSize(id, side, defaultWidth, min);
  const frame = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={frame}
      data-pane={id}
      style={paneStyle(size)}
      className={cn('relative flex min-h-0 w-(--pane-w) shrink-0', className)}
    >
      {children}
      <PaneEdge size={size} target={frame} />
    </div>
  );
}
