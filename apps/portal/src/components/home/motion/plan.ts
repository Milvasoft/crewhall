/**
 * The page's choreography plan: how each home section enters from the one before it and how
 * long it stays pinned. Pure, so it is shared by the server render (wrapper sizes and stacking
 * come from CSS, the page reads fine before or without JS) and the scroll engine.
 *
 * Transitions (the incoming section picks its own, falling back when the previous section has
 * no pinned stage to play against):
 *
 * - arc:   the next stage rises over the pinned one with a convex top edge that flattens.
 * - iris:  the next stage is pinned on top, masked by a circle that opens from the middle.
 * - split: the next stage waits pinned underneath; the current one splits open along the 45°
 *          diagonal of the circuit traces.
 * - wipe:  the next stage is unmasked from the right edge while its content travels against it.
 * - stack: the next stage slides over; the current one sinks back like a card in a deck.
 * - flow:  plain document flow (markdown sections, or after one).
 */

export type SectionKind =
  'hero' | 'about' | 'video' | 'features' | 'technologies' | 'community' | 'projects' | 'markdown';

export type TransitionKind = 'none' | 'flow' | 'arc' | 'iris' | 'split' | 'wipe' | 'stack';

export interface SectionPlan {
  enter: TransitionKind;
  /** Viewport heights the wrapper is pulled up over the previous one (0, 1 or 2). */
  overlap: 0 | 1 | 2;
  /** Wrapper height in viewport heights, wide screens / small screens. 0 = natural height. */
  len: number;
  lenCompact: number;
  /** Timeline position (vh) where the stage is fully on screen and settled. */
  settled: number;
  /** 1 when the next section takes over during this one's last viewport of pin. */
  handOver: 0 | 1;
  z: number;
  pinned: boolean;
}

const PREFERRED: Record<SectionKind, TransitionKind> = {
  hero: 'stack',
  about: 'arc',
  video: 'stack',
  features: 'iris',
  technologies: 'split',
  community: 'wipe',
  projects: 'stack',
  markdown: 'flow',
};

/** Scroll (vh) each pinned section holds its content animation, wide / small screens. */
const HOLD: Record<SectionKind, [number, number]> = {
  hero: [1.7, 1.2],
  about: [1.7, 1.1],
  video: [0.9, 0.6],
  features: [1.7, 1.1],
  technologies: [1.9, 1.3],
  community: [1.3, 0.9],
  projects: [1.4, 0.5],
  markdown: [0, 0],
};

export const OVERLAP: Record<TransitionKind, 0 | 1 | 2> = {
  none: 0,
  flow: 0,
  arc: 1,
  stack: 1,
  iris: 2,
  split: 2,
  wipe: 2,
};

export function planSections(kinds: SectionKind[]): SectionPlan[] {
  const out: SectionPlan[] = [];
  let z = 100;
  kinds.forEach((kind, i) => {
    const prev = out[i - 1];
    const pinned = kind !== 'markdown';
    let enter: TransitionKind = i === 0 ? 'none' : PREFERRED[kind];
    if (prev && (!prev.pinned || !pinned)) enter = 'flow';
    const overlap = OVERLAP[enter];
    z = enter === 'split' ? z - 1 : z + 1;
    out.push({
      enter,
      overlap,
      len: 0,
      lenCompact: 0,
      settled: 1 + (overlap === 2 ? 1 : 0),
      handOver: 0,
      z,
      pinned,
    });
  });
  // a section needs one more viewport of pin while the next one takes over
  out.forEach((plan, i) => {
    if (!plan.pinned) return;
    const next = out[i + 1];
    const handOver: 0 | 1 = next && next.overlap > 0 ? 1 : 0;
    const [hold, holdCompact] = HOLD[kinds[i]!];
    plan.len = round(plan.settled + hold + handOver);
    plan.lenCompact = round(plan.settled + holdCompact + handOver);
    plan.handOver = handOver;
  });
  return out;
}

const round = (n: number) => Math.round(n * 100) / 100;
