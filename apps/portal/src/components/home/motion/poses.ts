import {
  clamp,
  coverScale,
  ease,
  lerp,
  seg,
  stagger,
  type Rect,
  type Scatter,
} from '@/components/home/motion/math';
import type { Transform } from '@/components/home/motion/styler';

/**
 * Scene choreographies as pure functions of the scroll timeline. Components only measure and
 * apply; every curve, offset and timing lives here and is unit-tested.
 */

// ---------------------------------------------------------------------------------------------
// Hero

export interface HeroLayout {
  /** The card's layout box inside the stage. */
  card: Rect;
  vw: number;
  vh: number;
  compact: boolean;
}

export interface HeroPose {
  camera: Transform;
  markRotate: number;
  circuit: Transform;
  circuitOpacity: number;
  wordmarkY: number;
  wordmarkOpacity: number;
  sweep: number;
  /** Per title line: 0 in place, 1 gone up out of its mask. */
  lines: number[];
  badgeY: number;
  badgeOpacity: number;
  descY: number;
  descOpacity: number;
  cue: number;
  echo: Transform;
  echoOpacity: number;
  /** How much the pointer parallax applies (fades out once scrolling starts). */
  parallax: number;
}

/** Where the camera pushes in: inside the card, clear of the bite on its right edge. */
export function heroFocus(card: Rect): { x: number; y: number } {
  return { x: card.x + card.w * 0.4, y: card.y + card.h * 0.5 };
}

/** Final camera scale: the card, its focus moved to the centre, covers the whole viewport. */
export function heroCoverScale(layout: HeroLayout): number {
  const f = heroFocus(layout.card);
  const cx = layout.vw / 2;
  const cy = layout.vh / 2;
  const moved = { ...layout.card, x: layout.card.x + cx - f.x, y: layout.card.y + cy - f.y };
  return coverScale(moved, cx, cy, layout.vw, layout.vh) * 1.08;
}

/**
 * `s`: scroll (vh) since the hero pinned. `handOver`: s at which the next section starts to
 * rise over it. The push into the card finishes a little before that.
 */
export function heroPose(s: number, handOver: number, layout: HeroLayout): HeroPose {
  const P = Math.max(0.6, handOver);
  const { vw, vh } = layout;
  const f = heroFocus(layout.card);
  const cover = heroCoverScale(layout);

  const zt = seg(s, 0.08 * P, 0.7 * P, ease.inOutCubic);
  const zs = seg(s, 0.1 * P, 0.86 * P, ease.inOutQuart);
  const scale = Math.exp(zs * Math.log(cover));
  const fx = f.x + (vw / 2 - f.x) * zt;
  const fy = f.y + (vh / 2 - f.y) * zt;

  const lines = [0, 1, 2, 3, 4].map((i) => seg(s, 0.02 + i * 0.05, 0.3 + i * 0.05, ease.inCubic));
  const badge = seg(s, 0.05, 0.28, ease.inQuad);
  const desc = seg(s, 0.03, 0.3, ease.inQuad);

  const land = seg(s, 0.8 * P, 1.02 * P, ease.outBack);
  const landTurn = seg(s, 0.8 * P, 1.02 * P, ease.outCubic);
  const lift = seg(s, handOver, handOver + 1, ease.inCubic);

  return {
    camera: { x: fx - scale * f.x, y: fy - scale * f.y, scale },
    markRotate: 160 * zs,
    circuit: { y: -s * 0.12 * vh, scale: Math.exp(zs * Math.log(cover) * 0.16) },
    circuitOpacity: 1 - seg(s, 0.2 * P, 0.7 * P),
    wordmarkY: -s * 0.55 * vh,
    wordmarkOpacity: 1 - seg(s, 0.12 * P, 0.6 * P),
    sweep: s,
    lines,
    badgeY: -28 * badge,
    badgeOpacity: 1 - badge,
    descY: -36 * desc,
    descOpacity: 1 - desc,
    cue: 1 - seg(s, 0, 0.08),
    echo: {
      y: -lift * 0.14 * vh,
      scale: lerp(0.2, 1, land) * lerp(1, 0.85, lift),
      rotate: lerp(-140, 0, landTurn),
    },
    echoOpacity: seg(s, 0.8 * P, 0.9 * P),
    parallax: 1 - seg(s, 0, 0.3),
  };
}

// ---------------------------------------------------------------------------------------------
// Content timing shared by the other scenes

/**
 * Timeline anchors of a pinned section: `settled` (vh) where its stage is fully on screen and
 * `exit` where the next section starts to take over.
 */
export interface Anchors {
  settled: number;
  exit: number;
}

/** Progress of a section's content choreography: starts while it arrives, ends before it leaves. */
export function contentProgress(t: number, a: Anchors, lead = 0.55, tail = 0.25): number {
  const start = a.settled - lead;
  const end = Math.max(start + 0.3, a.exit - tail);
  return clamp((t - start) / (end - start));
}

/** Progress of the hand-over to the next section, 0..1. */
export function leaveProgress(t: number, a: Anchors): number {
  return clamp(t - a.exit);
}

// ---------------------------------------------------------------------------------------------
// About

export interface AboutPose {
  reveal: number;
  ink: number;
  trace: number;
  video: Transform;
  videoRadius: number;
  glow: number;
}

export function aboutPose(t: number, a: Anchors, vh: number): AboutPose {
  const c = contentProgress(t, a, 0.6, 0.3);
  const leave = leaveProgress(t, a);
  const v = seg(c, 0, 0.45, ease.outQuart);
  return {
    reveal: seg(c, 0.02, 0.3, ease.outCubic),
    ink: seg(c, 0.18, 0.9),
    trace: seg(c, 0.1, 0.75, ease.inOutCubic),
    video: {
      y: lerp(0.22 * vh, 0, v) - leave * 0.12 * vh,
      scale: lerp(0.62, 1, v),
      rotate: lerp(-7, 0, v),
    },
    videoRadius: lerp(48, 18, v),
    glow: seg(c, 0.3, 0.6) * (1 - leave),
  };
}

// ---------------------------------------------------------------------------------------------
// Features

export interface FeaturesPose {
  /** Inset of the orange plate from the full stage to the card box, 0..1. */
  plate: number;
  art: Transform;
  artOpacity: number;
  reveal: number;
  items: { x: number; opacity: number; dot: number }[];
}

export function featuresPose(t: number, a: Anchors, items: number, vw: number): FeaturesPose {
  // the plate starts to gather into the card as the iris finishes opening
  const plate = seg(t, a.settled - 0.15, a.settled + 0.45, ease.inOutQuart);
  const c = contentProgress(t, a, -0.15, 0.3);
  const leave = leaveProgress(t, a);
  const art = seg(c, 0, 0.4, ease.outBack);
  return {
    plate,
    art: {
      y: lerp(160, 0, seg(c, 0, 0.4, ease.outCubic)) - leave * 60,
      rotate: lerp(-14, 0, seg(c, 0, 0.45, ease.outCubic)),
      scale: lerp(0.7, 1, art),
    },
    artOpacity: seg(c, 0, 0.15),
    reveal: seg(c, 0.08, 0.38, ease.outCubic),
    items: Array.from({ length: items }, (_, i) => {
      const [from, to] = stagger(i, items, 0.55);
      const k = seg(c, 0.2 + from * 0.6, 0.2 + to * 0.6, ease.outCubic);
      return {
        x: lerp(Math.min(120, vw * 0.08), 0, k),
        opacity: k,
        dot: seg(c, 0.2 + from * 0.6 + 0.05, 0.2 + to * 0.6 + 0.1, ease.outBack),
      };
    }),
  };
}

// ---------------------------------------------------------------------------------------------
// Technologies

export interface TechPose {
  reveal: number;
  ink: number;
  eye: Transform;
  eyeOpacity: number;
  logos: { transform: Transform; opacity: number }[];
}

/**
 * Logos fly in from an exploded constellation into their grid places as the section settles,
 * bob gently while it holds (time-based), and burst outwards as the next section arrives.
 */
export function techPose(
  t: number,
  a: Anchors,
  scatters: Scatter[],
  box: { w: number; h: number },
  timeMs: number,
): TechPose {
  const c = contentProgress(t, a, 0.5, 0.3);
  const leave = leaveProgress(t, a);
  return {
    reveal: seg(c, 0.05, 0.3, ease.outCubic),
    ink: seg(c, 0.15, 0.7),
    eye: {
      rotate: lerp(-35, 25, clamp((t - a.settled + 1) / (a.exit - a.settled + 2))),
      scale: lerp(0.8, 1.05, seg(c, 0, 1)) + leave * 0.3,
      y: -leave * 80,
    },
    eyeOpacity: seg(c, 0, 0.3),
    logos: scatters.map((sc, i) => {
      const startAt = sc.delay * 0.25;
      const k = seg(c, startAt, startAt + 0.35, ease.outQuart);
      const out = seg(leave, sc.delay * 0.4, sc.delay * 0.4 + 0.6, ease.inCubic);
      const home = 1 - k;
      const bob = Math.sin(timeMs / 900 + i * 1.7) * 6 * k * (1 - out);
      return {
        transform: {
          x: sc.x * box.w * (home + out * 1.4),
          y: sc.y * box.h * home + bob - out * box.h * (0.6 + sc.delay * 0.6),
          scale: lerp(1, sc.scale, home) * lerp(1, 0.6, out),
          rotate: sc.rotate * (home + out),
        },
        opacity: seg(k, 0, 0.5) * (1 - out),
      };
    }),
  };
}

// ---------------------------------------------------------------------------------------------
// Community

export interface CommunityPose {
  art: Transform;
  reveal: number;
  ink: number;
}

export function communityPose(t: number, a: Anchors, vh: number): CommunityPose {
  const c = contentProgress(t, a, 0.6, 0.25);
  const leave = leaveProgress(t, a);
  const k = seg(c, 0, 0.55, ease.outCubic);
  return {
    art: { scale: lerp(1.12, 1, k) * lerp(1, 0.96, leave), y: lerp(0.06 * vh, 0, k) },
    reveal: seg(c, 0.25, 0.55, ease.outCubic),
    ink: seg(c, 0.35, 0.95),
  };
}

// ---------------------------------------------------------------------------------------------
// Projects

export interface ProjectsPose {
  /** Track offset (px, ≤ 0). */
  x: number;
  progress: number;
  /** The progress bar shows while the track runs and is gone before the footer arrives. */
  bar: number;
  reveal: number;
  ink: number;
}

/** The horizontal track runs while the section holds; the title arrives first. */
const runSpan = (a: Anchors): [number, number] => [a.settled + 0.25, a.exit - 0.1];

export function projectsPose(t: number, a: Anchors, travel: number): ProjectsPose {
  const [from, to] = runSpan(a);
  const run = seg(t, from, to, ease.inOutCubic);
  const intro = seg(t, a.settled - 0.7, a.settled + 0.1, ease.linear);
  return {
    x: -travel * run,
    progress: run,
    bar: seg(t, from - 0.3, from) * (1 - seg(t, to - 0.05, a.exit)),
    reveal: seg(intro, 0, 0.6, ease.outCubic),
    ink: seg(intro, 0.2, 1),
  };
}

/**
 * Timeline position (vh) at which the track has run `progress` (0..1) of its way: where to
 * scroll so that a card reached by keyboard focus is on screen.
 */
export function projectsTimeFor(progress: number, a: Anchors): number {
  const [from, to] = runSpan(a);
  const target = clamp(progress);
  let lo = from;
  let hi = to;
  for (let i = 0; i < 32; i++) {
    const mid = (lo + hi) / 2;
    if (seg(mid, from, to, ease.inOutCubic) < target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * A card's arrival pose from its position on screen: cards enter the line from the right
 * rising and turning slightly, and lean with scroll velocity.
 */
export function cardPose(left: number, vw: number, skew: number): Transform {
  const u = clamp((left / Math.max(1, vw) - 0.55) / 0.5);
  const k = ease.inQuad(u);
  return { y: k * 140, rotate: k * 9, skewX: skew };
}

// ---------------------------------------------------------------------------------------------
// Chapter rail

/** Index of the chapter on screen: the last one whose anchor is at most half a viewport ahead. */
export function activeChapter(anchors: number[], scrollY: number, vh: number): number {
  let active = 0;
  anchors.forEach((a, i) => {
    if (a - vh * 0.5 <= scrollY) active = i;
  });
  return active;
}

/** How much of the rail between the first and the last chapter has been travelled, 0..1. */
export function chapterFill(anchors: number[], scrollY: number): number {
  if (anchors.length < 2) return 0;
  const first = anchors[0]!;
  const last = anchors[anchors.length - 1]!;
  return last > first ? clamp((scrollY - first) / (last - first)) : 0;
}
