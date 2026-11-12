'use client';

import { useEffect, useLayoutEffect } from 'react';
import { damp, timeline } from '@/components/home/motion/math';

/**
 * The home page's scroll engine: one requestAnimationFrame loop for every scene.
 *
 * - Scroll stays native (no wheel or touch hijacking). Each scene's timeline is derived from the
 *   scroll position and its wrapper's document offset, which is measured only on resize or when
 *   the page height changes, so frames never read layout.
 * - The timeline a scene renders is eased toward the scroll position (exponential smoothing),
 *   which gives every scrubbed motion a little inertia without delaying the page itself.
 * - It idles when nothing moves, skips scenes far off screen, and stops completely (resetting
 *   every inline style) when the user prefers reduced motion; pins and overlaps are CSS and are
 *   switched off by the same media query.
 */

export interface FrameContext {
  vw: number;
  /** Small viewport height (100svh), the unit of every timeline. */
  vh: number;
  /** ms since the previous frame (0 on the first one). */
  dt: number;
  now: number;
  /** Smoothed scroll velocity, px per ms (positive = scrolling down). */
  velocity: number;
  /** ≤ 768px wide. */
  compact: boolean;
  /** Coarse pointer: touch screens. */
  touch: boolean;
}

export interface Scene {
  /** The wrapper whose document position defines the timeline. */
  el: HTMLElement;
  /**
   * Layout reads (sizes, offsets). Runs on mount and whenever the layout may have changed.
   * `live` is false while the page lays its sections out statically (see Home.module.css).
   */
  measure?(ctx: FrameContext, live: boolean): void;
  /**
   * Writes styles for timeline position `t` (vh) and wrapper length `len` (vh).
   * Returns true when it needs another frame regardless of scrolling (time-based motion).
   */
  render(t: number, len: number, ctx: FrameContext): boolean | void;
  /** Removes everything `render` wrote (reduced motion, static layout, unmount). */
  reset(): void;
  /** Releases listeners the scene added; runs once, on unmount. */
  dispose?(): void;
}

interface Entry {
  scene: Scene;
  top: number;
  height: number;
  t: number;
  /** Timeline value last rendered while off screen, so idle scenes are not rendered again. */
  parked: number | null;
  fresh: boolean;
  /** The stages are pinned (CSS sets --motion: 1); otherwise the scene rests. */
  live: boolean;
  resting: boolean;
}

const SMOOTHING_FINE = 11;
const SMOOTHING_TOUCH = 16;
/** Jumps longer than this (vh) are not animated (anchor links, restored scroll). */
const MAX_SWEEP = 2.5;

class Engine {
  private entries = new Set<Entry>();
  private frame = 0;
  private last = 0;
  private lastY = 0;
  private velocity = 0;
  private dirty = true;
  private reduced = false;
  private probe: HTMLDivElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private queries: {
    reduced: MediaQueryList;
    compact: MediaQueryList;
    touch: MediaQueryList;
  } | null = null;
  private ctx: FrameContext = {
    vw: 0,
    vh: 0,
    dt: 0,
    now: 0,
    velocity: 0,
    compact: false,
    touch: false,
  };

  request(): void {
    this.kick();
  }

  /** Renders every scene at its scroll position right away (development screenshots). */
  settle(): void {
    if (this.reduced || !this.queries) return;
    this.dirty = true;
    this.measure();
    this.step(performance.now(), true);
  }

  add(scene: Scene): () => void {
    if (!this.queries) this.start();
    const entry: Entry = {
      scene,
      top: 0,
      height: 0,
      t: 0,
      parked: null,
      fresh: true,
      live: true,
      resting: false,
    };
    this.entries.add(entry);
    this.dirty = true;
    if (!this.reduced) {
      // first render synchronously, so the first paint already shows the right pose
      this.measure();
      this.step(performance.now(), true);
    }
    this.kick();
    return () => {
      scene.reset();
      scene.dispose?.();
      this.entries.delete(entry);
      if (!this.entries.size) this.stop();
    };
  }

  private start() {
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    const compact = matchMedia('(max-width: 768px)');
    const touch = matchMedia('(pointer: coarse)');
    this.queries = { reduced, compact, touch };
    this.reduced = reduced.matches;
    reduced.addEventListener('change', this.onReducedChange);
    compact.addEventListener('change', this.invalidate);
    this.probe = document.createElement('div');
    this.probe.setAttribute('aria-hidden', 'true');
    this.probe.style.cssText =
      'position:fixed;left:0;top:0;width:0;height:100vh;height:100svh;visibility:hidden;pointer-events:none';
    document.body.appendChild(this.probe);
    this.resizeObserver = new ResizeObserver(this.invalidate);
    this.resizeObserver.observe(document.body);
    window.addEventListener('scroll', this.kick, { passive: true });
    window.addEventListener('resize', this.invalidate, { passive: true });
    void document.fonts?.ready.then(this.invalidate);
    this.lastY = window.scrollY;
  }

  private stop() {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    if (this.queries) {
      this.queries.reduced.removeEventListener('change', this.onReducedChange);
      this.queries.compact.removeEventListener('change', this.invalidate);
    }
    this.queries = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.probe?.remove();
    this.probe = null;
    window.removeEventListener('scroll', this.kick);
    window.removeEventListener('resize', this.invalidate);
  }

  private onReducedChange = (e: MediaQueryListEvent) => {
    this.reduced = e.matches;
    if (this.reduced) {
      for (const entry of this.entries) entry.scene.reset();
    } else {
      for (const entry of this.entries) entry.fresh = true;
      this.invalidate();
    }
  };

  private invalidate = () => {
    this.dirty = true;
    this.kick();
  };

  private kick = () => {
    if (!this.frame && !this.reduced && this.queries) this.frame = requestAnimationFrame(this.tick);
  };

  private measure() {
    if (!this.dirty || !this.queries) return;
    this.dirty = false;
    const ctx = this.ctx;
    ctx.vw = document.documentElement.clientWidth;
    ctx.vh = this.probe?.offsetHeight || window.innerHeight;
    ctx.compact = this.queries.compact.matches;
    ctx.touch = this.queries.touch.matches;
    const y = window.scrollY;
    for (const entry of this.entries) {
      const el = entry.scene.el;
      entry.live = getComputedStyle(el).getPropertyValue('--motion').trim() === '1';
      if (entry.live) entry.resting = false;
      entry.parked = null;
    }
    for (const entry of this.entries) entry.scene.measure?.(ctx, entry.live);
    // a scene's measure may resize its wrapper (e.g. a horizontal track): read the boxes again
    for (const entry of this.entries) {
      const r = entry.scene.el.getBoundingClientRect();
      entry.top = r.top + y;
      entry.height = r.height;
    }
  }

  private tick = (now: number) => {
    this.frame = 0;
    if (this.reduced) return;
    this.measure();
    if (this.step(now, false)) this.kick();
  };

  /** Renders every scene once; true while anything is still moving. */
  private step(now: number, instant: boolean): boolean {
    const ctx = this.ctx;
    const dt = this.last ? Math.min(100, now - this.last) : 0;
    this.last = now;
    const y = window.scrollY;
    const raw = dt > 0 ? (y - this.lastY) / dt : 0;
    this.lastY = y;
    this.velocity = instant ? 0 : damp(this.velocity, raw, 8, dt || 16, 0.002);
    ctx.dt = dt;
    ctx.now = now;
    ctx.velocity = this.velocity;
    let moving = this.velocity !== 0;
    const lambda = ctx.touch ? SMOOTHING_TOUCH : SMOOTHING_FINE;

    for (const entry of this.entries) {
      if (!entry.live) {
        if (!entry.resting) {
          entry.resting = true;
          entry.scene.reset();
        }
        continue;
      }
      const vh = ctx.vh || 1;
      const len = entry.height / vh;
      const target = timeline(entry.top, y, vh);
      if (instant || entry.fresh || dt === 0 || Math.abs(target - entry.t) > MAX_SWEEP) {
        entry.t = target;
      } else {
        entry.t = damp(entry.t, target, lambda, dt);
      }
      entry.fresh = false;
      // off screen (with a margin): render the clamped edge pose once, then leave it parked
      const off = entry.t < -0.3 || entry.t > len + 1.3;
      if (off) {
        const edge = entry.t < 0 ? -0.3 : len + 1.3;
        if (entry.parked === edge) continue;
        entry.parked = edge;
        entry.scene.render(edge, len, ctx);
        continue;
      }
      entry.parked = null;
      if (entry.scene.render(entry.t, len, ctx)) moving = true;
      if (entry.t !== target) moving = true;
    }
    return moving;
  }
}

let engine: Engine | null = null;

declare global {
  interface Window {
    /** Development only: lets a hidden preview (throttled frames) be put in pose for screenshots. */
    __homeMotion?: { settle(): void };
  }
}

function createEngine(): Engine {
  const created = new Engine();
  if (process.env.NODE_ENV !== 'production') {
    window.__homeMotion = { settle: () => created.settle() };
  }
  return created;
}

/** Asks for a frame outside scrolling (e.g. pointer parallax). */
export function requestFrame(): void {
  engine?.request();
}

// useLayoutEffect warns during SSR; the first pose must be written before the first paint.
const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * Registers a scene built from refs once the component has mounted. `build` returns null when
 * the elements it needs are missing.
 *
 * React attaches refs bottom-up in the same pass as layout effects, so a section's content runs
 * its effect before the frame's own wrapper ref is set. Building in a microtask waits for the
 * whole commit while still writing the first pose before the browser paints.
 */
export function useScene(build: () => Scene | null): void {
  useIsoLayoutEffect(() => {
    let off: (() => void) | null = null;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      const scene = build();
      if (!scene) return;
      engine ??= createEngine();
      off = engine.add(scene);
    });
    return () => {
      cancelled = true;
      off?.();
    };
    // the scene is built once from refs; its inputs are read through them
  }, []);
}
