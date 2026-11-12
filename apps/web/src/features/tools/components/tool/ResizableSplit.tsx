// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/components/tool/ResizableSplit.tsx. See THIRD_PARTY.md.
import { useI18n } from '@/lib/i18n/I18nContext';
import { useCallback, useRef, useState } from 'react';
import { cn } from '@/features/tools/components/ui/cn';
import { PaneContext } from './paneContext';

type Collapsed = 'none' | 'left' | 'right';

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

function ExpandChevron({ side }: { side: 'left' | 'right' }) {
  // Points "outward" (the direction the pane will grow when expanded).
  const d = side === 'left' ? 'm9 6 6 6-6 6' : 'm15 6-6 6 6 6';
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className="h-4 w-4 shrink-0"
      aria-hidden
    >
      <path strokeLinecap="round" strokeLinejoin="round" d={d} />
    </svg>
  );
}

/** The narrow, clickable placeholder shown in place of a collapsed pane. */
function CollapsedStrip({
  label,
  side,
  onExpand,
}: {
  label: string;
  side: 'left' | 'right';
  onExpand: () => void;
}) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      onClick={onExpand}
      title={t('tools.common.expandNamed', { name: label })}
      aria-label={t('tools.common.expandNamed', { name: label })}
      className={cn(
        'group flex shrink-0 items-center gap-2 rounded-lg border border-line bg-bg2 text-fg2 transition-colors hover:text-fg',
        // Horizontal bar when stacked (mobile); a slim vertical rail on desktop.
        'w-full justify-center px-3 py-2 lg:h-auto lg:w-9 lg:flex-col lg:px-0 lg:py-3',
      )}
    >
      <ExpandChevron side={side} />
      <span className="text-xs font-semibold uppercase tracking-wide lg:[writing-mode:vertical-rl] lg:rotate-180">
        {label}
      </span>
    </button>
  );
}

export interface ResizableSplitProps {
  left: React.ReactNode;
  right: React.ReactNode;
  /** Labels shown on the collapsed strips. */
  leftLabel: string;
  rightLabel: string;
  /** Optional control rendered on the divider (e.g. a swap button). */
  center?: React.ReactNode;
  /** Initial left share, 0..1. Reset on every mount (not persisted). */
  initialRatio?: number;
  /** Smallest share either side may be dragged to. */
  minRatio?: number;
  className?: string;
}

/**
 * Two panes side by side (stacked on mobile) with a draggable divider to
 * rebalance them, and a per-pane collapse that folds a pane down to a thin
 * strip so the other fills the space. Layout state is in-memory only, so it
 * resets on each visit; pane content is never touched or persisted.
 *
 * Each pane is wrapped in a {@link PaneContext} so the card inside can render
 * its own collapse button (see ToolEditor).
 */
export function ResizableSplit({
  left,
  right,
  leftLabel,
  rightLabel,
  center,
  initialRatio = 0.5,
  minRatio = 0.2,
  className,
}: ResizableSplitProps) {
  const [ratio, setRatio] = useState(() => clamp(initialRatio, minRatio, 1 - minRatio));
  const [collapsed, setCollapsed] = useState<Collapsed>('none');
  const containerRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    dragging.current = true;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  }, []);

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      setRatio(clamp((e.clientX - rect.left) / rect.width, minRatio, 1 - minRatio));
    },
    [minRatio],
  );

  const endDrag = useCallback((e: React.PointerEvent) => {
    dragging.current = false;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  }, []);

  const leftControls = { collapse: () => setCollapsed('left') };
  const rightControls = { collapse: () => setCollapsed('right') };

  return (
    <div
      ref={containerRef}
      className={cn('flex min-h-0 flex-col gap-3 lg:flex-row lg:gap-0', className)}
    >
      {collapsed === 'left' ? (
        <CollapsedStrip label={leftLabel} side="left" onExpand={() => setCollapsed('none')} />
      ) : (
        <div
          className="flex min-h-0 min-w-0 flex-col lg:flex-1"
          style={
            collapsed === 'none'
              ? { flexBasis: `${ratio * 100}%`, flexGrow: 0, flexShrink: 1 }
              : undefined
          }
        >
          <PaneContext.Provider value={leftControls}>{left}</PaneContext.Provider>
        </div>
      )}

      {/* Divider (desktop): drag to resize; also hosts the optional center rail. */}
      {collapsed === 'none' && (
        <div
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          className="group relative hidden shrink-0 cursor-col-resize items-center justify-center lg:flex lg:w-3"
          role="separator"
          aria-orientation="vertical"
        >
          <span className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-line transition-colors group-hover:bg-line-strong" />
          {center ? (
            <div className="relative z-10">{center}</div>
          ) : (
            <span className="pointer-events-none absolute top-1/2 h-8 w-1 -translate-y-1/2 rounded-full bg-line transition-colors group-hover:bg-line-strong" />
          )}
        </div>
      )}

      {/* Center rail on mobile (stacked) keeps swap controls reachable. */}
      {collapsed === 'none' && center && (
        <div className="flex items-center justify-center lg:hidden">{center}</div>
      )}

      {collapsed === 'right' ? (
        <CollapsedStrip label={rightLabel} side="right" onExpand={() => setCollapsed('none')} />
      ) : (
        <div className="flex min-h-0 min-w-0 flex-col lg:flex-1">
          <PaneContext.Provider value={rightControls}>{right}</PaneContext.Provider>
        </div>
      )}
    </div>
  );
}
