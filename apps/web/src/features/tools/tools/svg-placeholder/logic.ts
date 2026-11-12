// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/svg-placeholder/logic.ts. See THIRD_PARTY.md.
/**
 * Generate placeholder SVG images. Pure and local.
 */

export interface SvgOptions {
  width: number;
  height: number;
  bg: string;
  fg: string;
  text?: string;
  fontSize?: number;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function generateSvg(o: SvgOptions): string {
  const { width, height, bg, fg } = o;
  const text = o.text ?? `${width}×${height}`;
  const fontSize = o.fontSize ?? Math.max(10, Math.round(Math.min(width, height) / 5));
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect width="${width}" height="${height}" fill="${esc(bg)}"/>`,
    `<text x="50%" y="50%" dy=".35em" text-anchor="middle" fill="${esc(fg)}" font-family="sans-serif" font-size="${fontSize}">${esc(text)}</text>`,
    `</svg>`,
  ].join('');
}

/** A `data:` URI usable directly in `src` / CSS `url()`. */
export function svgToDataUri(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
