import { useEffect, useRef } from 'react';

/** How close to the scroller's top or bottom edge the pointer starts scrolling, in px. */
const EDGE = 64;
/** Scroll speed at the very edge, in px per frame. */
const MAX_STEP = 18;
/** How far the surface may stretch past its content during one gesture, in px. */
const MAX_GROW = 4000;

function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let node = el?.parentElement ?? null; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === 'auto' || overflowY === 'scroll') return node;
  }
  return null;
}

/**
 * Scrolls the surface while a card is dragged or resized near the top or bottom of the visible
 * area, so a card at the bottom of the page can still grow or move further down. The grid keeps
 * its height until the gesture ends, so the surface is stretched while the page runs out, and
 * the grid library only reacts to pointer moves, so each scroll step replays the last position.
 */
export function useEdgeAutoScroll(container: { current: HTMLElement | null }) {
  const stopRef = useRef<(() => void) | null>(null);
  useEffect(() => () => stopRef.current?.(), []);

  const start = () => {
    stopRef.current?.();
    const surface = container.current;
    const scroller = scrollParent(surface);
    if (!surface || !scroller) return;
    const baseHeight = surface.offsetHeight;
    let grown = 0;
    let x = 0;
    let y = -1;
    let frame = 0;
    let replaying = false;
    const onMove = (e: MouseEvent) => {
      if (replaying) return;
      x = e.clientX;
      y = e.clientY;
    };
    const tick = () => {
      frame = requestAnimationFrame(tick);
      if (y < 0) return;
      const rect = scroller.getBoundingClientRect();
      let step = 0;
      if (y > rect.bottom - EDGE) step = Math.min(1, (y - (rect.bottom - EDGE)) / EDGE) * MAX_STEP;
      else if (y < rect.top + EDGE) step = -Math.min(1, (rect.top + EDGE - y) / EDGE) * MAX_STEP;
      if (step === 0) return;
      const atEnd = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1;
      if (step > 0 && atEnd && grown < MAX_GROW) {
        grown += Math.round(step);
        surface.style.minHeight = `${baseHeight + grown}px`;
      }
      const before = scroller.scrollTop;
      scroller.scrollTop = before + Math.round(step);
      if (scroller.scrollTop === before) return;
      replaying = true;
      document.dispatchEvent(
        new MouseEvent('mousemove', { clientX: x, clientY: y, bubbles: true, buttons: 1 }),
      );
      replaying = false;
    };
    document.addEventListener('mousemove', onMove, true);
    frame = requestAnimationFrame(tick);
    stopRef.current = () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('mousemove', onMove, true);
      surface.style.minHeight = '';
      stopRef.current = null;
    };
  };

  const stop = () => stopRef.current?.();
  return { start, stop };
}
