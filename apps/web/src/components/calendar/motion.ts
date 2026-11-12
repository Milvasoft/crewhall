import { type CalendarView } from '@crewhall/shared';
import { motion } from '@crewhall/ui/tokens';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { isReducedMotion } from '@/lib/motion';
import {
  enterMotion,
  springFrames,
  SWIPE,
  type EnterMotion,
  type Step,
} from '@/lib/calendar/swipe';

/**
 * Calendar motion helpers (roadmap 14). Web Animations on transform and opacity only, nothing
 * when motion is reduced (the OS setting or the account switch).
 */

const canAnimate = (el: Element | null): el is HTMLElement =>
  el instanceof HTMLElement && typeof el.animate === 'function' && !isReducedMotion();

export const translateX = (x: number) => `translate3d(${x}px, 0, 0)`;

/** Counts view and period changes with how the new one enters (null on the first render). */
export function useEnterMotion(
  view: CalendarView,
  first: string,
): { motion: EnterMotion | null; n: number } {
  const [s, setS] = useState<{
    view: CalendarView;
    first: string;
    motion: EnterMotion | null;
    n: number;
  }>({ view, first, motion: null, n: 0 });
  if (s.view !== view || s.first !== first) {
    setS({ view, first, motion: enterMotion(s, { view, first }), n: s.n + 1 });
  }
  return s;
}

/** A later period slides in from the right with a spring, a finer view zooms in. */
export function playEnter(el: HTMLElement | null, m: EnterMotion, width: number) {
  if (!canAnimate(el)) return;
  if (m.kind === 'slide') {
    const offset = m.dir * Math.max(64, width * 0.22);
    const { values, duration } = springFrames(offset, 0, { stiffness: 220, damping: 24 });
    const last = values.length - 1;
    el.animate(
      values.map((x, i) => ({
        transform: translateX(x),
        opacity: Math.min(1, 0.15 + (i / Math.max(1, last)) * 3),
      })),
      { duration, easing: 'linear' },
    );
  } else if (m.kind === 'zoom') {
    el.animate(
      [
        { transform: `scale(${m.dir > 0 ? 0.94 : 1.05})`, opacity: 0 },
        { transform: 'none', opacity: 1 },
      ],
      { duration: motion.panel, easing: motion.easeOut },
    );
  } else {
    el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: motion.base, easing: motion.easeOut });
  }
}

/** The header date follows the period: it slides a little from the same side and fades in. */
export function playTitle(el: HTMLElement | null, m: EnterMotion) {
  if (!canAnimate(el)) return;
  const from = m.kind === 'slide' ? translateX(m.dir * 12) : 'none';
  el.animate(
    [
      { transform: from, opacity: 0 },
      { transform: 'none', opacity: 1 },
    ],
    { duration: motion.panel, easing: motion.easeOut },
  );
}

/** A moved occurrence lands with a small spring (every chip of it, multi-day ones too). */
export function settleOccurrence(key: string) {
  if (typeof document === 'undefined' || isReducedMotion()) return;
  // Two frames: the optimistic update has rendered by then.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const { values, duration } = springFrames(1.06, 1, {
        stiffness: 420,
        damping: 16,
        precision: 0.002,
      });
      document.querySelectorAll(`[data-occ="${CSS.escape(key)}"]`).forEach((el) => {
        if (!canAnimate(el)) return;
        el.animate(
          values.map((v) => ({ transform: `scale(${v})` })),
          { duration, easing: 'linear' },
        );
      });
    }),
  );
}

/**
 * True for a moment after the shown period (`key`) got its data: the occurrences rise in one
 * after another then (CSS `cal-enter`), not on later updates such as a move.
 */
export function useEnterWindow(key: string, ready: boolean, ms = 700): boolean {
  const [seen, setSeen] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  if (ready && seen !== key) setSeen(key);
  useEffect(() => {
    if (seen === null) return;
    const id = window.setTimeout(() => setDone(seen), ms);
    return () => window.clearTimeout(id);
  }, [seen, ms]);
  return seen === key && done !== key;
}

/**
 * Edge auto-scroll while an event is dragged: held near the left or right edge for
 * `SWIPE.edgeDwellMs`, the view moves a period that way (and again while it stays there).
 */
export function useEdgeStep(onEdge?: (dir: -1 | 1) => void) {
  const latest = useRef(onEdge);
  useLayoutEffect(() => {
    latest.current = onEdge;
  });
  const timer = useRef<number | null>(null);
  const dir = useRef<Step>(0);
  const stop = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    dir.current = 0;
  }, []);
  const track = useCallback(
    (d: Step) => {
      if (d === dir.current) return;
      stop();
      dir.current = d;
      if (d === 0) return;
      const tick = () => {
        latest.current?.(d);
        timer.current = window.setTimeout(tick, SWIPE.edgeDwellMs);
      };
      timer.current = window.setTimeout(tick, SWIPE.edgeDwellMs);
    },
    [stop],
  );
  useEffect(() => stop, [stop]);
  return { track, stop };
}
