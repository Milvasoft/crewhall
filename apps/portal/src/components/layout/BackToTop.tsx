'use client';

import { useEffect, useState } from 'react';

/** Docusaurus "scroll back to top" button on doc pages. */
export function BackToTop({ label }: { label: string }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    let last = window.scrollY;
    const onScroll = () => {
      const y = window.scrollY;
      // Docusaurus shows it while scrolling up, away from the top
      setShow(y > 300 && y < last);
      last = y;
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  return (
    <button
      aria-label={label}
      className={`clean-btn theme-back-to-top-button backToTopButton_sjWU${show ? ' backToTopButtonShow_xfvO' : ''}`}
      type="button"
      onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
    />
  );
}
