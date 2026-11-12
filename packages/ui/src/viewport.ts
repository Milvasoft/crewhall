import { useEffect, useSyncExternalStore } from 'react';

/** Narrow screens get bottom sheets instead of anchored panels. */
export const NARROW_QUERY = '(max-width: 639px)';

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window === 'undefined' || !window.matchMedia) return () => {};
      const mql = window.matchMedia(query);
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    },
    () =>
      typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : false,
    () => false,
  );
}

/** A soft keyboard is assumed open when it takes more than this many CSS pixels. */
const KEYBOARD_MIN = 120;

const EDITABLE =
  'input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]), textarea, select, [contenteditable=""], [contenteditable="true"]';

/**
 * Keeps the focused field above the soft keyboard (doc 02 · forms, "Klavye alanı örtmez").
 * Mount once at the app root. It publishes the visual viewport on <html>:
 *
 * - `--vvh`: visible height, `--vv-top`: its offset; sheets and dialogs size themselves with these.
 * - `--kb`: keyboard height (0 when closed); the app shell shrinks by it and fixed bars lift by it.
 * - `data-keyboard="open"` while a keyboard covers the page (Tailwind variant `keyboard:`).
 *
 * On touch screens a focused field is scrolled into view (`block: 'nearest'`) once the keyboard
 * has finished opening.
 */
export function useVisualViewportVars(): void {
  useEffect(() => {
    const vv = window.visualViewport;
    const root = document.documentElement;
    if (!vv) return;

    let frame = 0;
    const apply = () => {
      frame = 0;
      // Pinch zoom also shrinks the visual viewport; only a keyboard counts as an inset.
      const zoomed = vv.scale > 1.01;
      const height = zoomed ? window.innerHeight : vv.height;
      const top = zoomed ? 0 : vv.offsetTop;
      const kb = zoomed
        ? 0
        : Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
      root.style.setProperty('--vvh', `${Math.round(height)}px`);
      root.style.setProperty('--vv-top', `${Math.round(top)}px`);
      root.style.setProperty('--kb', `${kb >= KEYBOARD_MIN ? kb : 0}px`);
      if (kb >= KEYBOARD_MIN) root.dataset.keyboard = 'open';
      else delete root.dataset.keyboard;
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(apply);
    };

    const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
    let pending: HTMLElement | null = null;
    let timer = 0;
    const reveal = () => {
      window.clearTimeout(timer);
      const el = pending;
      pending = null;
      if (el && el.isConnected && document.activeElement === el) {
        el.scrollIntoView({ block: 'nearest' });
      }
    };
    const onFocusIn = (e: FocusEvent) => {
      if (!coarse) return;
      const el = e.target;
      if (!(el instanceof HTMLElement) || !el.matches(EDITABLE)) return;
      pending = el;
      // Reveal after the keyboard animation resizes the viewport; the timer covers an
      // already-open keyboard (moving between fields), where no resize follows.
      window.clearTimeout(timer);
      timer = window.setTimeout(reveal, 350);
    };
    const onResize = () => {
      schedule();
      if (pending) {
        window.clearTimeout(timer);
        timer = window.setTimeout(reveal, 60);
      }
    };

    apply();
    vv.addEventListener('resize', onResize);
    vv.addEventListener('scroll', schedule);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      vv.removeEventListener('resize', onResize);
      vv.removeEventListener('scroll', schedule);
      document.removeEventListener('focusin', onFocusIn);
      window.clearTimeout(timer);
      if (frame) cancelAnimationFrame(frame);
      for (const v of ['--vvh', '--vv-top', '--kb']) root.style.removeProperty(v);
      delete root.dataset.keyboard;
    };
  }, []);
}
