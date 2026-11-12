'use client';

import { useRef, type MouseEvent, type RefObject } from 'react';
import styles from '@/components/home/Home.module.css';
import { useScene } from '@/components/home/motion/engine';
import { activeChapter, chapterFill } from '@/components/home/motion/poses';
import { Styler } from '@/components/home/motion/styler';

export interface Chapter {
  /** The section wrapper's id. */
  id: string;
  label: string;
  /** Timeline position (vh) where the section is settled on screen. */
  settled: number;
}

/**
 * A slim chapter rail on wide screens: one stop per section, the current one lit in the brand
 * colour, a trace filling between them. Each stop is a link that scrolls to the moment its
 * section has settled (not to the top of its wrapper, which overlaps the previous one).
 */
export function ChapterRail({
  chapters,
  label,
  root,
}: {
  chapters: Chapter[];
  label: string;
  root: RefObject<HTMLDivElement | null>;
}) {
  const nav = useRef<HTMLElement>(null);
  const fill = useRef<HTMLSpanElement>(null);
  const stops = useRef<(HTMLAnchorElement | null)[]>([]);
  const anchors = useRef<number[]>([]);

  const measureAnchors = (vh: number) => {
    anchors.current = chapters.map((c) => {
      const el = document.getElementById(c.id);
      if (!el) return 0;
      const top = el.getBoundingClientRect().top + window.scrollY;
      const pinned = getComputedStyle(el).getPropertyValue('--motion').trim() === '1';
      return pinned ? top + (c.settled - 1) * vh : top - vh * 0.1;
    });
  };

  useScene(() => {
    const el = root.current;
    const rail = nav.current;
    if (!el || !rail) return null;
    const st = new Styler();
    let vh = 0;
    let current = -1;
    return {
      el,
      measure(ctx) {
        vh = ctx.vh;
        measureAnchors(vh);
      },
      render(_t, _len, ctx) {
        const y = window.scrollY;
        const active = activeChapter(anchors.current, y, ctx.vh);
        st.transform(fill.current, { scaleY: Math.max(0.0001, chapterFill(anchors.current, y)) });
        if (active !== current) {
          stops.current[current]?.removeAttribute('aria-current');
          stops.current[active]?.setAttribute('aria-current', 'step');
          current = active;
        }
        st.set(rail, '--visible', y > vh * 0.15 ? '1' : '0');
      },
      reset() {
        stops.current[current]?.removeAttribute('aria-current');
        current = -1;
        st.reset();
      },
    };
  });

  const go = (e: MouseEvent<HTMLAnchorElement>, i: number) => {
    const target = anchors.current[i];
    if (target === undefined) return;
    e.preventDefault();
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.scrollTo({ top: Math.max(0, target), behavior: reduced ? 'auto' : 'smooth' });
    history.replaceState(null, '', `#${chapters[i]!.id}`);
  };

  if (chapters.length < 2) return null;
  return (
    <nav ref={nav} className={styles.rail} aria-label={label}>
      <span className={styles.railTrack} aria-hidden="true">
        <span ref={fill} className={styles.railFill} />
      </span>
      <ol>
        {chapters.map((c, i) => (
          <li key={c.id}>
            <a
              ref={(node) => {
                stops.current[i] = node;
              }}
              href={`#${c.id}`}
              onClick={(e) => go(e, i)}
            >
              <span className={styles.railLabel}>{c.label}</span>
              <span className={styles.railDot} aria-hidden="true" />
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}
