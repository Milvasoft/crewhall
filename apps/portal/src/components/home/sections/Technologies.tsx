'use client';

import { useRef } from 'react';
import type { FrameHandle } from '@/components/home/Frame';
import shared from '@/components/home/Home.module.css';
import type { HomeSectionData } from '@/components/home/Home';
import { useScene } from '@/components/home/motion/engine';
import { scatter } from '@/components/home/motion/math';
import { techPose } from '@/components/home/motion/poses';
import { Styler } from '@/components/home/motion/styler';
import { Img } from '@/components/home/sections/Media';
import styles from '@/components/home/sections/Technologies.module.css';
import { InkWords, RevealWords } from '@/components/home/Text';

/**
 * Scene 4. Revealed through the diagonal crack of the features stage. The technology logos fly
 * in from an exploded constellation (some from far away, some from right in front of the
 * camera) and lock into their grid, bob while the section holds, and burst away upwards when
 * the next section arrives. The drone icon turns slowly behind it all.
 */
export function Technologies({
  s,
  frame,
  headingId,
}: {
  s: Extract<HomeSectionData, { type: 'technologies' }>;
  frame: FrameHandle;
  headingId: string;
}) {
  const eye = useRef<HTMLDivElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const text = useRef<HTMLParagraphElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const tiles = useRef<(HTMLDivElement | null)[]>([]);

  useScene(() => {
    const el = frame.wrapper.current;
    if (!el) return null;
    const st = new Styler();
    const scatters = scatter(s.logos.length, 11);
    let box = { w: 400, h: 300 };
    return {
      el,
      measure() {
        if (grid.current) box = { w: grid.current.offsetWidth, h: grid.current.offsetHeight };
      },
      render(t, len, ctx) {
        const anchors = { settled: frame.plan.settled, exit: len - frame.plan.handOver };
        const pose = techPose(t, anchors, scatters, box, ctx.now);
        st.variable(title.current, '--reveal', pose.reveal);
        st.variable(text.current, '--ink', pose.ink);
        st.transform(eye.current, pose.eye);
        st.opacity(eye.current, pose.eyeOpacity);
        pose.logos.forEach((logo, i) => {
          st.transform(tiles.current[i], logo.transform);
          st.opacity(tiles.current[i], logo.opacity);
        });
        // keep the logos bobbing while they are home and the section is on screen
        return t > anchors.settled - 0.5 && t < len + 0.5;
      },
      reset: () => st.reset(),
    };
  });

  return (
    <div className={styles.tech} data-fit="">
      {s.icon && (
        <div ref={eye} className={styles.eye} aria-hidden="true">
          <Img image={s.icon} alt="" className={styles.eyeImg} />
        </div>
      )}
      <div className={styles.copy}>
        <span className={shared.eyebrowLine} aria-hidden="true" />
        <h2 ref={title} id={headingId} className={`${shared.sectionTitle} ${styles.title}`}>
          <RevealWords text={s.title} />
        </h2>
        <p ref={text} className={`${shared.sectionText} ${styles.text}`}>
          <InkWords text={s.description} />
        </p>
      </div>
      {s.logos.length > 0 && (
        <div ref={grid} className={styles.grid} aria-hidden="true">
          {s.logos.map((logo, i) => (
            <div
              key={i}
              ref={(node) => {
                tiles.current[i] = node;
              }}
              className={styles.tile}
            >
              <img src={logo} alt="" loading="lazy" decoding="async" />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
