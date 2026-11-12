'use client';

import { useRef } from 'react';
import type { FrameHandle } from '@/components/home/Frame';
import shared from '@/components/home/Home.module.css';
import type { HomeSectionData } from '@/components/home/Home';
import { useScene } from '@/components/home/motion/engine';
import { featuresPose } from '@/components/home/motion/poses';
import { Styler } from '@/components/home/motion/styler';
import styles from '@/components/home/sections/Features.module.css';
import { Img, layoutBox } from '@/components/home/sections/Media';
import { RevealWords } from '@/components/home/Text';

/**
 * Scene 3. Opens as an iris onto a full-bleed orange plate, which then gathers itself into the
 * features card. The illustration springs up into it and the list deals itself in, one item
 * after another, each dot lighting as its line lands.
 */
export function Features({
  s,
  frame,
  headingId,
}: {
  s: Extract<HomeSectionData, { type: 'features' }>;
  frame: FrameHandle;
  headingId: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const plate = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const art = useRef<HTMLDivElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const items = useRef<(HTMLLIElement | null)[]>([]);
  const dots = useRef<(HTMLSpanElement | null)[]>([]);

  useScene(() => {
    const el = frame.wrapper.current;
    const box = root.current;
    if (!el || !box) return null;
    const st = new Styler();
    let inset = { top: 0, right: 0, bottom: 0, left: 0 };
    return {
      el,
      measure() {
        if (!card.current) return;
        const r = layoutBox(card.current, box);
        inset = {
          top: r.y,
          left: r.x,
          right: box.offsetWidth - r.x - r.w,
          bottom: box.offsetHeight - r.y - r.h,
        };
      },
      render(t, len, ctx) {
        const pose = featuresPose(
          t,
          { settled: frame.plan.settled, exit: len - frame.plan.handOver },
          s.items.length,
          ctx.vw,
        );
        const k = pose.plate;
        const px = (n: number) => `${(n * k).toFixed(1)}px`;
        st.set(
          plate.current,
          'clip-path',
          k <= 0
            ? 'none'
            : `inset(${px(inset.top)} ${px(inset.right)} ${px(inset.bottom)} ${px(inset.left)} round ${px(28)})`,
        );
        st.transform(art.current, pose.art);
        st.opacity(art.current, pose.artOpacity);
        st.variable(title.current, '--reveal', pose.reveal);
        pose.items.forEach((item, i) => {
          st.transform(items.current[i], { x: item.x });
          st.opacity(items.current[i], item.opacity);
          st.transform(dots.current[i], { scale: item.dot });
        });
      },
      reset: () => st.reset(),
    };
  });

  return (
    <div ref={root} className={styles.features} data-fit="">
      <div ref={plate} className={styles.plate} aria-hidden="true" />
      <div ref={card} className={styles.card}>
        {s.image && (
          <div ref={art} className={styles.art}>
            <Img image={s.image} alt="" className={styles.artImg} />
          </div>
        )}
        <div className={styles.body}>
          <h2 ref={title} id={headingId} className={`${shared.sectionTitle} ${styles.title}`}>
            <RevealWords text={s.title} />
          </h2>
          <ul className={styles.list}>
            {s.items.map((item, i) => (
              <li
                key={i}
                ref={(node) => {
                  items.current[i] = node;
                }}
              >
                <span
                  ref={(node) => {
                    dots.current[i] = node;
                  }}
                  className={styles.dot}
                  aria-hidden="true"
                >
                  {s.dot && <img src={s.dot} alt="" />}
                </span>
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
