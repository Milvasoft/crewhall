'use client';

import { useRef, type CSSProperties, type ReactNode, type RefObject } from 'react';
import styles from '@/components/home/Home.module.css';
import { useScene } from '@/components/home/motion/engine';
import type { SectionPlan, TransitionKind } from '@/components/home/motion/plan';
import { Styler } from '@/components/home/motion/styler';
import { transitionProgress } from '@/components/home/motion/math';
import { applyTransition, type FrameLayers, type Twin } from '@/components/home/motion/transitions';

export interface FrameHandle {
  wrapper: RefObject<HTMLElement | null>;
  plan: SectionPlan;
}

/** The layers of a rendered frame, found through their data-layer markers. */
function layersOf(el: Element | null): FrameLayers | null {
  if (!(el instanceof HTMLElement) || !el.matches('[data-frame]')) return null;
  const find = (name: string) => el.querySelector<HTMLElement>(`[data-layer="${name}"]`);
  const stage = find('stage');
  const enter = find('enter');
  const exit = find('exit');
  const shade = find('shade');
  if (!stage || !enter || !exit || !shade) return null;
  return { wrapper: el, stage, enter, exit, shade, fx: find('fx') };
}

/**
 * A frozen copy of the outgoing exit layer, taken when a split starts: the second door. It is
 * decoration only (hidden from assistive tech, inert, without ids).
 */
function makeTwin(prev: FrameLayers): Twin {
  const exit = prev.exit.cloneNode(true) as HTMLElement;
  exit.removeAttribute('data-layer');
  exit.querySelectorAll('[id]').forEach((node) => node.removeAttribute('id'));
  exit.setAttribute('aria-hidden', 'true');
  exit.inert = true;
  exit.style.position = 'absolute';
  exit.style.inset = '0';
  prev.enter.appendChild(exit);
  return { exit, shade: exit.querySelector<HTMLElement>('[data-layer="shade"]') };
}

/**
 * A home section's frame. Wrapper (scroll length, overlap, stacking) › sticky stage (clipped by
 * the incoming transition) › enter layer › exit layer (moved and clipped by the outgoing
 * transition) › content. Wrapper sizes come from CSS custom properties, so pins and overlaps
 * are in place on the first paint, and a reduced-motion media query turns them all off.
 * The frame plays the transition from the section before it.
 */
export function Frame({
  plan,
  exitKind,
  id,
  labelledBy,
  children,
}: {
  plan: SectionPlan;
  /** How the next section enters (decides how this one leaves). */
  exitKind: TransitionKind;
  id: string;
  labelledBy?: string | undefined;
  children: (frame: FrameHandle) => ReactNode;
}) {
  const wrapper = useRef<HTMLElement>(null);

  useScene(() => {
    const kind = plan.enter;
    const el = wrapper.current;
    if (kind === 'none' || kind === 'flow' || !el) return null;
    const prev = layersOf(el.previousElementSibling);
    const next = layersOf(el);
    if (!prev || !next) return null;
    const s = new Styler();
    let twin: Twin | null = null;
    const dropTwin = () => {
      if (!twin) return;
      twin.exit.remove();
      s.forget(twin.exit);
      s.forget(twin.shade);
      twin = null;
    };
    return {
      el,
      render(t, _len, ctx) {
        if (kind === 'split') {
          const p = transitionProgress(t, plan.overlap);
          if (p > 0 && p < 1) twin ??= makeTwin(prev);
          else dropTwin();
        }
        applyTransition(s, kind, plan.overlap, t, prev, next, ctx.vw, ctx.vh, twin);
      },
      reset() {
        dropTwin();
        s.reset();
      },
    };
  });

  const style = {
    '--len': plan.len,
    '--len-sm': plan.lenCompact,
    zIndex: plan.z,
  } as CSSProperties;

  return (
    <section
      ref={wrapper}
      id={id}
      aria-labelledby={labelledBy}
      className={styles.frame}
      data-frame=""
      data-enter={plan.enter}
      data-exit={exitKind}
      data-pinned={plan.pinned ? '' : undefined}
      style={style}
    >
      <div className={styles.stage} data-layer="stage">
        <div className={styles.enterLayer} data-layer="enter">
          <div className={styles.exitLayer} data-layer="exit">
            {children({ wrapper, plan })}
            <div className={styles.shade} data-layer="shade" aria-hidden="true" />
          </div>
        </div>
        {(plan.enter === 'split' || plan.enter === 'wipe') && (
          <div className={styles.fx} data-layer="fx" data-kind={plan.enter} aria-hidden="true" />
        )}
      </div>
    </section>
  );
}
