import { describe, expect, it } from 'vitest';
import light from '../assets/lottie/crewhall-loader.json';
import dark from '../assets/lottie/crewhall-loader-white.json';
import { LOADER_MAX_MS, LOADER_MIN_MS, loaderHold } from '../src/common/loading';

describe('loaderHold', () => {
  it('keeps the loader up for the rest of the minimum when the page is quick', () => {
    expect(LOADER_MIN_MS).toBe(800);
    expect(loaderHold(1_000, 1_000)).toBe(800);
    expect(loaderHold(1_000, 1_300)).toBe(500);
  });

  it('closes at once when the page took longer than that', () => {
    expect(loaderHold(1_000, 1_800)).toBe(0);
    expect(loaderHold(1_000, 9_000)).toBe(0);
  });

  it('never waits longer than the minimum, even with a clock that went back', () => {
    expect(loaderHold(5_000, 1_000)).toBe(800);
    expect(LOADER_MAX_MS).toBeGreaterThan(LOADER_MIN_MS);
  });
});

describe('loader animation (crewhall-brand/lottie)', () => {
  it('is the 2 s, 60 fps loop with the ring and dot layers, light and dark', () => {
    for (const anim of [light, dark]) {
      expect(anim.fr).toBe(60);
      expect(anim.op - anim.ip).toBe(120);
      expect(anim.w).toBe(200);
      expect(anim.layers.map((l: { nm: string }) => l.nm)).toEqual(
        expect.arrayContaining(['ring', 'dot']),
      );
    }
  });
});
