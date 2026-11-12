import { motion } from '@crewhall/ui/tokens';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { isReducedMotion } from '@/lib/motion';
import {
  springFrames,
  SWIPE,
  swipeLock,
  swipeOutcome,
  velocityOf,
  WHEEL_IDLE,
  wheelStep,
  type EnterMotion,
  type Step,
} from '@/lib/calendar/swipe';
import { playEnter, playTitle, translateX } from './motion';

interface Gesture {
  id: number;
  type: string;
  x0: number;
  y0: number;
  t0: number;
  onChip: boolean;
  lock: 'swipe' | 'other' | null;
  dx: number;
  samples: { t: number; x: number }[];
}

/** Where a mouse drag belongs to something else: chips, controls, the time grid's range select. */
const NOT_A_SWIPE = 'button, a, input, textarea, select, [data-swipe="off"]';

/**
 * The calendar body (roadmap 14, motion). Swipe it (touch, a mouse drag on an empty area, a
 * trackpad's horizontal scroll) and it follows; let go far or fast enough and it moves to the
 * previous or next period, else it springs back. A new period slides in from its side, a new
 * view zooms. Reduced motion: no following, no animation, the step happens at once.
 */
export function PeriodStage({
  enter,
  swipe,
  onStep,
  quietRef,
  children,
}: {
  enter: { motion: EnterMotion | null; n: number };
  /** Day, week and month: swiping changes the period. */
  swipe: boolean;
  onStep: (dir: -1 | 1) => void;
  /**
   * Set before a period change under a dragged event (edge auto-scroll): the period fades in
   * instead of sliding, so the days stay where the pointer expects them.
   */
  quietRef?: RefObject<boolean>;
  children: ReactNode;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const busy = useRef(false);
  const fallback = useRef<number | null>(null);
  const latest = useRef({ onStep, swipe });
  useLayoutEffect(() => {
    latest.current = { onStep, swipe };
  });

  const width = () => stage.current?.getBoundingClientRect().width ?? 0;
  const place = (x: number | null, opacity?: number) => {
    const el = track.current;
    if (!el) return;
    el.style.transform = x === null ? '' : translateX(x);
    el.style.opacity = opacity === undefined ? '' : String(opacity);
  };

  // The new period or view enters; inline styles of a swipe end here.
  useLayoutEffect(() => {
    if (enter.n === 0) return;
    if (fallback.current !== null) window.clearTimeout(fallback.current);
    fallback.current = null;
    busy.current = false;
    place(null);
    const m =
      enter.motion?.kind === 'slide' && quietRef?.current
        ? { kind: 'fade' as const }
        : enter.motion;
    if (quietRef) quietRef.current = false;
    if (m) playEnter(track.current, m, width());
  }, [enter.n]); // eslint-disable-line react-hooks/exhaustive-deps

  /** A released swipe: spring back, or leave that way and step. */
  const settle = (dx: number, step: Step, velocity: number) => {
    const el = track.current;
    const animated = el && typeof el.animate === 'function' && !isReducedMotion();
    if (!animated) {
      place(null);
      if (step) latest.current.onStep(step);
      return;
    }
    if (step === 0) {
      const { values, duration } = springFrames(dx, 0, { velocity, stiffness: 320, damping: 28 });
      place(null);
      el.animate(
        values.map((x) => ({ transform: translateX(x) })),
        { duration, easing: 'linear' },
      );
      return;
    }
    busy.current = true;
    const out = -step * width() * 0.5;
    const duration = motion.fast + 20;
    el.animate(
      [
        { transform: translateX(dx), opacity: 1 },
        { transform: translateX(out), opacity: 0 },
      ],
      { duration, easing: motion.easeIn },
    );
    place(out, 0);
    // A timer rather than `finished`: a hidden page never finishes an animation.
    fallback.current = window.setTimeout(() => {
      latest.current.onStep(step);
      // The period normally enters (and clears this) on the next render.
      fallback.current = window.setTimeout(() => {
        busy.current = false;
        place(null);
      }, 600);
    }, duration);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!latest.current.swipe || busy.current || e.button !== 0 || !e.isPrimary) return;
    const target = e.target instanceof Element ? e.target : null;
    if (!target || target.closest('[role="dialog"]')) return;
    const onChip = Boolean(target.closest('[data-occ]'));
    // Touch swipes anywhere (a long press on an event drags it instead); the mouse only on empty space.
    if (e.pointerType === 'mouse' && (onChip || target.closest(NOT_A_SWIPE))) return;
    if (e.pointerType !== 'mouse' && target.closest('button, a, input, textarea, select')) return;
    gesture.current = {
      id: e.pointerId,
      type: e.pointerType,
      x0: e.clientX,
      y0: e.clientY,
      t0: e.timeStamp,
      onChip,
      lock: null,
      dx: 0,
      samples: [{ t: e.timeStamp, x: 0 }],
    };
    const end = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
    };
    const move = (ev: PointerEvent) => {
      const g = gesture.current;
      if (!g || ev.pointerId !== g.id) return;
      const dx = ev.clientX - g.x0;
      const dy = ev.clientY - g.y0;
      if (g.lock === null) {
        g.lock = swipeLock(dx, dy);
        // Held still on an event first: that is dnd-kit's long press, not a swipe.
        if (g.lock === 'swipe' && g.onChip && ev.timeStamp - g.t0 > 300) g.lock = 'other';
        if (g.lock === 'other') {
          gesture.current = null;
          end();
          return;
        }
        if (g.lock === 'swipe') {
          try {
            stage.current?.setPointerCapture(ev.pointerId);
          } catch {
            // jsdom and lost pointers.
          }
        }
      }
      if (g.lock !== 'swipe') return;
      g.dx = dx;
      g.samples = [...g.samples.slice(-8), { t: ev.timeStamp, x: dx }];
      if (!isReducedMotion()) place(dx);
    };
    const up = (ev: PointerEvent) => {
      const g = gesture.current;
      if (!g || ev.pointerId !== g.id) return;
      gesture.current = null;
      end();
      if (g.lock !== 'swipe') return;
      if (g.type === 'mouse') swallowClick();
      settle(g.dx, swipeOutcome(g.dx, velocityOf(g.samples), width()), velocityOf(g.samples));
    };
    const cancel = (ev: PointerEvent) => {
      const g = gesture.current;
      if (!g || ev.pointerId !== g.id) return;
      gesture.current = null;
      end();
      if (g.lock === 'swipe') settle(g.dx, 0, 0);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
  };

  // A trackpad's two-finger horizontal scroll: follow, step past the threshold, swallow momentum.
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    let state = WHEEL_IDLE;
    let idle: number | null = null;
    const onWheel = (e: WheelEvent) => {
      if (!latest.current.swipe || busy.current) return;
      const unit = e.deltaMode === 1 ? 16 : 1;
      const delta = { deltaX: e.deltaX * unit, deltaY: e.deltaY * unit };
      if (Math.abs(delta.deltaX) <= Math.abs(delta.deltaY)) return;
      // Horizontal: ours (and not the browser's back gesture).
      e.preventDefault();
      const before = state.dx - delta.deltaX;
      const r = wheelStep(state, delta, width());
      state = r.state;
      if (idle !== null) window.clearTimeout(idle);
      idle = window.setTimeout(() => {
        if (!state.locked && state.dx) settle(state.dx, 0, 0);
        state = WHEEL_IDLE;
        idle = null;
      }, SWIPE.wheelIdleMs);
      if (r.step) settle(before, r.step, 0);
      else if (!state.locked && !isReducedMotion()) place(state.dx);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('wheel', onWheel);
      if (idle !== null) window.clearTimeout(idle);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(
    () => () => {
      if (fallback.current !== null) window.clearTimeout(fallback.current);
    },
    [],
  );

  return (
    <div
      ref={stage}
      data-testid="calendar-stage"
      className="relative flex min-h-0 flex-1 touch-pan-y flex-col overflow-hidden"
      onPointerDown={onPointerDown}
    >
      <div ref={track} className="flex min-h-0 flex-1 flex-col will-change-transform">
        {children}
      </div>
    </div>
  );
}

/** The click that ends a mouse swipe must not open or create anything. */
function swallowClick() {
  const stop = (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
  };
  window.addEventListener('click', stop, { capture: true, once: true });
  window.setTimeout(() => window.removeEventListener('click', stop, { capture: true }), 0);
}

/** The header date: slides in from the period's side and fades (zooms with the view: fades). */
export function PeriodTitle({
  enter,
  children,
}: {
  enter: { motion: EnterMotion | null; n: number };
  children: ReactNode;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    if (enter.n > 0 && enter.motion) playTitle(ref.current, enter.motion);
  }, [enter.n]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <span ref={ref} className="inline-block">
      {children}
    </span>
  );
}
