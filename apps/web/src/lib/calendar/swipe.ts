import { type CalendarView } from '@crewhall/shared';

/**
 * Calendar motion (roadmap 14): swiping to the previous or next period, the spring that settles
 * it, edge auto-scroll while dragging an event and how a new period enters. Pure functions; the
 * views own the pointers and the Web Animations calls.
 */

export const SWIPE = {
  /** Movement before a gesture is read as a swipe or something else. */
  lockPx: 10,
  /** Let go past this share of the width and the period changes. */
  commitRatio: 0.25,
  /** …or flick: at least this fast (px/ms) and this far. */
  flickVelocity: 0.45,
  flickMinPx: 24,
  /** Trackpad: a pause this long ends the gesture. */
  wheelIdleMs: 160,
  /** Dragging an event this close to the left or right edge… */
  edgePx: 32,
  /** …for this long moves to the previous or next period. */
  edgeDwellMs: 600,
} as const;

export type Step = -1 | 0 | 1;

/** Once a pointer moved far enough: mostly horizontal is a swipe, anything else is not. */
export function swipeLock(dx: number, dy: number): 'swipe' | 'other' | null {
  if (Math.hypot(dx, dy) < SWIPE.lockPx) return null;
  return Math.abs(dx) > Math.abs(dy) * 1.2 ? 'swipe' : 'other';
}

/**
 * Where a released swipe goes. `dx` is how far the content follows the finger (negative: pulled
 * left, so the next period), `velocity` in px/ms with the same sign. 0 springs back.
 */
export function swipeOutcome(dx: number, velocity: number, width: number): Step {
  if (width <= 0 || dx === 0) return 0;
  const far = Math.abs(dx) >= width * SWIPE.commitRatio;
  const flick =
    Math.abs(velocity) >= SWIPE.flickVelocity &&
    Math.abs(dx) >= SWIPE.flickMinPx &&
    Math.sign(velocity) === Math.sign(dx);
  if (!far && !flick) return 0;
  return dx < 0 ? 1 : -1;
}

/** Velocity (px/ms) over the samples of the last 100 ms. */
export function velocityOf(samples: readonly { t: number; x: number }[]): number {
  const last = samples[samples.length - 1];
  if (!last) return 0;
  const first = samples.find((s) => last.t - s.t <= 100) ?? last;
  const dt = last.t - first.t;
  return dt > 0 ? (last.x - first.x) / dt : 0;
}

export interface SpringOptions {
  /** Start velocity in units per ms. */
  velocity?: number;
  stiffness?: number;
  damping?: number;
  mass?: number;
  /** Settled once within this distance of the target (px for slides, less for scale). */
  precision?: number;
}

/**
 * A damped spring from `from` to `to`, sampled at 60 fps: the values become Web Animations
 * keyframes played linearly over `duration` ms. The last value is exactly `to`.
 */
export function springFrames(
  from: number,
  to: number,
  { velocity = 0, stiffness = 260, damping = 26, mass = 1, precision = 0.5 }: SpringOptions = {},
): { values: number[]; duration: number } {
  const dt = 1 / 60;
  let x = from - to;
  let v = velocity * 1000;
  const values = [from];
  // Two seconds at most, whatever the options.
  for (let i = 0; i < 120; i++) {
    const a = (-stiffness * x - damping * v) / mass;
    v += a * dt;
    x += v * dt;
    if (Math.abs(x) < precision && Math.abs(v) < precision * 10) break;
    values.push(to + x);
  }
  values.push(to);
  return { values, duration: Math.round(((values.length - 1) * 1000) / 60) };
}

/** -1 near the left edge of `rect`, 1 near the right one, else 0. */
export function edgeDirection(x: number, rect: { left: number; width: number }): Step {
  if (rect.width <= SWIPE.edgePx * 4) return 0;
  if (x <= rect.left + SWIPE.edgePx) return -1;
  if (x >= rect.left + rect.width - SWIPE.edgePx) return 1;
  return 0;
}

/** A trackpad's horizontal scroll read as a swipe; `locked` swallows the momentum after a step. */
export interface WheelSwipe {
  dx: number;
  locked: boolean;
}

export const WHEEL_IDLE: WheelSwipe = { dx: 0, locked: false };

export function wheelStep(
  state: WheelSwipe,
  e: { deltaX: number; deltaY: number },
  width: number,
): { state: WheelSwipe; step: Step } {
  if (state.locked || Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return { state, step: 0 };
  const dx = state.dx - e.deltaX;
  if (width > 0 && Math.abs(dx) >= width * SWIPE.commitRatio) {
    return { state: { dx: 0, locked: true }, step: dx < 0 ? 1 : -1 };
  }
  return { state: { dx, locked: false }, step: 0 };
}

/** Finer views zoom in: month → week → day. */
const DEPTH: Record<CalendarView, number> = { month: 0, week: 1, day: 2, agenda: 1 };

export type EnterMotion =
  { kind: 'slide'; dir: -1 | 1 } | { kind: 'zoom'; dir: -1 | 1 } | { kind: 'fade' };

/** How the view enters after a change: a later period slides in from the right, and so on. */
export function enterMotion(
  prev: { view: CalendarView; first: string },
  next: { view: CalendarView; first: string },
): EnterMotion | null {
  if (prev.view !== next.view) {
    if (prev.view === 'agenda' || next.view === 'agenda') return { kind: 'fade' };
    return { kind: 'zoom', dir: DEPTH[next.view] > DEPTH[prev.view] ? 1 : -1 };
  }
  if (prev.first === next.first) return null;
  return { kind: 'slide', dir: next.first > prev.first ? 1 : -1 };
}
