/**
 * Motion for the app's own pages, matching the web app (doc 16 tokens: 120/180/240 ms, the
 * standard ease-out). Web Animations only; nothing runs when the OS asks for reduced motion.
 */

export const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)';

export function reducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Fades an element in while it rises a few pixels. */
export function enter(el: Element | null | undefined, { y = 6, ms = 200, delay = 0 } = {}): void {
  if (!el || reducedMotion()) return;
  el.animate(
    [
      { opacity: 0, transform: `translateY(${y}px)` },
      { opacity: 1, transform: 'none' },
    ],
    { duration: ms, delay, easing: EASE, fill: 'backwards' },
  );
}

/** The first few children one after another (30 ms apart), the rest together. */
export function stagger(parent: Element | null | undefined, step = 30): void {
  if (!parent) return;
  [...parent.children].forEach((child, i) => enter(child, { delay: Math.min(i, 6) * step }));
}

/** A short scale bump for something that just changed (a status chip, a new count). */
export function bump(el: Element | null | undefined): void {
  if (!el || reducedMotion()) return;
  el.animate(
    [
      { transform: 'scale(0.92)', opacity: 0.6 },
      { transform: 'none', opacity: 1 },
    ],
    {
      duration: 180,
      easing: EASE,
    },
  );
}

/** Grows a bar from its previous width to the new one. */
export function growWidth(el: HTMLElement, fromPct: number, toPct: number): void {
  el.style.width = `${toPct}%`;
  if (reducedMotion() || fromPct === toPct) return;
  el.animate([{ width: `${fromPct}%` }, { width: `${toPct}%` }], { duration: 240, easing: EASE });
}
