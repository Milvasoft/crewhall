'use client';

import { useRef } from 'react';
import type { FrameHandle } from '@/components/home/Frame';
import shared from '@/components/home/Home.module.css';
import type { HomeSectionData } from '@/components/home/Home';
import { useScene } from '@/components/home/motion/engine';
import { ease, seg } from '@/components/home/motion/math';
import { Styler } from '@/components/home/motion/styler';
import { RevealWords } from '@/components/home/Text';

/** Free-form content from the Hub: plain flow, the title rises in, the body follows. */
export function Markdown({
  s,
  frame,
  headingId,
}: {
  s: Extract<HomeSectionData, { type: 'markdown' }>;
  frame: FrameHandle;
  headingId: string;
}) {
  const title = useRef<HTMLHeadingElement>(null);
  const body = useRef<HTMLDivElement>(null);
  useScene(() => {
    const el = frame.wrapper.current;
    if (!el) return null;
    const st = new Styler();
    return {
      el,
      render(t) {
        st.variable(title.current, '--reveal', seg(t, 0.1, 0.5, ease.outCubic));
        const k = seg(t, 0.2, 0.7, ease.outCubic);
        st.transform(body.current, { y: (1 - k) * 60 });
        st.opacity(body.current, k);
      },
      reset: () => st.reset(),
    };
  });
  return (
    <div
      className="container"
      style={{ padding: 'calc(var(--navbar) + 4rem) var(--ifm-spacing-horizontal) 6rem' }}
    >
      {s.title && (
        <h2 ref={title} id={headingId} className={shared.sectionTitle}>
          <RevealWords text={s.title} />
        </h2>
      )}
      <div ref={body} className="markdown margin-top--lg">
        {s.content}
      </div>
    </div>
  );
}
