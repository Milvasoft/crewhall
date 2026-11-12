import { type Card, type CardType } from '@crewhall/shared';
import { cn } from '@crewhall/ui';
import { useState } from 'react';
import ReactGridLayout, { useContainerWidth, type Layout as GridLayout } from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import { useShellLayout } from '@/lib/shell';
import { type Layout } from './api';
import { NO_DRAG } from './cardFrame';
import { CardView } from './cards';
import { useEdgeAutoScroll } from './edgeAutoScroll';
import { GRID_COLS, GRID_GAP, ROW_HEIGHT, minSize } from './sizes';

/** Card type dragged out of the gallery; dataTransfer is unreadable during dragover. */
let draggingType: { type: CardType; w: number; h: number } | null = null;

export function startGalleryDrag(type: CardType, w: number, h: number): void {
  draggingType = { type, w, h };
}

export function endGalleryDrag(): void {
  draggingType = null;
}

/**
 * The 12-column card surface (2.1, 2.2): react-grid-layout with vertical compaction, so a
 * dragged card pushes the others and gaps close upwards. Positions are saved on drop.
 */
export function SurfaceGrid({
  cards,
  editable,
  onLayout,
  onDropNew,
  onBackgroundDoubleClick,
}: {
  cards: Card[];
  /** Drag, resize and gallery drops are on (edit mode with rights). */
  editable: boolean;
  onLayout: (layouts: Record<string, Layout>) => void;
  onDropNew: (type: CardType, layout: Layout) => void;
  onBackgroundDoubleClick?: () => void;
}) {
  const { width, containerRef, mounted } = useContainerWidth({ initialWidth: 1100 });
  const phone = useShellLayout() === 'phone';
  const autoScroll = useEdgeAutoScroll(containerRef);
  // The layout just dropped, held in this render: the optimistic cache write reaches `cards`
  // a tick later, and in between the grid would snap the card back to its old slot.
  const [dropped, setDropped] = useState<{ base: Card[]; at: Record<string, Layout> } | null>(null);
  if (dropped && dropped.base !== cards) setDropped(null);
  const layout: GridLayout = cards.map((c) => {
    const [minW, minH] = minSize(c);
    const at = dropped?.base === cards ? dropped.at[c.id] : undefined;
    return { i: c.id, ...(at ?? c.layout), minW, minH };
  });

  const commit = (next: GridLayout) => {
    const out: Record<string, Layout> = {};
    for (const it of next) {
      if (it.i === '__dropping-elem__') continue;
      out[it.i] = { x: it.x, y: it.y, w: it.w, h: it.h };
    }
    setDropped({ base: cards, at: out });
    onLayout(out);
  };

  // Phone (H10): twelve columns would be a few pixels each, so the cards stack in reading order
  // at full width (no drag or resize; the layout is edited on a larger screen).
  if (phone) {
    const ordered = [...cards].sort((a, b) => a.layout.y - b.layout.y || a.layout.x - b.layout.x);
    return (
      <div className="quick-grid flex flex-col" style={{ gap: GRID_GAP }}>
        {ordered.map((c) => (
          <div
            key={c.id}
            className="quick-item"
            style={{ height: Math.min(c.layout.h, 4) * (ROW_HEIGHT + GRID_GAP) - GRID_GAP }}
          >
            <CardView card={c} />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={cn('quick-grid relative min-h-[240px] w-full', editable && 'is-editing')}
      // Room below the last card while editing: a card at the bottom can be pulled further down.
      style={editable ? { paddingBottom: 2 * ROW_HEIGHT + GRID_GAP } : undefined}
      onDoubleClick={(e) => {
        const target = e.target as HTMLElement;
        if (
          onBackgroundDoubleClick &&
          (target === e.currentTarget || target.classList.contains('react-grid-layout'))
        ) {
          onBackgroundDoubleClick();
        }
      }}
    >
      {mounted || width > 0 ? (
        <ReactGridLayout
          width={width}
          layout={layout}
          gridConfig={{
            cols: GRID_COLS,
            rowHeight: ROW_HEIGHT,
            margin: [GRID_GAP, GRID_GAP],
            containerPadding: [0, 0],
          }}
          dragConfig={{ enabled: editable, cancel: `.${NO_DRAG}, input, textarea, [role="menu"]` }}
          resizeConfig={{ enabled: editable, handles: ['se'] }}
          dropConfig={{
            enabled: editable,
            defaultItem: { w: 3, h: 2 },
            onDragOver: () => (draggingType ? { w: draggingType.w, h: draggingType.h } : false),
          }}
          onDragStart={() => autoScroll.start()}
          onResizeStart={() => autoScroll.start()}
          onDragStop={(next) => {
            autoScroll.stop();
            commit(next);
          }}
          onResizeStop={(next) => {
            autoScroll.stop();
            commit(next);
          }}
          onDrop={(_next, item) => {
            const dropped = draggingType;
            draggingType = null;
            if (dropped && item) {
              onDropNew(dropped.type, { x: item.x, y: item.y, w: dropped.w, h: dropped.h });
            }
          }}
        >
          {cards.map((c) => (
            <div key={c.id} className="quick-item">
              <CardView card={c} />
            </div>
          ))}
        </ReactGridLayout>
      ) : null}
    </div>
  );
}
