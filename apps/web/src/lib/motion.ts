import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from 'react';

/**
 * Small motion helpers (CSS first; no animation library). Everything here honours reduced
 * motion: the OS setting or the account switch (`<html data-motion="reduced">`). CSS
 * animations are zeroed by the global rule in @crewhall/ui; the JS ones below check it.
 */

const QUERY = '(prefers-reduced-motion: reduce)';

export function isReducedMotion(): boolean {
  if (typeof document === 'undefined') return true;
  if (document.documentElement.dataset.motion === 'reduced') return true;
  return typeof window.matchMedia === 'function' && window.matchMedia(QUERY).matches;
}

function subscribe(onChange: () => void): () => void {
  const mq = typeof window.matchMedia === 'function' ? window.matchMedia(QUERY) : null;
  mq?.addEventListener?.('change', onChange);
  const mo = new MutationObserver(onChange);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-motion'] });
  return () => {
    mq?.removeEventListener?.('change', onChange);
    mo.disconnect();
  };
}

export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, isReducedMotion, () => true);
}

function sameKeys(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((k, i) => k === b[i]);
}

/**
 * Keys that arrived while the list was on screen, so only those animate in. The first
 * render, a list that was not `ready` yet and big jumps (a page of history, a jump to the
 * latest window: more than `max` new keys at once) never count. With `tail`, only keys
 * added after the last known one count, so older pages loaded above stay still.
 */
export function useArrivals(
  keys: readonly string[],
  { ready = true, max = 3, tail = false }: { ready?: boolean; max?: number; tail?: boolean } = {},
): ReadonlySet<string> {
  const [snap, setSnap] = useState<{
    keys: readonly string[];
    ready: boolean;
    arrived: ReadonlySet<string>;
  }>(() => ({ keys, ready, arrived: new Set() }));
  if (snap.ready !== ready || !sameKeys(snap.keys, keys)) {
    let arrived = snap.arrived;
    if (snap.ready && ready) {
      const known = new Set(snap.keys);
      let start = 0;
      if (tail) {
        for (let i = keys.length - 1; i >= 0; i--) {
          if (known.has(keys[i] ?? '')) {
            start = i + 1;
            break;
          }
        }
      }
      const fresh = keys.slice(start).filter((k) => !known.has(k));
      if (fresh.length > 0 && fresh.length <= max) {
        // Keys stay marked: the class must not vanish mid-animation on the next render.
        const next = new Set([...arrived].filter((k) => keys.includes(k)));
        fresh.forEach((k) => next.add(k));
        arrived = next;
      }
    }
    setSnap({ keys, ready, arrived });
  }
  return snap.arrived;
}

/**
 * Counts how often `value` changed since mount (0 = never). Use it as a React key with an
 * animation class so a badge bumps on change but not on first paint.
 */
export function useChangeCount<T>(value: T): number {
  const [s, setS] = useState({ value, n: 0 });
  if (!Object.is(s.value, value)) setS({ value, n: s.n + 1 });
  return s.n;
}

/**
 * Badge motion: pops in when `value` goes from 0 to something, bumps when it changes after
 * that, nothing on first paint. Spread `key` on the badge so the animation replays.
 */
export function useBadgeMotion(value: number): { key: number; className: string | undefined } {
  const [s, setS] = useState<{ value: number; key: number; className: string | undefined }>({
    value,
    key: 0,
    className: undefined,
  });
  if (s.value !== value) {
    const className = value === 0 ? undefined : s.value === 0 ? 'animate-pop' : 'animate-bump';
    setS({ value, key: s.key + 1, className });
  }
  return { key: s.key, className: s.className };
}

/**
 * Keeps an element mounted for `ms` after `show` turns false so it can play its exit
 * animation (`state === 'closed'`). Reduced motion unmounts at once.
 */
export function useExit(show: boolean, ms = 160): { mounted: boolean; state: 'open' | 'closed' } {
  const reduced = useReducedMotion();
  const [mounted, setMounted] = useState(show);
  if (show && !mounted) setMounted(true);
  if (!show && mounted && reduced) setMounted(false);
  useEffect(() => {
    if (show || !mounted) return;
    const id = window.setTimeout(() => setMounted(false), ms);
    return () => window.clearTimeout(id);
  }, [show, mounted, ms]);
  return { mounted: show || (mounted && !reduced), state: show ? 'open' : 'closed' };
}

const FLIP_ID = 'ch-flip';

/**
 * FLIP for a list whose rows move (a chat jumping to the top with a new message). Rows carry
 * `data-flip-key`; after each commit, rows that moved slide from where they were. A running
 * slide is picked up from its current spot, so quick successive moves stay smooth.
 */
export function useFlip(ref: RefObject<HTMLElement | null>, { ms = 240 }: { ms?: number } = {}) {
  const last = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const rows = [...root.querySelectorAll<HTMLElement>('[data-flip-key]')];
    const base = root.getBoundingClientRect().top - root.scrollTop;
    // Read all, then write all: one layout pass for the whole list.
    const visual = rows.map((el) => el.getBoundingClientRect().top);
    const running = rows.map((el) =>
      typeof el.getAnimations === 'function'
        ? el.getAnimations().filter((a) => a.id === FLIP_ID)
        : [],
    );
    running.forEach((list) => list.forEach((a) => a.cancel()));
    const layout = rows.map((el) => el.getBoundingClientRect().top);
    const reduced = isReducedMotion();
    const next = new Map<string, number>();
    rows.forEach((el, i) => {
      const key = el.dataset.flipKey ?? '';
      const top = (layout[i] ?? 0) - base;
      next.set(key, top);
      const before = last.current.get(key);
      if (before === undefined || reduced || typeof el.animate !== 'function') return;
      // Where it was drawn a moment ago: its old layout spot plus any slide in progress.
      const offset = (visual[i] ?? 0) - (layout[i] ?? 0);
      const dy = before + offset - top;
      if (Math.abs(dy) < 1) return;
      const a = el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], {
        duration: ms,
        easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
      });
      a.id = FLIP_ID;
    });
    last.current = next;
  });
}
