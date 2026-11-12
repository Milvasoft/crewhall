/**
 * Pure motion math for the home page: timelines, easing, smoothing and the geometry of the
 * section transitions. No DOM access here, so all of it is unit-tested.
 *
 * Units: scene timelines are measured in viewport heights ("vh") of scroll. A section's
 * timeline `t` is 0 when its wrapper's top edge meets the bottom of the viewport and 1 when that
 * edge reaches the top of the viewport (where a sticky stage starts to pin).
 */

export const clamp = (n: number, lo = 0, hi = 1) => (n < lo ? lo : n > hi ? hi : n);

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Where `n` sits between `a` and `b`, unclamped (0 at a, 1 at b). */
export const invLerp = (a: number, b: number, n: number) =>
  a === b ? (n < a ? 0 : 1) : (n - a) / (b - a);

export type Ease = (t: number) => number;

/** Easing curves; every one maps 0 → 0 and 1 → 1. */
export const ease = {
  linear: (t: number) => t,
  inQuad: (t: number) => t * t,
  outQuad: (t: number) => 1 - (1 - t) * (1 - t),
  inCubic: (t: number) => t * t * t,
  outCubic: (t: number) => 1 - (1 - t) ** 3,
  inOutCubic: (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
  outQuart: (t: number) => 1 - (1 - t) ** 4,
  inOutQuart: (t: number) => (t < 0.5 ? 8 * t ** 4 : 1 - (-2 * t + 2) ** 4 / 2),
  outExpo: (t: number) => (t >= 1 ? 1 : 1 - 2 ** (-10 * t)),
  inExpo: (t: number) => (t <= 0 ? 0 : 2 ** (10 * t - 10)),
  inOutExpo: (t: number) =>
    t <= 0 ? 0 : t >= 1 ? 1 : t < 0.5 ? 2 ** (20 * t - 10) / 2 : (2 - 2 ** (-20 * t + 10)) / 2,
  /** Overshoots a little before settling: for things that land. */
  outBack: (t: number) => {
    const c1 = 1.5;
    const c3 = c1 + 1;
    return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
  },
} satisfies Record<string, Ease>;

/** Eased progress of `t` through the segment [a, b], clamped to 0..1. */
export function seg(t: number, a: number, b: number, curve: Ease = ease.linear): number {
  return curve(clamp(invLerp(a, b, t)));
}

/**
 * Segment of item `i` of `n` inside 0..1 when items run one after another with overlap:
 * `overlap` 0 plays them strictly in turn, 1 plays them all at once.
 */
export function stagger(i: number, n: number, overlap = 0.5): [number, number] {
  if (n <= 1) return [0, 1];
  const o = clamp(overlap);
  const length = 1 / (n - (n - 1) * o);
  const start = i * length * (1 - o);
  return [start, start + length];
}

/**
 * Frame-rate independent smoothing toward `target` (exponential decay with rate `lambda` per
 * second). Snaps once close enough so loops can go idle.
 */
export function damp(
  current: number,
  target: number,
  lambda: number,
  dtMs: number,
  epsilon = 1e-4,
): number {
  const next = lerp(current, target, 1 - Math.exp((-lambda * dtMs) / 1000));
  return Math.abs(target - next) < epsilon ? target : next;
}

/** Scene timeline position (in vh) from the wrapper's document top and the scroll position. */
export function timeline(wrapperTop: number, scrollY: number, vh: number): number {
  if (vh <= 0) return 0;
  return (scrollY + vh - wrapperTop) / vh;
}

/**
 * How far a transition into a section has got, 0..1, from the incoming section's timeline.
 * Overlap 1 (the next section slides over the pinned one): runs while it rises, t 0 → 1.
 * Overlap 2 (the next section is already pinned underneath / on top, masked): t 1 → 2.
 */
export function transitionProgress(nextT: number, overlap: number): number {
  return clamp(nextT - Math.max(0, overlap - 1));
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Scale that makes `rect`, scaled about the point (fx, fy), cover the whole viewport (vw × vh).
 * Used for the hero's push into the orange card.
 */
export function coverScale(rect: Rect, fx: number, fy: number, vw: number, vh: number): number {
  const need = [
    fx > rect.x ? fx / (fx - rect.x) : Infinity, // left edge must reach 0
    rect.x + rect.w > fx ? (vw - fx) / (rect.x + rect.w - fx) : Infinity, // right edge → vw
    fy > rect.y ? fy / (fy - rect.y) : Infinity, // top edge → 0
    rect.y + rect.h > fy ? (vh - fy) / (rect.y + rect.h - fy) : Infinity, // bottom edge → vh
  ];
  return Math.max(1, ...need);
}

/** Distance from (cx, cy) to the farthest corner of a w × h box: an iris of this radius covers it. */
export function coverRadius(cx: number, cy: number, w: number, h: number): number {
  const dx = Math.max(cx, w - cx);
  const dy = Math.max(cy, h - cy);
  return Math.hypot(dx, dy);
}

const n2 = (n: number) => Math.round(n * 100) / 100;

/**
 * clip-path for a stage whose top edge is a convex arc: the corners sit `depth` px below the
 * middle. Depth 0 is a plain rectangle.
 */
export function arcClip(w: number, h: number, depth: number): string {
  const d = n2(Math.max(0, depth));
  if (d === 0) return 'none';
  return `path('M0 ${d} Q${n2(w / 2)} ${n2(-d)} ${n2(w)} ${d} L${n2(w)} ${n2(h)} L0 ${n2(h)} Z')`;
}

type Point = [number, number];

/** The part of the w × h box on one side of the line x + y = c (Sutherland–Hodgman, one edge). */
export function clipBoxByDiagonal(
  w: number,
  h: number,
  c: number,
  keep: 'below' | 'above',
): Point[] {
  const box: Point[] = [
    [0, 0],
    [w, 0],
    [w, h],
    [0, h],
  ];
  // signed side of the line: ≤ 0 is kept (points on the line belong to both halves)
  const side = (p: Point) => (keep === 'below' ? p[0] + p[1] - c : c - p[0] - p[1]);
  const out: Point[] = [];
  for (let i = 0; i < box.length; i++) {
    const a = box[i]!;
    const b = box[(i + 1) % box.length]!;
    const sa = side(a);
    const sb = side(b);
    if (sa <= 0) out.push(a);
    if ((sa < 0 && sb > 0) || (sa > 0 && sb < 0)) {
      const k = sa / (sa - sb);
      out.push([a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k]);
    }
  }
  return out;
}

/**
 * clip-path keeping one half of a w × h stage, cut along the 45° diagonal through its centre
 * (bottom-left to top-right, the direction of the circuit traces). 'below' is the top-left half.
 */
export function diagonalHalf(w: number, h: number, keep: 'below' | 'above'): string {
  const pts = clipBoxByDiagonal(w, h, (w + h) / 2, keep);
  return `polygon(${pts.map(([x, y]) => `${n2(x)}px ${n2(y)}px`).join(', ')})`;
}

/**
 * Distance (px) a diagonal half has to travel away from the cut, perpendicular to it, to leave
 * the w × h stage completely.
 */
export function diagonalClearance(w: number, h: number): number {
  return ((w + h) / (2 * Math.SQRT2)) * 1.04;
}

/** Small deterministic PRNG (mulberry32), so scattered layouts match between server and tests. */
export function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Scatter {
  /** Offset from the resting place, in fractions of the stage size. */
  x: number;
  y: number;
  /** Scale and rotation (deg) while scattered: as if far away or very close. */
  scale: number;
  rotate: number;
  /** Order in which items fly home, 0..1. */
  delay: number;
}

/** Deterministic "exploded" positions for `n` items around their grid places. */
export function scatter(n: number, seed = 7): Scatter[] {
  const rnd = random(seed);
  return Array.from({ length: n }, (_, i) => {
    const angle = (i / Math.max(1, n)) * Math.PI * 2 + rnd() * 1.2;
    const dist = 0.45 + rnd() * 0.5;
    const near = rnd() < 0.4;
    return {
      x: Math.cos(angle) * dist,
      y: Math.sin(angle) * dist * 0.8,
      scale: near ? 1.6 + rnd() * 0.9 : 0.25 + rnd() * 0.35,
      rotate: (rnd() - 0.5) * 90,
      delay: rnd(),
    };
  });
}

/**
 * Horizontal travel (px) of a track that is `trackWidth` wide inside a viewport `vw` wide, with
 * `pad` px kept free at the end.
 */
export function trackTravel(trackWidth: number, vw: number, pad = 0): number {
  return Math.max(0, trackWidth - vw + pad);
}

/** Maps scroll velocity (px/ms) to a gentle skew in degrees, capped at ±max. */
export function velocitySkew(velocity: number, max = 6): number {
  const s = Math.tanh(velocity / 2.5) * max;
  return Math.abs(s) < 0.01 ? 0 : s;
}
