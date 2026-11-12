// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/background-remover/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { alphaForDistance, autoDetectBackground, colorDistance, removeBackground } from './logic';

describe('background-remover', () => {
  it('computes color distance', () => {
    expect(colorDistance({ r: 0, g: 0, b: 0 }, { r: 0, g: 0, b: 0 })).toBe(0);
    expect(colorDistance({ r: 255, g: 255, b: 255 }, { r: 0, g: 0, b: 0 })).toBeCloseTo(441.67, 1);
  });

  it('ramps alpha across the feather range', () => {
    expect(alphaForDistance(5, 10, 20)).toBe(0); // within tolerance
    expect(alphaForDistance(40, 10, 20)).toBe(255); // beyond tolerance+feather
    expect(alphaForDistance(20, 10, 20)).toBe(128); // halfway
  });

  it('auto-detects background from corners', () => {
    // 2×2 image, all white corners.
    const data = new Uint8ClampedArray(2 * 2 * 4).fill(255);
    expect(autoDetectBackground(data, 2, 2)).toEqual({ r: 255, g: 255, b: 255 });
  });

  it('makes matching pixels transparent and leaves others opaque', () => {
    // Two pixels: white (bg) and black (subject).
    const data = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]);
    removeBackground(data, { r: 255, g: 255, b: 255 }, 10, 0);
    expect(data[3]).toBe(0); // white → transparent
    expect(data[7]).toBe(255); // black → untouched
  });

  it('treats the tolerance boundary as fully transparent and the tolerance+feather boundary as fully opaque', () => {
    expect(alphaForDistance(10, 10, 20)).toBe(0); // dist === tolerance
    expect(alphaForDistance(30, 10, 20)).toBe(255); // dist === tolerance + feather
    expect(alphaForDistance(29, 10, 20)).not.toBe(255); // just inside the ramp
  });

  it('treats a non-positive feather as a hard edge beyond tolerance', () => {
    expect(alphaForDistance(11, 10, 0)).toBe(255);
    expect(alphaForDistance(100, 10, -5)).toBe(255);
  });

  it('averages four distinct corner colors and ignores interior pixels', () => {
    // 3×2 image; corners each a pure primary/black, interior pixels are a
    // different color that must not influence the average.
    const width = 3;
    const height = 2;
    const data = new Uint8ClampedArray(width * height * 4).fill(255);
    const at = (x: number, y: number) => (y * width + x) * 4;
    const setPixel = (x: number, y: number, r: number, g: number, b: number) => {
      const i = at(x, y);
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    };
    setPixel(0, 0, 0, 0, 0);
    setPixel(2, 0, 100, 0, 0);
    setPixel(0, 1, 0, 100, 0);
    setPixel(2, 1, 0, 0, 100);
    // Interior pixels: should be ignored by the corner average.
    setPixel(1, 0, 9, 9, 9);
    setPixel(1, 1, 9, 9, 9);

    expect(autoDetectBackground(data, width, height)).toEqual({ r: 25, g: 25, b: 25 });
  });

  it('only ever lowers alpha, never raises pixels that are already more transparent', () => {
    // A pixel far from the key color (would compute alpha 255) that is
    // already partially transparent must keep its lower existing alpha.
    const data = new Uint8ClampedArray([0, 0, 0, 50]);
    removeBackground(data, { r: 255, g: 255, b: 255 }, 10, 0);
    expect(data[3]).toBe(50);
  });

  it('applies a soft ramp across multiple pixels in one buffer', () => {
    // Three pixels at increasing distance from white: within tolerance,
    // halfway through the feather, and beyond it.
    const data = new Uint8ClampedArray([
      255,
      255,
      255,
      255, // dist 0 (within tolerance)
      235,
      235,
      235,
      255, // dist ~34.6 -> beyond tolerance(10)+feather(20)=30 -> opaque
      248,
      248,
      248,
      255, // dist ~12.1 -> within the ramp
    ]);
    removeBackground(data, { r: 255, g: 255, b: 255 }, 10, 20);
    expect(data[3]).toBe(0);
    expect(data[7]).toBe(255);
    expect(data[11]).toBeGreaterThan(0);
    expect(data[11]).toBeLessThan(255);
  });
});
