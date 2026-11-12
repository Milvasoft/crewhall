/**
 * Crewhall design tokens (design doc 16 and docs/Crewhall tasarımı/_kit/head.html).
 * Platform independent: no React, DOM or Tailwind imports. Web turns these into CSS variables
 * (styles.css + buildThemeCss), mobile reads the values directly.
 */
import {
  contrastRatio,
  hexToOklch,
  luminance,
  mixHex,
  oklchToHex,
  withAlpha,
  type Oklch,
} from './color';

export * from './color';

export type ColorScheme = 'light' | 'dark';

/** Semantic color tokens. Names match the kit CSS variables (`--bg`, `--fg2`, ...). */
export interface ColorTokens {
  bg: string;
  bg2: string;
  surface: string;
  line: string;
  line2: string;
  fg: string;
  fg2: string;
  fg3: string;
  accent: string;
  accentFg: string;
  accentText: string;
  accent10: string;
  danger: string;
  success: string;
  warning: string;
  info: string;
  glass: string;
  glassLine: string;
  capsule: string;
  scrim: string;
  shadow: string;
  shadowSm: string;
  chDot: string;
}

export const colors: Record<ColorScheme, ColorTokens> = {
  light: {
    bg: '#F7F7F6',
    bg2: '#EFEFED',
    surface: '#FFFFFF',
    line: 'rgba(11,11,11,.08)',
    line2: 'rgba(11,11,11,.14)',
    fg: '#0B0B0B',
    fg2: '#5F5F5F',
    fg3: '#9A9A98',
    accent: '#F9C31A',
    accentFg: '#0B0B0B',
    accentText: '#8C6500',
    accent10: 'rgba(249,195,26,.18)',
    danger: '#DC3B3B',
    success: '#15803D',
    warning: '#C2620F',
    info: '#0E7490',
    glass: 'rgba(255,255,255,.74)',
    glassLine: 'rgba(11,11,11,.07)',
    capsule: 'rgba(11,11,11,.07)',
    scrim: 'rgba(0,0,0,.38)',
    shadow: '0 14px 36px rgba(0,0,0,.12)',
    shadowSm: '0 1px 3px rgba(0,0,0,.08)',
    chDot: '#118478',
  },
  dark: {
    bg: '#0E0F0F',
    bg2: '#1D1E1F',
    surface: '#151617',
    line: 'rgba(255,255,255,.08)',
    line2: 'rgba(255,255,255,.16)',
    fg: '#F5F5F5',
    fg2: '#A5A6A6',
    fg3: '#6D6E6E',
    accent: '#FBC419',
    accentFg: '#0B0B0B',
    accentText: '#FBC419',
    accent10: 'rgba(251,196,25,.14)',
    danger: '#FF6369',
    success: '#3DD68C',
    warning: '#F38424',
    info: '#38BDF8',
    glass: 'rgba(32,33,34,.64)',
    glassLine: 'rgba(255,255,255,.12)',
    capsule: 'rgba(255,255,255,.12)',
    scrim: 'rgba(0,0,0,.55)',
    shadow: '0 14px 40px rgba(0,0,0,.55)',
    shadowSm: '0 1px 3px rgba(0,0,0,.4)',
    chDot: '#3CC6B2',
  },
};

/** Space category colors s1..s6 (not accent; dots and badges only). s6 is the personal space. */
export const spaceColors: Record<
  ColorScheme,
  Record<'s1' | 's2' | 's3' | 's4' | 's5' | 's6', string>
> = {
  light: {
    s1: '#3B82F6',
    s2: '#14B8A6',
    s3: '#EC4899',
    s4: '#8B5CF6',
    s5: '#84CC16',
    s6: '#8A8A88',
  },
  dark: {
    s1: '#60A5FA',
    s2: '#2DD4BF',
    s3: '#F472B6',
    s4: '#A78BFA',
    s5: '#A3E635',
    s6: '#A5A6A6',
  },
};

/** Product brand (Crewhall). Tenant brand comes from the bootstrap endpoint at runtime. */
export const brand = {
  graphite: '#141516',
  yellow: '#FBC419',
  orange: '#F38424',
  gray: '#C0BFBE',
  green: '#118478',
} as const;

export const fonts = {
  sans: "'Nunito Variable', Nunito, system-ui, sans-serif",
  mono: "'Geist Mono', ui-monospace, monospace",
} as const;

/** Type scale: [fontSize, lineHeight, weight, letterSpacing(em)]. */
export const typography = {
  hero: { size: 52, line: 52, weight: 700, tracking: -0.035 },
  large: { size: 34, line: 40, weight: 700, tracking: -0.025 },
  title: { size: 24, line: 30, weight: 700, tracking: -0.015 },
  wtitle: { size: 22, line: 28, weight: 700, tracking: -0.015 },
  h: { size: 20, line: 26, weight: 600, tracking: -0.01 },
  sub: { size: 16, line: 22, weight: 600, tracking: 0 },
  num: { size: 26, line: 30, weight: 700, tracking: -0.02 },
  body: { size: 15, line: 21, weight: 400, tracking: 0 },
  sm: { size: 14, line: 20, weight: 400, tracking: 0 },
  cap: { size: 13, line: 18, weight: 400, tracking: 0 },
  micro: { size: 11, line: 14, weight: 500, tracking: 0 },
  eyebrow: { size: 11.5, line: 16, weight: 500, tracking: 0.07 },
} as const;

/** Corner radii in px for the default ("md") org setting. */
export const radius = {
  xs: 6,
  sm: 8,
  md: 10,
  lg: 12,
  xl: 14,
  '2xl': 16,
  '3xl': 18,
  '4xl': 20,
  full: 999,
} as const;

/** Org radius setting multiplies every radius. */
export const radiusScale = { sm: 0.67, md: 1, lg: 1.25 } as const;

/** Motion durations in ms and easing curves (doc 16 §9). */
export const motion = {
  fast: 120,
  base: 180,
  panel: 240,
  page: 320,
  spring: 450,
  easeOut: 'cubic-bezier(.2,.8,.2,1)',
  easeIn: 'cubic-bezier(.4,0,1,1)',
  springCurve: 'cubic-bezier(.34,1.36,.5,1)',
} as const;

/** Shell measurements in px (doc 16 §8). */
export const layout = {
  rail: 64,
  side: 248,
  top: 56,
  panel: 340,
  railItem: 44,
  navRow: 32,
  navRowCompact: 28,
  mobileTabBar: 66,
  minTouch: 44,
} as const;

// ---- White-label derivation (doc 16 §4, doc 09 notes) ----

export interface ThemeModeInput {
  bg: string;
  surface: string;
  accent: string;
}

const DEFAULT_ACCENTS = ['#F9C31A', '#FBC419'];
const same = (a: string, b: string) => a.toUpperCase() === b.toUpperCase();
const withL = (o: Oklch, l: number, chroma?: number): string =>
  oklchToHex({ l: Math.min(1, Math.max(0, l)), c: chroma ?? o.c, h: o.h });

/**
 * Derive the full token set for one scheme from the three org colors.
 * The kit's own neutrals are kept when the org did not change the background,
 * so the default theme renders exactly like the design.
 */
export function deriveColors(scheme: ColorScheme, input: ThemeModeInput): ColorTokens {
  const base = colors[scheme];
  const dark = scheme === 'dark';
  const out: ColorTokens = { ...base, bg: input.bg, surface: input.surface, accent: input.accent };

  if (!same(input.bg, base.bg)) {
    const o = hexToOklch(input.bg);
    const c = o.c * 0.8;
    out.bg2 = withL(o, dark ? o.l + 0.06 : o.l - 0.025, c);
    const fgC = Math.min(o.c, 0.02);
    const [l1, l2, l3] = dark ? [0.96, 0.74, 0.54] : [0.16, 0.47, 0.68];
    out.fg = withL(o, l1, fgC);
    out.fg2 = withL(o, l2, fgC);
    out.fg3 = withL(o, l3, fgC);
    out.line = withAlpha(out.fg, 0.08);
    out.line2 = withAlpha(out.fg, dark ? 0.16 : 0.14);
    out.capsule = withAlpha(out.fg, dark ? 0.12 : 0.07);
  }

  if (!DEFAULT_ACCENTS.some((a) => same(a, input.accent))) {
    const a = hexToOklch(input.accent);
    const black = '#0B0B0B';
    const white = '#FFFFFF';
    out.accentFg =
      contrastRatio(input.accent, black) >= contrastRatio(input.accent, white) ? black : white;
    out.accentText = dark ? input.accent : withL(a, Math.min(a.l, 0.5));
    out.accent10 = withAlpha(input.accent, dark ? 0.14 : 0.18);
  } else {
    out.accent10 = withAlpha(input.accent, dark ? 0.14 : 0.18);
  }
  return out;
}

/** Suggested dark accent for a light accent ("auto"): color-mix(in oklch, accent 78%, white). */
export function autoDarkAccent(accent: string): string {
  return mixHex(accent, '#FFFFFF', 0.78);
}

/** Suggested surface for a background ("auto"). */
export function autoSurface(scheme: ColorScheme, bg: string): string {
  if (same(bg, colors[scheme].bg)) return colors[scheme].surface;
  const o = hexToOklch(bg);
  return withL(o, scheme === 'dark' ? o.l + 0.03 : Math.min(1, o.l + 0.025), o.c * 0.8);
}

export type ContrastLevel = 'AAA' | 'AA' | 'fail';

export interface ContrastCheck {
  pair: 'fgBg' | 'fg2Bg' | 'accentFgAccent' | 'accentTextBg';
  ratio: number;
  level: ContrastLevel;
}

const levelOf = (r: number): ContrastLevel => (r >= 7 ? 'AAA' : r >= 4.5 ? 'AA' : 'fail');

/** Text pairs measured before a theme can be published (min 4.5:1). */
export function checkContrast(t: ColorTokens): ContrastCheck[] {
  const pairs: [ContrastCheck['pair'], string, string][] = [
    ['fgBg', t.fg, t.bg],
    ['fg2Bg', t.fg2, t.bg],
    ['accentFgAccent', t.accentFg, t.accent],
    ['accentTextBg', t.accentText, t.bg],
  ];
  return pairs.map(([pair, a, b]) => {
    const ratio = Math.round(contrastRatio(a, b) * 10) / 10;
    return { pair, ratio, level: levelOf(ratio) };
  });
}

/** Darkens (or lightens) a color in oklch until it reaches 4.5:1 on `against`, keeping hue and chroma. */
export function autoFixContrast(color: string, against: string, target = 4.5): string {
  const o = hexToOklch(color);
  const goDarker = luminance(against) > 0.18;
  for (let i = 0; i <= 100; i++) {
    const l = goDarker ? o.l - i * 0.01 : o.l + i * 0.01;
    const candidate = withL(o, l);
    if (contrastRatio(candidate, against) >= target) return candidate;
  }
  return goDarker ? '#000000' : '#FFFFFF';
}

/** CSS custom property names for each token (kit names). */
export const cssVarName: Record<keyof ColorTokens, string> = {
  bg: '--bg',
  bg2: '--bg2',
  surface: '--surface',
  line: '--line',
  line2: '--line2',
  fg: '--fg',
  fg2: '--fg2',
  fg3: '--fg3',
  accent: '--accent',
  accentFg: '--accentFg',
  accentText: '--accentText',
  accent10: '--accent10',
  danger: '--danger',
  success: '--success',
  warning: '--warning',
  info: '--info',
  glass: '--glass',
  glassLine: '--glassLine',
  capsule: '--capsule',
  scrim: '--scrim',
  shadow: '--shadow',
  shadowSm: '--shSm',
  chDot: '--chDot',
};
