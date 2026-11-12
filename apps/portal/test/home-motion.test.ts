import { describe, expect, it } from 'vitest';
import {
  arcClip,
  clamp,
  clipBoxByDiagonal,
  coverRadius,
  coverScale,
  damp,
  ease,
  invLerp,
  random,
  scatter,
  seg,
  diagonalClearance,
  diagonalHalf,
  stagger,
  timeline,
  trackTravel,
  transitionProgress,
  velocitySkew,
} from '@/components/home/motion/math';
import { OVERLAP, planSections, type SectionKind } from '@/components/home/motion/plan';
import {
  aboutPose,
  activeChapter,
  chapterFill,
  cardPose,
  contentProgress,
  featuresPose,
  heroCoverScale,
  heroFocus,
  heroPose,
  leaveProgress,
  projectsPose,
  projectsTimeFor,
  techPose,
  type HeroLayout,
} from '@/components/home/motion/poses';
import { toTransform } from '@/components/home/motion/styler';
import { transitionPose } from '@/components/home/motion/transitions';

describe('motion math', () => {
  it('clamps, maps and segments', () => {
    expect(clamp(-1)).toBe(0);
    expect(clamp(2)).toBe(1);
    expect(clamp(5, 0, 10)).toBe(5);
    expect(invLerp(10, 20, 15)).toBe(0.5);
    expect(invLerp(3, 3, 2)).toBe(0);
    expect(invLerp(3, 3, 4)).toBe(1);
    expect(seg(0.5, 0, 1)).toBe(0.5);
    expect(seg(-1, 0, 1)).toBe(0);
    expect(seg(3, 0, 1)).toBe(1);
    expect(seg(1.5, 1, 2, ease.inQuad)).toBe(0.25);
  });

  it('keeps every easing anchored at 0 and 1', () => {
    for (const [name, curve] of Object.entries(ease)) {
      expect(curve(0), name).toBeCloseTo(0, 6);
      expect(curve(1), name).toBeCloseTo(1, 6);
    }
    // outBack overshoots before settling
    expect(Math.max(...Array.from({ length: 50 }, (_, i) => ease.outBack(i / 49)))).toBeGreaterThan(
      1,
    );
  });

  it('staggers items in order, covering 0..1', () => {
    const n = 4;
    const segs = Array.from({ length: n }, (_, i) => stagger(i, n, 0.5));
    expect(segs[0]![0]).toBe(0);
    expect(segs[n - 1]![1]).toBeCloseTo(1, 10);
    for (let i = 1; i < n; i++) expect(segs[i]![0]).toBeGreaterThan(segs[i - 1]![0]);
    expect(stagger(0, 1)).toEqual([0, 1]);
    // overlap 0 plays them strictly in turn
    expect(stagger(1, 2, 0)).toEqual([0.5, 1]);
  });

  it('smooths independently of the frame rate and snaps when close', () => {
    // two 8 ms steps land where one 16 ms step does
    const a = damp(damp(0, 1, 10, 8), 1, 10, 8);
    const b = damp(0, 1, 10, 16);
    expect(a).toBeCloseTo(b, 10);
    expect(damp(0.99995, 1, 10, 16)).toBe(1);
    expect(damp(0, 1, 10, 0)).toBe(0);
  });

  it('measures timelines in viewport heights', () => {
    // wrapper top at the bottom of the viewport → 0, at the top → 1
    expect(timeline(1000, 100, 900)).toBe(0);
    expect(timeline(1000, 1000, 900)).toBe(1);
    expect(timeline(1000, 1450, 900)).toBe(1.5);
    expect(timeline(0, 0, 0)).toBe(0);
  });

  it('runs overlap-1 transitions while the section rises and overlap-2 ones once pinned', () => {
    expect(transitionProgress(0.5, 1)).toBe(0.5);
    expect(transitionProgress(0.5, 2)).toBe(0);
    expect(transitionProgress(1.5, 2)).toBe(0.5);
    expect(transitionProgress(3, 2)).toBe(1);
  });

  it('finds the scale that makes a box cover the viewport', () => {
    const rect = { x: 100, y: 100, w: 200, h: 100 };
    const s = coverScale(rect, 200, 150, 1000, 800);
    // every edge reaches the viewport edge (or beyond)
    expect(200 - (200 - 100) * s).toBeLessThanOrEqual(0.0001);
    expect(200 + (300 - 200) * s).toBeGreaterThanOrEqual(1000 - 0.0001);
    expect(150 - 50 * s).toBeLessThanOrEqual(0.0001);
    expect(150 + 50 * s).toBeGreaterThanOrEqual(800 - 0.0001);
    // a box already covering needs no scaling
    expect(coverScale({ x: -10, y: -10, w: 2000, h: 2000 }, 500, 500, 1000, 800)).toBe(1);
  });

  it('opens an iris to the farthest corner', () => {
    expect(coverRadius(0, 0, 3, 4)).toBe(5);
    expect(coverRadius(50, 50, 100, 100)).toBeCloseTo(Math.hypot(50, 50));
  });

  it('draws the arc edge and flattens it to nothing', () => {
    expect(arcClip(1000, 800, 0)).toBe('none');
    const clip = arcClip(1000, 800, 120);
    expect(clip).toBe("path('M0 120 Q500 -120 1000 120 L1000 800 L0 800 Z')");
  });

  it('cuts the box along the diagonal', () => {
    const below = clipBoxByDiagonal(100, 100, 100, 'below');
    const above = clipBoxByDiagonal(100, 100, 100, 'above');
    // the anti-diagonal halves a square into two triangles
    expect(below).toHaveLength(3);
    expect(above).toHaveLength(3);
    expect(below.every(([x, y]) => x + y <= 100 + 1e-9)).toBe(true);
    expect(above.every(([x, y]) => x + y >= 100 - 1e-9)).toBe(true);
    expect(clipBoxByDiagonal(100, 100, -1, 'below')).toHaveLength(0);
  });

  it('cuts the stage into two diagonal halves that can clear it', () => {
    expect(diagonalHalf(100, 100, 'below')).toBe('polygon(0px 0px, 100px 0px, 0px 100px)');
    expect(diagonalHalf(1440, 900, 'above').startsWith('polygon(')).toBe(true);
    // the point of the top-left half farthest from both screen edges is (c/2, c/2)
    const c = (1440 + 900) / 2;
    expect(diagonalClearance(1440, 900) / Math.SQRT2).toBeGreaterThan(c / 2);
  });

  it('scatters deterministically', () => {
    expect(random(3)()).toBe(random(3)());
    expect(scatter(6, 1)).toEqual(scatter(6, 1));
    expect(scatter(6, 1)).not.toEqual(scatter(6, 2));
    for (const s of scatter(12)) {
      expect(s.delay).toBeGreaterThanOrEqual(0);
      expect(s.delay).toBeLessThan(1);
      expect(Math.hypot(s.x, s.y)).toBeGreaterThan(0.2);
    }
  });

  it('computes the horizontal track and the velocity lean', () => {
    expect(trackTravel(3000, 1440, 80)).toBe(1640);
    expect(trackTravel(800, 1440)).toBe(0);
    expect(velocitySkew(0)).toBe(0);
    expect(velocitySkew(100, 6)).toBeCloseTo(6, 3);
    expect(velocitySkew(-100, 6)).toBeCloseTo(-6, 3);
  });
});

describe('choreography plan', () => {
  const kinds: SectionKind[] = [
    'hero',
    'about',
    'features',
    'technologies',
    'community',
    'projects',
  ];

  it('gives every boundary its own transition', () => {
    const plan = planSections(kinds);
    expect(plan.map((p) => p.enter)).toEqual(['none', 'arc', 'iris', 'split', 'wipe', 'stack']);
    expect(plan.map((p) => p.overlap)).toEqual([0, 1, 2, 2, 2, 1]);
  });

  it('stacks incoming stages above, except a split, which waits underneath', () => {
    const plan = planSections(kinds);
    for (let i = 1; i < plan.length; i++) {
      if (plan[i]!.enter === 'split') expect(plan[i]!.z).toBeLessThan(plan[i - 1]!.z);
      else expect(plan[i]!.z).toBeGreaterThan(plan[i - 1]!.z);
    }
  });

  it('pins each section long enough for its entry, its content and the hand-over', () => {
    const plan = planSections(kinds);
    plan.forEach((p, i) => {
      const next = plan[i + 1];
      expect(p.handOver).toBe(next && next.overlap > 0 ? 1 : 0);
      expect(p.settled).toBe(p.overlap === 2 ? 2 : 1);
      expect(p.len).toBeGreaterThan(p.settled + p.handOver);
      expect(p.lenCompact).toBeGreaterThan(p.settled + p.handOver);
      expect(p.lenCompact).toBeLessThanOrEqual(p.len);
    });
    // the last section has no hand-over: the footer follows in plain flow
    expect(plan.at(-1)!.handOver).toBe(0);
  });

  it('falls back to plain flow around unpinned markdown sections', () => {
    const plan = planSections(['hero', 'markdown', 'features', 'about']);
    expect(plan.map((p) => p.enter)).toEqual(['none', 'flow', 'flow', 'arc']);
    expect(plan[1]!.pinned).toBe(false);
    expect(plan[1]!.len).toBe(0);
    // the hero is not taken over by a markdown section
    expect(plan[0]!.handOver).toBe(0);
  });

  it('uses an overlap matching every transition kind', () => {
    expect(OVERLAP.arc).toBe(1);
    expect(OVERLAP.stack).toBe(1);
    expect(OVERLAP.iris).toBe(2);
    expect(OVERLAP.split).toBe(2);
    expect(OVERLAP.wipe).toBe(2);
    expect(OVERLAP.flow).toBe(0);
  });

  it('handles an empty page and a single section', () => {
    expect(planSections([])).toEqual([]);
    const [only] = planSections(['projects']);
    expect(only!.enter).toBe('none');
    expect(only!.handOver).toBe(0);
  });
});

describe('transforms', () => {
  it('writes compact transforms and drops the identity', () => {
    expect(toTransform({})).toBe('none');
    expect(toTransform({ x: 0.001, scale: 1.0001 })).toBe('none');
    expect(toTransform({ x: 10, y: -5.5 })).toBe('translate3d(10.00px, -5.50px, 0)');
    expect(toTransform({ x: 1, scale: 2, rotate: 45 })).toBe(
      'translate3d(1.00px, 0.00px, 0) rotate(45.00deg) scale(2.0000)',
    );
    // anything moving is put on its own layer
    expect(toTransform({ scaleX: 0.5 })).toBe(
      'translate3d(0.00px, 0.00px, 0) scale(0.5000, 1.0000)',
    );
    expect(toTransform({ rotate: -3 })).toBe('translate3d(0.00px, 0.00px, 0) rotate(-3.00deg)');
    expect(toTransform({ y: -0.001 })).toBe('none');
  });
});

describe('transitions', () => {
  const vw = 1440;
  const vh = 900;

  it('rests at both ends', () => {
    for (const kind of ['arc', 'stack', 'iris', 'wipe'] as const) {
      const done = transitionPose(kind, 1, vw, vh);
      expect(done.stageClip, kind).toBe('none');
      expect(done.enterX, kind).toBe(0);
      expect(done.enterScale, kind).toBe(1);
    }
    for (const kind of ['arc', 'stack', 'iris', 'split', 'wipe'] as const) {
      const start = transitionPose(kind, 0, vw, vh);
      expect(start.exitScale, kind).toBe(1);
      expect(start.shade, kind).toBe(0);
      expect(start.exitClip, kind).toBe('none');
    }
    expect(transitionPose('flow', 0.5, vw, vh).stageClip).toBe('none');
  });

  it('hides the incoming stage before a masked transition starts', () => {
    expect(transitionPose('iris', 0, vw, vh).stageClip).toBe('circle(0px at 50% 55%)');
    expect(transitionPose('wipe', 0, vw, vh).stageClip).toBe('inset(0 0 0 100%)');
  });

  it('opens a split like two doors sliding apart along the diagonal', () => {
    expect(transitionPose('split', 0, vw, vh).twin).toBeNull();
    const mid = transitionPose('split', 0.5, vw, vh);
    expect(mid.exitClip).toBe(diagonalHalf(vw, vh, 'below'));
    expect(mid.twin!.clip).toBe(diagonalHalf(vw, vh, 'above'));
    // the halves move in opposite directions, perpendicular to the cut
    expect(mid.exitX).toBeLessThan(0);
    expect(mid.exitX).toBe(mid.exitY);
    expect(mid.twin!.x).toBe(-mid.exitX);
    // by the end they have left the screen and the next section has settled
    const end = transitionPose('split', 1, vw, vh);
    expect(Math.hypot(end.twin!.x, end.twin!.y)).toBeGreaterThanOrEqual(
      diagonalClearance(vw, vh) - 0.01,
    );
    expect(end.exitClip).toBe('polygon(0 0, 0 0, 0 0)');
    expect(end.enterScale).toBe(1);
    // a seam of light shows in the crack and is gone before the doors are
    expect(transitionPose('split', 0.15, vw, vh).fxOpacity).toBeGreaterThan(0.9);
    expect(transitionPose('split', 0.8, vw, vh).fxOpacity).toBe(0);
  });

  it('sinks the outgoing stage as the next one takes over', () => {
    const stack = transitionPose('stack', 1, vw, vh);
    expect(stack.exitScale).toBeLessThan(1);
    expect(stack.exitRadius).toBeGreaterThan(0);
    expect(stack.shade).toBeGreaterThan(0.5);
    const wipe = transitionPose('wipe', 0.5, vw, vh);
    expect(wipe.exitX).toBeLessThan(0);
    expect(wipe.enterX).toBeGreaterThan(0);
  });
});

describe('scene poses', () => {
  const layout: HeroLayout = {
    card: { x: 72, y: 200, w: 634, h: 562 },
    vw: 1440,
    vh: 900,
    compact: false,
  };

  it('starts the hero at rest with the copy in place', () => {
    const pose = heroPose(0, 1.7, layout);
    expect(toTransform(pose.camera)).toBe('none');
    expect(pose.lines.every((l) => l === 0)).toBe(true);
    expect(pose.badgeOpacity).toBe(1);
    expect(pose.cue).toBe(1);
    expect(pose.echoOpacity).toBe(0);
    expect(pose.parallax).toBe(1);
  });

  it('pushes the hero camera into the card until it covers the screen', () => {
    const P = 1.7;
    const pose = heroPose(P, P, layout);
    const scale = heroCoverScale(layout);
    expect(pose.camera.scale).toBeCloseTo(scale, 6);
    // the focus point has moved to the middle of the screen
    const f = heroFocus(layout.card);
    expect((pose.camera.x ?? 0) + scale * f.x).toBeCloseTo(layout.vw / 2, 6);
    expect((pose.camera.y ?? 0) + scale * f.y).toBeCloseTo(layout.vh / 2, 6);
    // the card then covers the viewport
    const left = (pose.camera.x ?? 0) + scale * layout.card.x;
    const right = (pose.camera.x ?? 0) + scale * (layout.card.x + layout.card.w);
    expect(left).toBeLessThanOrEqual(0);
    expect(right).toBeGreaterThanOrEqual(layout.vw);
    expect(pose.lines.every((l) => l === 1)).toBe(true);
    expect(pose.echoOpacity).toBe(1);
    expect(pose.circuitOpacity).toBe(0);
  });

  it('only moves forward as the hero scrolls', () => {
    let last = 1;
    for (let s = 0; s <= 1.7; s += 0.05) {
      const scale = heroPose(s, 1.7, layout).camera.scale ?? 1;
      expect(scale).toBeGreaterThanOrEqual(last - 1e-9);
      last = scale;
    }
  });

  it('settles content before the hand-over and leaves after it', () => {
    const a = { settled: 1, exit: 2.7 };
    expect(contentProgress(0, a)).toBe(0);
    expect(contentProgress(2.6, a)).toBe(1);
    expect(leaveProgress(2.7, a)).toBe(0);
    expect(leaveProgress(3.2, a)).toBe(0.5);
    const about = aboutPose(2.5, a, 900);
    expect(about.reveal).toBe(1);
    expect(about.ink).toBe(1);
    expect(toTransform(about.video)).toBe('none');
  });

  it('gathers the features plate and deals the list in order', () => {
    const a = { settled: 2, exit: 3.7 };
    expect(featuresPose(1.5, a, 3, 1440).plate).toBe(0);
    const done = featuresPose(3.6, a, 3, 1440);
    expect(done.plate).toBe(1);
    expect(done.items.every((i) => i.opacity === 1 && i.x === 0)).toBe(true);
    const mid = featuresPose(2.6, a, 3, 1440);
    expect(mid.items[0]!.opacity).toBeGreaterThanOrEqual(mid.items[2]!.opacity);
  });

  it('brings every logo home, then bursts them away', () => {
    const a = { settled: 2, exit: 3.9 };
    const scatters = scatter(12, 11);
    const box = { w: 500, h: 380 };
    const away = techPose(1, a, scatters, box, 0);
    expect(away.logos.every((l) => l.opacity === 0)).toBe(true);
    const home = techPose(3.5, a, scatters, box, 0);
    for (const logo of home.logos) {
      expect(logo.opacity).toBe(1);
      expect(Math.abs(logo.transform.x ?? 0)).toBeLessThan(0.5);
      expect(logo.transform.scale).toBeCloseTo(1, 6);
    }
    const gone = techPose(a.exit + 1, a, scatters, box, 0);
    expect(gone.logos.every((l) => l.opacity === 0)).toBe(true);
  });

  it('runs the project track from start to end while pinned', () => {
    const a = { settled: 1, exit: 4 };
    expect(projectsPose(1, a, 1200).x).toBe(-0);
    expect(projectsPose(3.95, a, 1200).x).toBe(-1200);
    expect(projectsPose(3.95, a, 1200).progress).toBe(1);
    // the progress bar is gone by the time the section lets go (the footer has its own line)
    expect(projectsPose(2.5, a, 1200).bar).toBe(1);
    expect(projectsPose(4, a, 1200).bar).toBe(0);
    expect(projectsPose(0.5, a, 1200).bar).toBe(0);
  });

  it('finds where to scroll for a given point of the track', () => {
    const a = { settled: 1, exit: 4 };
    for (const p of [0, 0.1, 0.37, 0.5, 0.9, 1]) {
      expect(projectsPose(projectsTimeFor(p, a), a, 1000).progress).toBeCloseTo(p, 5);
    }
    expect(projectsTimeFor(-1, a)).toBeCloseTo(projectsTimeFor(0, a), 9);
  });

  it('lights the chapter on screen and fills the rail between the first and the last', () => {
    const anchors = [0, 1000, 2500, 4000];
    expect(activeChapter(anchors, 0, 900)).toBe(0);
    expect(activeChapter(anchors, 600, 900)).toBe(1);
    expect(activeChapter(anchors, 2100, 900)).toBe(2);
    expect(activeChapter(anchors, 9000, 900)).toBe(3);
    expect(chapterFill(anchors, 2000)).toBe(0.5);
    expect(chapterFill(anchors, -50)).toBe(0);
    expect(chapterFill([10], 50)).toBe(0);
  });

  it('raises cards into line as they come in from the right', () => {
    expect(toTransform(cardPose(100, 1440, 0))).toBe('none');
    const entering = cardPose(1400, 1440, 0);
    expect(entering.y).toBeGreaterThan(0);
    expect(entering.rotate).toBeGreaterThan(0);
    expect(cardPose(100, 1440, 3).skewX).toBe(3);
  });
});
