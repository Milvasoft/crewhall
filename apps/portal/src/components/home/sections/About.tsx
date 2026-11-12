'use client';

import { useRef } from 'react';
import type { FrameHandle } from '@/components/home/Frame';
import shared from '@/components/home/Home.module.css';
import type { HomeSectionData } from '@/components/home/Home';
import { useScene } from '@/components/home/motion/engine';
import { aboutPose } from '@/components/home/motion/poses';
import { Styler } from '@/components/home/motion/styler';
import styles from '@/components/home/sections/About.module.css';
import { Trace } from '@/components/home/sections/Trace';
import { YouTube } from '@/components/home/sections/Media';
import { InkWords, RevealWords } from '@/components/home/Text';

/**
 * Scene 2. Rises over the orange field with an arc. The title climbs out of its masks, the
 * text inks in as you read down, and the video swings up from a tilted, distant card into
 * place while a circuit trace draws itself towards it.
 */
export function About({
  s,
  frame,
  headingId,
}: {
  s: Extract<HomeSectionData, { type: 'about' }>;
  frame: FrameHandle;
  headingId: string;
}) {
  const title = useRef<HTMLHeadingElement>(null);
  const text = useRef<HTMLParagraphElement>(null);
  const video = useRef<HTMLDivElement>(null);
  const trace = useRef<HTMLDivElement>(null);

  useScene(() => {
    const el = frame.wrapper.current;
    if (!el) return null;
    const st = new Styler();
    return {
      el,
      render(t, len, ctx) {
        const pose = aboutPose(
          t,
          { settled: frame.plan.settled, exit: len - frame.plan.handOver },
          ctx.vh,
        );
        st.variable(title.current, '--reveal', pose.reveal);
        st.variable(text.current, '--ink', pose.ink);
        st.variable(trace.current, '--trace', pose.trace);
        st.transform(video.current, pose.video);
        st.set(video.current, '--radius', `${pose.videoRadius.toFixed(1)}px`);
        st.variable(video.current, '--glow', pose.glow);
      },
      reset: () => st.reset(),
    };
  });

  return (
    <div className={styles.about} data-video={s.video ? '' : undefined} data-fit="">
      <div ref={trace} className={styles.trace} aria-hidden="true">
        <Trace d="M0 88 H22 L34 76 H58 L70 64 H100" />
      </div>
      <div className={styles.copy}>
        <span className={shared.eyebrowLine} aria-hidden="true" />
        <h2 ref={title} id={headingId} className={shared.sectionTitle}>
          <RevealWords text={s.title} />
        </h2>
        <p ref={text} className={`${shared.sectionText} ${styles.text}`}>
          <InkWords text={s.description} />
        </p>
      </div>
      {s.video && (
        <div className={styles.media}>
          <div ref={video} className={styles.videoCam}>
            <div className={styles.videoFrame}>
              <YouTube video={s.video} className={styles.iframe} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** A video section on its own (when there is no "about" section to sit next to). */
export function VideoOnly({
  video,
  frame,
}: {
  video: { id: string; title: string };
  frame: FrameHandle;
}) {
  const cam = useRef<HTMLDivElement>(null);
  useScene(() => {
    const el = frame.wrapper.current;
    if (!el) return null;
    const st = new Styler();
    return {
      el,
      render(t, len, ctx) {
        const pose = aboutPose(
          t,
          { settled: frame.plan.settled, exit: len - frame.plan.handOver },
          ctx.vh,
        );
        st.transform(cam.current, pose.video);
        st.set(cam.current, '--radius', `${pose.videoRadius.toFixed(1)}px`);
        st.variable(cam.current, '--glow', pose.glow);
      },
      reset: () => st.reset(),
    };
  });
  return (
    <div className={`${styles.about} ${styles.solo}`} data-fit="">
      <div className={styles.media}>
        <div ref={cam} className={styles.videoCam}>
          <div className={styles.videoFrame}>
            <YouTube video={video} className={styles.iframe} />
          </div>
        </div>
      </div>
    </div>
  );
}
