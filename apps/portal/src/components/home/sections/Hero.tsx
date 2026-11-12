'use client';

import { useRef, type CSSProperties } from 'react';
import type { FrameHandle } from '@/components/home/Frame';
import type { HomeLabels, HomeSectionData } from '@/components/home/Home';
import { requestFrame, useScene } from '@/components/home/motion/engine';
import { heroPose, type HeroLayout } from '@/components/home/motion/poses';
import { damp } from '@/components/home/motion/math';
import { Styler } from '@/components/home/motion/styler';
import { cssUrl, Img, layoutBox } from '@/components/home/sections/Media';
import styles from '@/components/home/sections/Hero.module.css';
import { splitLines } from '@/components/home/Text';

/**
 * Scene 1. The brand lockup (orange card with its circular bite, the mark nested in it, the
 * circuit behind, the vertical wordmark) builds itself on load. Scrolling then pushes the camera
 * into the card until the screen is orange, the mark spins past, and it lands again in the
 * middle of the orange field just before the next section rises over it.
 */
export function Hero({
  s,
  frame,
  headingId,
  labels,
}: {
  s: Extract<HomeSectionData, { type: 'hero' }>;
  frame: FrameHandle;
  headingId: string;
  labels: HomeLabels;
}) {
  const root = useRef<HTMLDivElement>(null);
  const circuitCam = useRef<HTMLDivElement>(null);
  const circuitTilt = useRef<HTMLDivElement>(null);
  const wordmark = useRef<HTMLDivElement>(null);
  const camera = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const markTilt = useRef<HTMLDivElement>(null);
  const echo = useRef<HTMLDivElement>(null);
  const badge = useRef<HTMLDivElement>(null);
  const desc = useRef<HTMLDivElement>(null);
  const cue = useRef<HTMLDivElement>(null);
  const lineRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const lines = splitLines(s.title);

  useScene(() => {
    const el = frame.wrapper.current;
    const hero = root.current;
    if (!el || !hero) return null;
    const st = new Styler();
    let layout: HeroLayout | null = null;
    // pointer parallax (fine pointers only), smoothed in the frame loop
    const pointer = { x: 0, y: 0, tx: 0, ty: 0 };
    const fine = matchMedia('(pointer: fine)');
    const onMove = (e: PointerEvent) => {
      if (!fine.matches || e.pointerType !== 'mouse') return;
      pointer.tx = (e.clientX / window.innerWidth) * 2 - 1;
      pointer.ty = (e.clientY / window.innerHeight) * 2 - 1;
      requestFrame();
    };
    window.addEventListener('pointermove', onMove, { passive: true });

    return {
      el,
      measure(ctx) {
        if (!card.current) return;
        const box = layoutBox(card.current, hero);
        layout = { card: box, vw: ctx.vw, vh: ctx.vh, compact: ctx.compact };
      },
      render(t, len, ctx) {
        if (!layout) return;
        const exit = len - frame.plan.handOver;
        const pose = heroPose(t - 1, exit - 1, layout);
        pointer.x = damp(pointer.x, pointer.tx, 5, ctx.dt || 16, 0.001);
        pointer.y = damp(pointer.y, pointer.ty, 5, ctx.dt || 16, 0.001);
        const px = pointer.x * pose.parallax;
        const py = pointer.y * pose.parallax;

        st.transform(camera.current, pose.camera);
        st.transform(markTilt.current, { x: px * 18, y: py * 14, rotate: pose.markRotate });
        st.transform(circuitCam.current, pose.circuit);
        st.opacity(circuitCam.current, pose.circuitOpacity);
        st.transform(circuitTilt.current, { x: px * -28, y: py * -20 });
        st.transform(wordmark.current, { y: pose.wordmarkY });
        st.opacity(wordmark.current, pose.wordmarkOpacity);
        st.variable(wordmark.current, '--sweep', pose.sweep);
        lineRefs.current.forEach((line, i) =>
          st.variable(line, '--out', pose.lines[Math.min(i, pose.lines.length - 1)]!),
        );
        st.transform(badge.current, { y: pose.badgeY });
        st.opacity(badge.current, pose.badgeOpacity);
        st.transform(desc.current, { y: pose.descY });
        st.opacity(desc.current, pose.descOpacity);
        st.opacity(cue.current, pose.cue);
        st.transform(echo.current, pose.echo);
        st.opacity(echo.current, pose.echoOpacity);
        return pointer.x !== pointer.tx || pointer.y !== pointer.ty;
      },
      reset: () => st.reset(),
      dispose: () => window.removeEventListener('pointermove', onMove),
    };
  });

  const markStyle = s.wordmarkVertical
    ? ({ '--wordmark': cssUrl(s.wordmarkVertical) } as CSSProperties)
    : undefined;

  return (
    <div ref={root} className={styles.hero} data-lines={lines.length}>
      {s.tech && (
        <div ref={circuitCam} className={styles.circuitCam} aria-hidden="true">
          <div ref={circuitTilt} className={styles.circuitTilt}>
            <img src={s.tech} alt="" className={styles.circuit} decoding="async" />
            <div
              className={styles.current}
              style={{ '--circuit': cssUrl(s.tech) } as CSSProperties}
            >
              <span className={styles.pulse} />
              <span className={`${styles.pulse} ${styles.pulseLate}`} />
            </div>
          </div>
        </div>
      )}
      {s.wordmarkVertical && (
        <div ref={wordmark} className={styles.wordmarkCam} aria-hidden="true">
          <div className={styles.wordmark} style={markStyle} />
        </div>
      )}

      <div ref={camera} className={styles.camera}>
        <div className={styles.lockup} data-mark={s.mark ? '' : undefined}>
          <div ref={card} className={styles.card} data-shape={s.card ? '' : undefined}>
            {s.card && <img src={s.card} alt="" className={styles.cardShape} decoding="async" />}
            <div className={styles.copy}>
              <h1 id={headingId} className={styles.title}>
                {lines.map((line, i) => (
                  <span key={i}>
                    {i > 0 && ' '}
                    <span className={styles.lineMask}>
                      <span
                        ref={(node) => {
                          lineRefs.current[i] = node;
                        }}
                        className={styles.lineOut}
                      >
                        <span className={styles.lineIn} style={{ '--i': i } as CSSProperties}>
                          {line}
                        </span>
                      </span>
                    </span>
                  </span>
                ))}
              </h1>
              {s.badge && (
                <div ref={badge} className={styles.badgeOut}>
                  <span className={styles.badge}>{s.badge}</span>
                </div>
              )}
              {s.description && (
                <div ref={desc}>
                  <p className={styles.description}>{splitLines(s.description).join(' ')}</p>
                </div>
              )}
            </div>
          </div>
          {s.mark && (
            <div className={styles.markSlot} aria-hidden="true">
              <div ref={markTilt} className={styles.markTilt}>
                <Img image={s.mark} alt="" className={styles.mark} eager />
              </div>
            </div>
          )}
        </div>
        {s.wordmark && (
          <img src={s.wordmark} alt="" className={styles.wordmarkH} aria-hidden="true" />
        )}
      </div>

      {s.mark && (
        <div ref={echo} className={styles.echo} aria-hidden="true">
          <Img image={s.mark} alt="" className={styles.echoImg} />
        </div>
      )}

      <div ref={cue} className={styles.cueOut} aria-hidden="true">
        <div className={styles.cue}>
          <span className={styles.cueLabel}>{labels.scroll}</span>
          <span className={styles.cueTrack}>
            <span className={styles.cueDot} />
          </span>
        </div>
      </div>
    </div>
  );
}
