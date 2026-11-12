import {
  arcClip,
  coverRadius,
  ease,
  lerp,
  seg,
  diagonalClearance,
  diagonalHalf,
  transitionProgress,
} from '@/components/home/motion/math';
import type { TransitionKind } from '@/components/home/motion/plan';
import type { Styler } from '@/components/home/motion/styler';

/** The layers of a section frame (see Frame.tsx). */
export interface FrameLayers {
  wrapper: HTMLElement;
  stage: HTMLElement;
  enter: HTMLElement;
  exit: HTMLElement;
  shade: HTMLElement;
  fx: HTMLElement | null;
}

/** A frozen copy of an outgoing exit layer: the second door of a split. */
export interface Twin {
  exit: HTMLElement;
  shade: HTMLElement | null;
}

export interface TransitionPose {
  /** Incoming stage. */
  stageClip: string;
  /** Incoming content layer. */
  enterX: number;
  enterScale: number;
  /** Outgoing content layer. */
  exitX: number;
  exitY: number;
  exitScale: number;
  exitRotate: number;
  exitClip: string;
  exitRadius: number;
  shade: number;
  /** Second door of a split (the frozen copy of the outgoing layer). */
  twin: { clip: string; x: number; y: number; rotate: number } | null;
  /** Effect layer of the incoming stage (seam light, wipe edge). */
  fxOpacity: number;
  fxValue: number;
}

const REST: TransitionPose = {
  stageClip: 'none',
  enterX: 0,
  enterScale: 1,
  exitX: 0,
  exitY: 0,
  exitScale: 1,
  exitRotate: 0,
  exitClip: 'none',
  exitRadius: 0,
  shade: 0,
  twin: null,
  fxOpacity: 0,
  fxValue: 0,
};

const round = (n: number) => Math.round(n * 100) / 100;

/**
 * Pose of both sides of a section boundary at transition progress `p` (0..1) for a vw × vh
 * stage. Pure: the motion of every transition is defined here.
 */
export function transitionPose(
  kind: TransitionKind,
  p: number,
  vw: number,
  vh: number,
): TransitionPose {
  if (kind === 'none' || kind === 'flow') return REST;
  const pose: TransitionPose = { ...REST };
  switch (kind) {
    case 'arc': {
      // a hill rising out of the bottom edge and flattening as it reaches the top
      const k = seg(p, 0, 1, ease.outCubic);
      pose.stageClip = p >= 1 ? 'none' : arcClip(vw, vh, (1 - k) * Math.min(vh * 0.28, vw * 0.2));
      pose.exitScale = lerp(1, 0.9, seg(p, 0, 1, ease.inOutCubic));
      pose.exitY = -0.08 * vh * seg(p, 0, 1, ease.outQuad);
      pose.shade = 0.6 * seg(p, 0, 1, ease.inQuad);
      break;
    }
    case 'stack': {
      const k = seg(p, 0, 1, ease.outCubic);
      const r = round((1 - k) * 56);
      pose.stageClip = r > 0.5 ? `inset(0 round ${r}px ${r}px 0 0)` : 'none';
      const back = seg(p, 0, 1, ease.inOutCubic);
      pose.exitScale = lerp(1, 0.86, back);
      pose.exitY = -0.04 * vh * back;
      pose.exitRotate = 0;
      pose.exitRadius = round(back * 36);
      pose.shade = 0.7 * seg(p, 0.1, 1, ease.inQuad);
      break;
    }
    case 'iris': {
      // the circle starts a little below the middle, where the eye already is after scrolling
      const k = seg(p, 0, 1, ease.inOutQuart);
      const r = round(k * coverRadius(vw / 2, vh * 0.55, vw, vh) * 1.02);
      pose.stageClip = p >= 1 ? 'none' : `circle(${r}px at 50% 55%)`;
      const back = seg(p, 0, 1, ease.inOutCubic);
      pose.exitScale = lerp(1, 0.82, back);
      pose.exitRotate = -3 * back;
      pose.shade = 0.75 * back;
      break;
    }
    case 'split': {
      // Two doors: the outgoing stage cracks along the diagonal (a thin seam of light), then its
      // halves slide apart, perpendicular to the cut, and leave the screen. The section waiting
      // underneath settles out of a slight close-up.
      const crack = seg(p, 0, 0.12, ease.outCubic);
      const slide = seg(p, 0.12, 0.95, ease.inOutCubic);
      const d = crack * 10 + slide * diagonalClearance(vw, vh);
      const along = round(d / Math.SQRT2);
      if (p > 0) {
        const gone = 'polygon(0 0, 0 0, 0 0)';
        pose.exitClip = p >= 1 ? gone : diagonalHalf(vw, vh, 'below');
        pose.exitX = -along;
        pose.exitY = -along;
        pose.exitRotate = -4 * slide;
        pose.twin = {
          clip: p >= 1 ? gone : diagonalHalf(vw, vh, 'above'),
          x: along,
          y: along,
          rotate: 4 * slide,
        };
      }
      pose.shade = 0.5 * slide;
      pose.enterScale = lerp(1.16, 1, seg(p, 0.1, 1, ease.outCubic));
      pose.fxOpacity = seg(p, 0, 0.06) * (1 - seg(p, 0.3, 0.65));
      pose.fxValue = round(2 * d * 0.5 + 2);
      break;
    }
    case 'wipe': {
      // the edge sweeps right to left; the content travels the same way, slower
      const k = seg(p, 0, 1, ease.inOutCubic);
      const left = round((1 - k) * 100);
      pose.stageClip = p >= 1 ? 'none' : `inset(0 0 0 ${left}%)`;
      pose.enterX = (1 - k) * vw * 0.38;
      pose.exitX = -k * vw * 0.22;
      pose.shade = 0.65 * k;
      pose.fxOpacity = p > 0 && p < 1 ? 1 : 0;
      pose.fxValue = left;
      break;
    }
  }
  return pose;
}

/**
 * Applies a transition between `prev` (outgoing) and `next` (incoming) frames from the
 * incoming wrapper's timeline `t`.
 */
export function applyTransition(
  s: Styler,
  kind: TransitionKind,
  overlap: number,
  t: number,
  prev: FrameLayers,
  next: FrameLayers,
  vw: number,
  vh: number,
  twin: Twin | null = null,
): void {
  const p = transitionProgress(t, overlap);
  const pose = transitionPose(kind, p, vw, vh);
  s.set(next.stage, 'clip-path', pose.stageClip);
  s.transform(next.enter, { x: pose.enterX, scale: pose.enterScale });
  s.transform(prev.exit, {
    x: pose.exitX,
    y: pose.exitY,
    scale: pose.exitScale,
    rotate: pose.exitRotate,
  });
  s.set(
    prev.exit,
    'clip-path',
    pose.exitClip !== 'none'
      ? pose.exitClip
      : pose.exitRadius > 0
        ? `inset(0 round ${pose.exitRadius}px)`
        : 'none',
  );
  s.opacity(prev.shade, pose.shade);
  if (twin && pose.twin) {
    s.transform(twin.exit, { x: pose.twin.x, y: pose.twin.y, rotate: pose.twin.rotate });
    s.set(twin.exit, 'clip-path', pose.twin.clip);
    s.opacity(twin.shade, pose.shade);
  }
  if (next.fx) {
    s.opacity(next.fx, pose.fxOpacity);
    s.set(next.fx, '--fx', String(pose.fxValue));
  }
}
