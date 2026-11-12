import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SAVED_AFTER_MS, SLOW_SAVE_MS, useCalmSaveState } from '@/lib/wiki/saveState';

/** The page's save status stays out of the way while typing. */
describe('useCalmSaveState', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const tick = (ms: number) =>
    act(() => {
      vi.advanceTimersByTime(ms);
    });

  it('says nothing on opening a page and nothing while typing', () => {
    const { result, rerender } = renderHook(({ n }) => useCalmSaveState(n), {
      initialProps: { n: 0 },
    });
    tick(10_000);
    expect(result.current).toBe('quiet');
    // Keystrokes: the count flips within milliseconds.
    for (let i = 0; i < 20; i++) {
      rerender({ n: 1 });
      tick(40);
      expect(result.current).toBe('quiet');
      rerender({ n: 0 });
      tick(80);
      expect(result.current).toBe('quiet');
    }
  });

  it('says "saved" only after the page has been still for a moment', () => {
    const { result, rerender } = renderHook(({ n }) => useCalmSaveState(n), {
      initialProps: { n: 1 },
    });
    tick(50);
    rerender({ n: 0 });
    tick(SAVED_AFTER_MS - 1);
    expect(result.current).toBe('quiet');
    tick(1);
    expect(result.current).toBe('saved');
    // Typing again hides it at once.
    rerender({ n: 1 });
    expect(result.current).toBe('quiet');
  });

  it('says "saving" when one save stays pending, and "saved" as soon as it lands', () => {
    const { result, rerender } = renderHook(({ n }) => useCalmSaveState(n), {
      initialProps: { n: 1 },
    });
    tick(SLOW_SAVE_MS - 1);
    expect(result.current).toBe('quiet');
    tick(1);
    expect(result.current).toBe('slow');
    rerender({ n: 0 });
    expect(result.current).toBe('saved');
  });
});
