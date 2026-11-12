'use client';

import { useRef } from 'react';
import type { FrameHandle } from '@/components/home/Frame';
import shared from '@/components/home/Home.module.css';
import type { HomeSectionData } from '@/components/home/Home';
import { useScene } from '@/components/home/motion/engine';
import { communityPose } from '@/components/home/motion/poses';
import { Styler } from '@/components/home/motion/styler';
import { Img } from '@/components/home/sections/Media';
import styles from '@/components/home/sections/Community.module.css';
import { InkWords, RevealWords } from '@/components/home/Text';

/**
 * Scene 5. Wiped in from the right edge while its content travels the same way, slower (the
 * camera pans across). The illustration settles from a close-up, then the text writes itself
 * onto the orange band.
 */
export function Community({
  s,
  frame,
  headingId,
}: {
  s: Extract<HomeSectionData, { type: 'community' }>;
  frame: FrameHandle;
  headingId: string;
}) {
  const art = useRef<HTMLDivElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const text = useRef<HTMLParagraphElement>(null);

  useScene(() => {
    const el = frame.wrapper.current;
    if (!el) return null;
    const st = new Styler();
    return {
      el,
      render(t, len, ctx) {
        const pose = communityPose(
          t,
          { settled: frame.plan.settled, exit: len - frame.plan.handOver },
          ctx.vh,
        );
        st.transform(art.current, pose.art);
        st.variable(title.current, '--reveal', pose.reveal);
        st.variable(text.current, '--ink', pose.ink);
      },
      reset: () => st.reset(),
    };
  });

  return (
    <div className={styles.community} data-art={s.image ? '' : undefined} data-fit="">
      <div className={styles.scene}>
        {s.image && (
          <div ref={art} className={styles.art}>
            <Img image={s.image} alt="" className={styles.artImg} />
          </div>
        )}
        <div className={styles.copy}>
          <h2 ref={title} id={headingId} className={`${shared.sectionTitle} ${styles.title}`}>
            <RevealWords text={s.title} />
          </h2>
          <p ref={text} className={`${shared.sectionText} ${styles.text}`}>
            <InkWords text={s.description} />
          </p>
        </div>
      </div>
    </div>
  );
}
