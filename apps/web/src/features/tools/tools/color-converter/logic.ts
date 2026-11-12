// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/color-converter/logic.ts. See THIRD_PARTY.md.
/**
 * Color parsing and conversion between hex, rgb(a) and hsl(a). Pure and local.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
  a: number; // 0–1
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
const round = (n: number) => Math.round(n * 100) / 100;

/** Parse a hex, rgb()/rgba() or hsl()/hsla() string into RGBA. Throws if unrecognized. */
export function parseColor(input: string): Rgb {
  const s = input.trim().toLowerCase();
  if (!s) throw new Error('Enter a color.');

  // #rgb / #rgba / #rrggbb / #rrggbbaa
  const hex = s.replace(/^#/, '');
  if (/^([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(hex)) {
    return hexToRgb(hex);
  }

  const rgbMatch = s.match(/^rgba?\(([^)]+)\)$/);
  if (rgbMatch) {
    const parts = rgbMatch[1]!.split(/[,\s/]+/).filter(Boolean);
    const [r = NaN, g = NaN, b = NaN] = parts.slice(0, 3).map((p) => parseChannel(p, 255));
    const a = parts[3] !== undefined ? parseAlpha(parts[3]) : 1;
    return { r: clamp(r, 0, 255), g: clamp(g, 0, 255), b: clamp(b, 0, 255), a };
  }

  const hslMatch = s.match(/^hsla?\(([^)]+)\)$/);
  if (hslMatch) {
    const parts = hslMatch[1]!.split(/[,\s/]+/).filter(Boolean);
    const h = parseFloat(parts[0] ?? '');
    const sl = parseFloat(parts[1] ?? '') / 100;
    const l = parseFloat(parts[2] ?? '') / 100;
    const a = parts[3] !== undefined ? parseAlpha(parts[3]) : 1;
    return { ...hslToRgb(h, sl, l), a };
  }

  throw new Error('Unrecognized color. Try #hex, rgb() or hsl().');
}

function parseChannel(p: string, max: number): number {
  if (p.endsWith('%')) return (parseFloat(p) / 100) * max;
  return parseFloat(p);
}
function parseAlpha(p: string): number {
  return clamp(p.endsWith('%') ? parseFloat(p) / 100 : parseFloat(p), 0, 1);
}

function hexToRgb(hex: string): Rgb {
  let h = hex;
  if (h.length === 3 || h.length === 4) {
    h = h
      .split('')
      .map((c) => c + c)
      .join('');
  }
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
  return { r, g, b, a: round(a) };
}

export function rgbToHex({ r, g, b, a }: Rgb, forceAlpha = false): string {
  const to2 = (n: number) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0');
  const base = `#${to2(r)}${to2(g)}${to2(b)}`;
  if (a < 1 || forceAlpha) return base + to2(a * 255);
  return base;
}

export interface Hsl {
  h: number;
  s: number;
  l: number;
  a: number;
}

export function rgbToHsl({ r, g, b, a }: Rgb): Hsl {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const l = (max + min) / 2;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return { h: round(h), s: round(s * 100), l: round(l * 100), a };
}

export function hslToRgb(h: number, s: number, l: number): Omit<Rgb, 'a'> {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r1: number;
  let g1: number;
  let b1: number;
  if (hp < 1) [r1, g1, b1] = [c, x, 0];
  else if (hp < 2) [r1, g1, b1] = [x, c, 0];
  else if (hp < 3) [r1, g1, b1] = [0, c, x];
  else if (hp < 4) [r1, g1, b1] = [0, x, c];
  else if (hp < 5) [r1, g1, b1] = [x, 0, c];
  else [r1, g1, b1] = [c, 0, x];
  const m = l - c / 2;
  return {
    r: Math.round((r1 + m) * 255),
    g: Math.round((g1 + m) * 255),
    b: Math.round((b1 + m) * 255),
  };
}

export interface ColorForms {
  hex: string;
  rgb: string;
  hsl: string;
  rgbObject: Rgb;
}

export function convertColor(input: string): ColorForms {
  const rgb = parseColor(input);
  const hsl = rgbToHsl(rgb);
  const hasAlpha = rgb.a < 1;
  return {
    hex: rgbToHex(rgb),
    rgb: hasAlpha
      ? `rgba(${Math.round(rgb.r)}, ${Math.round(rgb.g)}, ${Math.round(rgb.b)}, ${round(rgb.a)})`
      : `rgb(${Math.round(rgb.r)}, ${Math.round(rgb.g)}, ${Math.round(rgb.b)})`,
    hsl: hasAlpha
      ? `hsla(${hsl.h}, ${hsl.s}%, ${hsl.l}%, ${round(hsl.a)})`
      : `hsl(${hsl.h}, ${hsl.s}%, ${hsl.l}%)`,
    rgbObject: rgb,
  };
}
