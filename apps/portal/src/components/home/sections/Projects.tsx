'use client';

import { useRef } from 'react';
import type { FrameHandle } from '@/components/home/Frame';
import shared from '@/components/home/Home.module.css';
import type { HomeSectionData } from '@/components/home/Home';
import { useScene } from '@/components/home/motion/engine';
import { clamp, trackTravel, velocitySkew } from '@/components/home/motion/math';
import { cardPose, projectsPose, projectsTimeFor } from '@/components/home/motion/poses';
import { Styler } from '@/components/home/motion/styler';
import styles from '@/components/home/sections/Projects.module.css';
import { InkWords, RevealWords } from '@/components/home/Text';

/**
 * Scene 6. Slides over the technologies like the next card of a deck, then turns the scroll
 * sideways: the project cards run past on a horizontal track (wide screens), rising into line
 * from the right and leaning with the scroll speed. Small screens swipe the track natively.
 */
export function Projects({
  s,
  frame,
  headingId,
}: {
  s: Extract<HomeSectionData, { type: 'projects' }>;
  frame: FrameHandle;
  headingId: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const text = useRef<HTMLParagraphElement>(null);
  const bar = useRef<HTMLSpanElement>(null);
  const cards = useRef<(HTMLElement | null)[]>([]);

  useScene(() => {
    const el = frame.wrapper.current;
    const box = root.current;
    if (!el || !box) return null;
    const st = new Styler();
    let travel = 0;
    let rail = false;
    let lefts: number[] = [];
    let view = { vw: 0, vh: 0, len: 0 };

    // Keyboard focus on a card that is off screen on the rail: scroll to where the rail shows it.
    const onFocus = (e: FocusEvent) => {
      box.scrollLeft = 0; // focus may scroll the clipped box itself; the rail does the moving
      if (!rail || !travel || !view.vh) return;
      const card = (e.target as HTMLElement).closest('article');
      const i = card ? cards.current.indexOf(card) : -1;
      if (i < 0) return;
      const left = lefts[i] ?? 0;
      const shown = left + -travel * clamp((left - view.vw * 0.3) / travel);
      if (shown >= 0 && shown + (card?.offsetWidth ?? 0) <= view.vw) return;
      const anchors = { settled: frame.plan.settled, exit: view.len - frame.plan.handOver };
      const t = projectsTimeFor((left - view.vw * 0.3) / travel, anchors);
      const top = el.getBoundingClientRect().top + window.scrollY;
      window.scrollTo({ top: top + (t - 1) * view.vh, behavior: 'instant' });
    };
    box.addEventListener('focusin', onFocus);

    return {
      el,
      measure(ctx, live) {
        rail = live && !ctx.compact;
        box.toggleAttribute('data-rail', rail);
        if (!rail || !track.current) {
          travel = 0;
          if (live) st.set(el, '--len', String(frame.plan.len));
          return;
        }
        travel = trackTravel(track.current.scrollWidth, ctx.vw, ctx.vw * 0.06);
        lefts = cards.current.map((c) => (c ? c.offsetLeft + track.current!.offsetLeft : 0));
        const len =
          frame.plan.settled +
          0.25 +
          Math.max(0.8, (travel / Math.max(1, ctx.vh)) * 1.1) +
          0.4 +
          frame.plan.handOver;
        st.set(el, '--len', len.toFixed(3));
      },
      render(t, len, ctx) {
        view = { vw: ctx.vw, vh: ctx.vh, len };
        const anchors = { settled: frame.plan.settled, exit: len - frame.plan.handOver };
        const pose = projectsPose(t, anchors, travel);
        st.variable(title.current, '--reveal', pose.reveal);
        st.variable(text.current, '--ink', pose.ink);
        if (!rail) {
          st.transform(track.current, {});
          cards.current.forEach((c) => st.transform(c, {}));
          return;
        }
        st.transform(track.current, { x: pose.x });
        st.transform(bar.current, { scaleX: Math.max(0.0001, pose.progress) });
        st.opacity(bar.current?.parentElement, pose.bar);
        const skew = velocitySkew(-ctx.velocity, 5);
        cards.current.forEach((c, i) =>
          st.transform(c, cardPose((lefts[i] ?? 0) + pose.x, ctx.vw, skew)),
        );
        return skew !== 0;
      },
      reset() {
        box.removeAttribute('data-rail');
        st.reset();
      },
      dispose: () => box.removeEventListener('focusin', onFocus),
    };
  });

  return (
    <div ref={root} className={styles.projects} data-fit="rail">
      <div ref={track} className={styles.track}>
        <div className={styles.intro}>
          <span className={shared.eyebrowLine} aria-hidden="true" />
          <h2 ref={title} id={headingId} className={`${shared.sectionTitle} ${styles.title}`}>
            <RevealWords text={s.title} />
          </h2>
          <p ref={text} className={`${shared.sectionText} ${styles.text}`}>
            <InkWords text={s.description} />
          </p>
        </div>
        <div className={styles.cards}>
          {s.projects.map((project, i) => (
            <article
              key={i}
              ref={(node) => {
                cards.current[i] = node;
              }}
              className={styles.card}
            >
              <div className={styles.cardInner}>
                {project.image && (
                  <img
                    src={project.image}
                    alt=""
                    className={styles.cardImage}
                    loading="lazy"
                    decoding="async"
                  />
                )}
                <h3 className={styles.cardTitle}>
                  {project.url ? (
                    <a href={project.url} target="_blank" rel="noopener noreferrer">
                      {project.name}
                    </a>
                  ) : (
                    project.name
                  )}
                </h3>
                <p className={styles.cardText}>{project.description}</p>
                <div className={styles.badges}>
                  {project.badges.map((badge, j) =>
                    badge.url ? (
                      <a key={j} href={badge.url} target="_blank" rel="noopener noreferrer">
                        <img src={badge.image} alt={badge.alt} loading="lazy" />
                      </a>
                    ) : (
                      <img key={j} src={badge.image} alt={badge.alt} loading="lazy" />
                    ),
                  )}
                </div>
              </div>
            </article>
          ))}
        </div>
      </div>
      <div className={styles.progress} aria-hidden="true">
        <span ref={bar} />
      </div>
    </div>
  );
}
