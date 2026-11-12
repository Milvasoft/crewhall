// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/background-remover/logic.ts. See THIRD_PARTY.md.
/**
 * Color-key background removal. Pure pixel math (operates on the RGBA buffer),
 * so it's testable without a canvas; the component handles image ↔ canvas.
 */

export interface RGB {
  r: number;
  g: number;
  b: number;
}

/** Euclidean distance in RGB space (0 … ~441). */
export function colorDistance(a: RGB, b: RGB): number {
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

/**
 * Alpha for a pixel given its distance to the key color:
 *  - within `tolerance`   → 0 (fully transparent),
 *  - beyond tolerance+feather → 255 (opaque),
 *  - in between           → linear ramp (soft edge).
 */
export function alphaForDistance(dist: number, tolerance: number, feather: number): number {
  if (dist <= tolerance) return 0;
  if (feather <= 0 || dist >= tolerance + feather) return 255;
  return Math.round(((dist - tolerance) / feather) * 255);
}

/** Average of the four corner pixels, a good guess for the background color. */
export function autoDetectBackground(data: Uint8ClampedArray, width: number, height: number): RGB {
  const at = (x: number, y: number) => (y * width + x) * 4;
  const corners = [at(0, 0), at(width - 1, 0), at(0, height - 1), at(width - 1, height - 1)];
  let r = 0;
  let g = 0;
  let b = 0;
  for (const i of corners) {
    r += data[i] ?? 0;
    g += data[i + 1] ?? 0;
    b += data[i + 2] ?? 0;
  }
  return { r: Math.round(r / 4), g: Math.round(g / 4), b: Math.round(b / 4) };
}

/**
 * Mutates the RGBA buffer in place, lowering alpha for pixels near `target`.
 * Existing transparency is preserved (we only ever reduce alpha).
 */
export function removeBackground(
  data: Uint8ClampedArray,
  target: RGB,
  tolerance: number,
  feather: number,
): void {
  for (let i = 0; i < data.length; i += 4) {
    const dist = colorDistance(
      { r: data[i] ?? 0, g: data[i + 1] ?? 0, b: data[i + 2] ?? 0 },
      target,
    );
    const alpha = alphaForDistance(dist, tolerance, feather);
    if (alpha < (data[i + 3] ?? 0)) data[i + 3] = alpha;
  }
}
