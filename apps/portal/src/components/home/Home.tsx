'use client';

import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { About, VideoOnly } from '@/components/home/sections/About';
import { Community } from '@/components/home/sections/Community';
import { Features } from '@/components/home/sections/Features';
import { Hero } from '@/components/home/sections/Hero';
import { Markdown } from '@/components/home/sections/Markdown';
import { Projects } from '@/components/home/sections/Projects';
import { Technologies } from '@/components/home/sections/Technologies';
import { ChapterRail, type Chapter } from '@/components/home/ChapterRail';
import { Frame } from '@/components/home/Frame';
import styles from '@/components/home/Home.module.css';
import { planSections } from '@/components/home/motion/plan';

/**
 * The home page: the Hub's home sections played as one continuous, scroll-driven film.
 * Each section is a pinned stage (Frame) with its own scrubbed choreography, and every
 * boundary is a transition that hands one stage over to the next (see motion/plan.ts).
 */

export interface ThemedImage {
  src: string;
  dark: string | null;
}

export type HomeSectionData =
  | {
      type: 'hero';
      id: string;
      title: string;
      badge: string;
      description: string;
      card: string | null;
      tech: string | null;
      wordmarkVertical: string | null;
      wordmark: string | null;
      mark: ThemedImage | null;
    }
  | {
      type: 'about';
      id: string;
      title: string;
      description: string;
      video: { id: string; title: string } | null;
    }
  | { type: 'video'; id: string; video: { id: string; title: string } }
  | {
      type: 'features';
      id: string;
      title: string;
      items: string[];
      image: ThemedImage | null;
      dot: string | null;
    }
  | {
      type: 'technologies';
      id: string;
      title: string;
      description: string;
      icon: ThemedImage | null;
      logos: string[];
    }
  | { type: 'community'; id: string; title: string; description: string; image: ThemedImage | null }
  | {
      type: 'projects';
      id: string;
      title: string;
      description: string;
      projects: {
        name: string;
        image: string | null;
        /** The project's home (repository); http(s) only. */
        url?: string | null;
        description: string;
        badges: { url: string; image: string; alt: string }[];
      }[];
    }
  | { type: 'markdown'; id: string; title: string; content: ReactNode };

export interface HomeLabels {
  /** The hero's scroll cue. */
  scroll: string;
  /** Accessible name of the chapter rail. */
  chapters: string;
  /** Chapter name of a video section without a title. */
  video: string;
}

const chapterLabel = (s: HomeSectionData, labels: HomeLabels) => {
  const raw = s.type === 'video' ? s.video.title || labels.video : s.title;
  return raw.replace(/<br\s*\/?>/gi, ' ').trim();
};

/**
 * Height a section's content needs: its in-flow children's layout boxes plus its padding.
 * Layout boxes ignore transforms (a scene's entry pose must not count) and absolutely placed
 * decoration is left out.
 */
function contentHeight(section: HTMLElement): number {
  let top = Infinity;
  let bottom = -Infinity;
  for (const child of section.children) {
    if (!(child instanceof HTMLElement)) continue;
    const position = getComputedStyle(child).position;
    if (position === 'absolute' || position === 'fixed') continue;
    top = Math.min(top, child.offsetTop);
    bottom = Math.max(bottom, child.offsetTop + child.offsetHeight);
  }
  if (bottom < top) return 0;
  const style = getComputedStyle(section);
  return bottom - top + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
}

/**
 * Pinned stages are one viewport tall. When a section's content needs more than that on this
 * screen (a small phone, large text settings, a long translation), the whole page falls back to
 * plain document flow: better a calm page than a clipped one.
 */
function useFitCheck(root: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const probe = document.createElement('div');
    probe.setAttribute('aria-hidden', 'true');
    probe.style.cssText =
      'position:absolute;left:0;top:0;width:0;height:100vh;height:100svh;visibility:hidden;pointer-events:none';
    el.appendChild(probe);
    const compact = matchMedia('(max-width: 768px)');
    let frame = 0;
    const check = () => {
      frame = 0;
      const vh = probe.offsetHeight;
      const tooTall = [...el.querySelectorAll<HTMLElement>('[data-fit]')].some(
        (section) =>
          // a rail section turns its content sideways on wide screens: it always fits
          !(section.dataset.fit === 'rail' && !compact.matches) && contentHeight(section) > vh + 4,
      );
      el.toggleAttribute('data-static', tooTall);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(check);
    };
    check();
    // the check gives the same answer in both layouts, so re-checking after a switch settles it
    const observer = new ResizeObserver(schedule);
    observer.observe(el);
    // content growing inside a fixed-height section does not resize it: watch its children too
    el.querySelectorAll('[data-fit]').forEach((section) => {
      observer.observe(section);
      for (const child of section.children) observer.observe(child);
    });
    window.addEventListener('resize', schedule, { passive: true });
    window.addEventListener('load', schedule);
    void document.fonts?.ready.then(schedule);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', schedule);
      window.removeEventListener('load', schedule);
      probe.remove();
    };
  }, [root]);
}

export function Home({ sections, labels }: { sections: HomeSectionData[]; labels: HomeLabels }) {
  const plans = planSections(sections.map((s) => s.type));
  const root = useRef<HTMLDivElement>(null);
  useFitCheck(root);
  const chapters: Chapter[] = sections
    .map((s, i) => ({
      id: `section-${s.id}`,
      label: chapterLabel(s, labels),
      settled: plans[i]!.settled,
    }))
    .filter((c) => c.label);

  return (
    <div ref={root} className={styles.home} data-home="">
      <ChapterRail chapters={chapters} label={labels.chapters} root={root} />
      {sections.map((s, i) => {
        const plan = plans[i]!;
        const exitKind = plans[i + 1]?.enter ?? 'none';
        const headingId = `home-${s.id}`;
        const labelled = s.type !== 'video' && (s.type !== 'markdown' || !!s.title);
        const frame = (render: Parameters<typeof Frame>[0]['children']) => (
          <Frame
            key={s.id}
            plan={plan}
            exitKind={exitKind}
            id={`section-${s.id}`}
            labelledBy={labelled ? headingId : undefined}
          >
            {render}
          </Frame>
        );
        switch (s.type) {
          case 'hero':
            return frame((f) => <Hero s={s} frame={f} headingId={headingId} labels={labels} />);
          case 'about':
            return frame((f) => <About s={s} frame={f} headingId={headingId} />);
          case 'video':
            return frame((f) => <VideoOnly video={s.video} frame={f} />);
          case 'features':
            return frame((f) => <Features s={s} frame={f} headingId={headingId} />);
          case 'technologies':
            return frame((f) => <Technologies s={s} frame={f} headingId={headingId} />);
          case 'community':
            return frame((f) => <Community s={s} frame={f} headingId={headingId} />);
          case 'projects':
            return frame((f) => <Projects s={s} frame={f} headingId={headingId} />);
          case 'markdown':
            return frame((f) => <Markdown s={s} frame={f} headingId={headingId} />);
        }
      })}
    </div>
  );
}
