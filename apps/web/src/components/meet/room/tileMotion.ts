import { useLayoutEffect, useRef, type RefObject } from 'react';
import { isReducedMotion } from '@/lib/motion';

const MS = 260;
const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)';
const MOVE_ID = 'meet-tile-move';

interface Seen {
  el: HTMLElement;
  rect: DOMRect;
}

/**
 * The grid's tiles when people come and go: a new tile scales and fades in, the others slide to
 * their new places (FLIP), a tile that left fades out where it was. Tiles carry `data-tile`; the
 * leaving one is shown in `ghosts`, an empty layer over the grid (React never renders into it).
 * Only a change of who is on the grid animates: resizing the window or speaking does not.
 * Reduced motion: no animation at all.
 */
export function useTileMotion(
  grid: RefObject<HTMLElement | null>,
  ghosts: RefObject<HTMLElement | null>,
) {
  const last = useRef<Map<string, Seen> | null>(null);
  useLayoutEffect(() => {
    const root = grid.current;
    if (!root) return;
    const tiles = [...root.querySelectorAll<HTMLElement>(':scope > [data-tile]')];
    const now = new Map<string, Seen>(
      tiles.map((el) => [el.dataset.tile ?? '', { el, rect: el.getBoundingClientRect() }]),
    );
    const before = last.current;
    last.current = now;
    if (!before || isReducedMotion() || typeof root.animate !== 'function') return;
    const changed = before.size !== now.size || [...now.keys()].some((k) => !before.has(k));
    if (!changed) return;

    for (const [key, { el, rect }] of now) {
      const was = before.get(key);
      if (!was) {
        el.animate(
          [
            { opacity: 0, transform: 'scale(0.92)' },
            { opacity: 1, transform: 'none' },
          ],
          { duration: MS, easing: EASE },
        );
        continue;
      }
      el.getAnimations?.()
        .filter((a) => a.id === MOVE_ID)
        .forEach((a) => a.cancel());
      const dx = was.rect.left - rect.left;
      const dy = was.rect.top - rect.top;
      const sx = rect.width ? was.rect.width / rect.width : 1;
      const sy = rect.height ? was.rect.height / rect.height : 1;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(sx - 1) < 0.01) continue;
      const a = el.animate(
        [
          {
            transformOrigin: 'top left',
            transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`,
          },
          { transformOrigin: 'top left', transform: 'none' },
        ],
        { duration: MS, easing: EASE },
      );
      a.id = MOVE_ID;
    }

    const layer = ghosts.current;
    if (!layer) return;
    const base = layer.getBoundingClientRect();
    for (const [key, { el, rect }] of before) {
      if (now.has(key)) continue;
      // The element React just removed: shown once more where it was, fading out.
      Object.assign(el.style, {
        position: 'absolute',
        left: `${rect.left - base.left}px`,
        top: `${rect.top - base.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
      });
      layer.appendChild(el);
      const a = el.animate(
        [
          { opacity: 1, transform: 'none' },
          { opacity: 0, transform: 'scale(0.94)' },
        ],
        { duration: MS, easing: EASE, fill: 'forwards' },
      );
      const drop = () => el.remove();
      a.onfinish = drop;
      a.oncancel = drop;
    }
  });
}
