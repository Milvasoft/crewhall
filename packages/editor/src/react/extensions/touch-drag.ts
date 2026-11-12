import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import { blockAround, moveBlockTo, type BlockAt } from './blocks';

/**
 * Touch screens (the mobile app's editor): a long press on a block lifts it, the finger drags a
 * drop line between blocks and letting go moves the block there in one transaction (Yjs syncs
 * it, undo takes it back). The mouse uses the ⋮⋮ handle instead.
 *
 * Only while the editor is not focused (the keyboard is closed): while typing, a long press
 * keeps selecting text as the system does.
 */

export const LONG_PRESS_MS = 450;
/** A finger moving further than this before the long press is a scroll, not a drag. */
const SLOP_PX = 8;

interface DragState {
  /** The lifted block. */
  from: number | null;
  /** Boundary the block would land on. */
  to: number | null;
}

export const touchDragKey = new PluginKey<DragState>('touchBlockDrag');

/** Where a drop at (x, y) lands: before or after the block under the finger. */
export function dropTarget(view: EditorView, x: number, y: number, lifted: BlockAt): number | null {
  const hit = view.posAtCoords({ left: x, top: y });
  if (!hit) return null;
  const over = blockAround(view.state, hit.inside >= 0 ? hit.inside : hit.pos);
  if (!over) return null;
  const end = over.pos + over.node.nodeSize;
  // Inside the lifted block itself: no move.
  if (over.pos >= lifted.pos && end <= lifted.pos + lifted.node.nodeSize) return null;
  const dom = view.nodeDOM(over.pos);
  const rect = dom instanceof HTMLElement ? dom.getBoundingClientRect() : null;
  const before = rect ? y < rect.top + rect.height / 2 : false;
  return before ? over.pos : end;
}

function decorations(state: EditorState, drag: DragState): DecorationSet {
  if (drag.from === null) return DecorationSet.empty;
  const node = state.doc.nodeAt(drag.from);
  if (!node) return DecorationSet.empty;
  const decos = [
    Decoration.node(drag.from, drag.from + node.nodeSize, { class: 'ch-touch-lifted' }),
  ];
  if (drag.to !== null) {
    decos.push(
      Decoration.widget(
        drag.to,
        () => {
          const line = document.createElement('div');
          line.className = 'ch-touch-drop';
          line.setAttribute('aria-hidden', 'true');
          return line;
        },
        { side: -1, key: `drop-${drag.to}` },
      ),
    );
  }
  return DecorationSet.create(state.doc, decos);
}

export const TouchBlockDrag = Extension.create({
  name: 'touchBlockDrag',
  addProseMirrorPlugins() {
    return [
      new Plugin<DragState>({
        key: touchDragKey,
        state: {
          init: () => ({ from: null, to: null }),
          apply: (tr, value) => {
            const meta = tr.getMeta(touchDragKey) as DragState | undefined;
            if (meta) return meta;
            if (!tr.docChanged || value.from === null) return value;
            return {
              from: tr.mapping.map(value.from),
              to: value.to === null ? null : tr.mapping.map(value.to),
            };
          },
        },
        props: {
          decorations: (state) => decorations(state, touchDragKey.getState(state)!),
        },
        // Own listeners: ProseMirror's touch listeners are passive, and a drag must stop the
        // page from scrolling under the finger.
        view: (view) => {
          let timer: ReturnType<typeof setTimeout> | null = null;
          let start: { x: number; y: number } | null = null;
          let lifted: BlockAt | null = null;

          const set = (drag: DragState) =>
            view.dispatch(view.state.tr.setMeta(touchDragKey, drag).setMeta('addToHistory', false));
          const cancel = () => {
            if (timer) clearTimeout(timer);
            timer = null;
            start = null;
            if (lifted) {
              lifted = null;
              set({ from: null, to: null });
            }
          };

          const onStart = (event: TouchEvent) => {
            cancel();
            const touch = event.touches[0];
            if (!view.editable || view.hasFocus() || event.touches.length !== 1 || !touch) return;
            const at = { x: touch.clientX, y: touch.clientY };
            start = at;
            timer = setTimeout(() => {
              timer = null;
              const hit = view.posAtCoords({ left: at.x, top: at.y });
              const block = hit
                ? blockAround(view.state, hit.inside >= 0 ? hit.inside : hit.pos)
                : null;
              if (!block) return;
              lifted = block;
              navigator.vibrate?.(12);
              set({ from: block.pos, to: null });
            }, LONG_PRESS_MS);
          };
          const onMove = (event: TouchEvent) => {
            const touch = event.touches[0];
            if (!touch || !start) return;
            if (!lifted) {
              const moved = Math.hypot(touch.clientX - start.x, touch.clientY - start.y);
              if (moved > SLOP_PX) cancel();
              return;
            }
            event.preventDefault();
            const current = touchDragKey.getState(view.state)!;
            const lift = { pos: current.from ?? lifted.pos, node: lifted.node };
            set({ from: lift.pos, to: dropTarget(view, touch.clientX, touch.clientY, lift) });
          };
          const onEnd = (event: TouchEvent) => {
            if (!lifted) {
              cancel();
              return;
            }
            event.preventDefault();
            const drag = touchDragKey.getState(view.state)!;
            const block = drag.from === null ? null : { pos: drag.from, node: lifted.node };
            lifted = null;
            start = null;
            set({ from: null, to: null });
            if (block && drag.to !== null) moveBlockTo(view, block, drag.to);
          };
          // The system's long-press menu would cover the drag.
          const onMenu = (event: Event) => {
            if (lifted) event.preventDefault();
          };

          const dom = view.dom;
          dom.addEventListener('touchstart', onStart, { passive: true });
          dom.addEventListener('touchmove', onMove, { passive: false });
          dom.addEventListener('touchend', onEnd);
          dom.addEventListener('touchcancel', cancel);
          dom.addEventListener('contextmenu', onMenu);
          return {
            destroy: () => {
              if (timer) clearTimeout(timer);
              dom.removeEventListener('touchstart', onStart);
              dom.removeEventListener('touchmove', onMove);
              dom.removeEventListener('touchend', onEnd);
              dom.removeEventListener('touchcancel', cancel);
              dom.removeEventListener('contextmenu', onMenu);
            },
          };
        },
      }),
    ];
  },
});
