import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEdgeAutoScroll } from '@/features/quick/edgeAutoScroll';

/** A scroller 500 px tall at the top of the window, with the surface inside it. */
function setup(contentHeight: number) {
  const scroller = document.createElement('main');
  scroller.style.overflowY = 'auto';
  const surface = document.createElement('div');
  scroller.append(surface);
  document.body.append(scroller);
  let top = 0;
  Object.defineProperty(scroller, 'clientHeight', { value: 500 });
  Object.defineProperty(scroller, 'scrollHeight', {
    get: () => Math.max(contentHeight, parseInt(surface.style.minHeight || '0', 10)),
  });
  Object.defineProperty(scroller, 'scrollTop', {
    get: () => top,
    set: (v: number) => {
      top = Math.max(0, Math.min(v, scroller.scrollHeight - 500));
    },
  });
  Object.defineProperty(surface, 'offsetHeight', { value: contentHeight });
  scroller.getBoundingClientRect = () => ({ top: 0, bottom: 500 }) as DOMRect;
  return { scroller, surface };
}

let frames: FrameRequestCallback[] = [];
const runFrames = (n: number) => {
  for (let i = 0; i < n; i++) {
    const due = frames;
    frames = [];
    for (const f of due) f(0);
  }
};

beforeEach(() => {
  frames = [];
  vi.stubGlobal('requestAnimationFrame', (f: FrameRequestCallback) => frames.push(f));
  vi.stubGlobal('cancelAnimationFrame', () => {
    frames = [];
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('edge auto-scroll while editing the surface', () => {
  it('scrolls down near the bottom edge and replays the pointer for the grid', () => {
    const { scroller, surface } = setup(1200);
    const { result } = renderHook(() => useEdgeAutoScroll({ current: surface }));
    const replayed: number[] = [];
    document.addEventListener('mousemove', (e) => {
      if (scroller.scrollTop > 0) replayed.push(e.clientY);
    });

    result.current.start();
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 10, clientY: 490 }));
    runFrames(5);

    expect(scroller.scrollTop).toBeGreaterThan(0);
    expect(replayed.length).toBeGreaterThan(0);
    expect(replayed.every((y) => y === 490)).toBe(true);

    result.current.stop();
    const at = scroller.scrollTop;
    runFrames(5);
    expect(scroller.scrollTop).toBe(at);
  });

  it('stretches the surface when the page has run out, and lets go on stop', () => {
    const { scroller, surface } = setup(500);
    const { result } = renderHook(() => useEdgeAutoScroll({ current: surface }));

    result.current.start();
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 10, clientY: 499 }));
    runFrames(10);

    expect(parseInt(surface.style.minHeight, 10)).toBeGreaterThan(500);
    expect(scroller.scrollTop).toBeGreaterThan(0);

    result.current.stop();
    expect(surface.style.minHeight).toBe('');
  });

  it('does nothing away from the edges', () => {
    const { scroller, surface } = setup(1200);
    const { result } = renderHook(() => useEdgeAutoScroll({ current: surface }));
    result.current.start();
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 10, clientY: 250 }));
    runFrames(5);
    expect(scroller.scrollTop).toBe(0);
    result.current.stop();
  });
});
