import { describe, expect, it } from 'vitest';
import {
  autoFixContrast,
  checkContrast,
  colors,
  contrastRatio,
  deriveColors,
  hexToOklch,
  oklchToHex,
} from './tokens';
import { buildThemeCss } from './theme';

describe('color math', () => {
  it('round-trips hex through oklch', () => {
    for (const hex of ['#F9C31A', '#0B1220', '#141516', '#84CC16']) {
      expect(oklchToHex(hexToOklch(hex))).toBe(hex);
    }
  });

  it('computes WCAG contrast', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 0);
    expect(contrastRatio(colors.light.fg, colors.light.bg)).toBeGreaterThan(17);
  });
});

describe('deriveColors', () => {
  it('keeps the kit values for the default theme', () => {
    const t = deriveColors('light', { bg: '#F7F7F6', surface: '#FFFFFF', accent: '#FBC419' });
    expect(t.bg2).toBe(colors.light.bg2);
    expect(t.fg).toBe(colors.light.fg);
    expect(t.accentText).toBe(colors.light.accentText);
  });

  it('derives neutrals from a custom dark background and keeps them readable', () => {
    const t = deriveColors('dark', { bg: '#0B1220', surface: '#111A2B', accent: '#2563EB' });
    expect(t.bg2).not.toBe(colors.dark.bg2);
    expect(contrastRatio(t.fg, t.bg)).toBeGreaterThan(7);
    const checks = checkContrast(t);
    expect(checks.find((c) => c.pair === 'fgBg')?.level).toBe('AAA');
  });

  it('picks dark text on a light accent and white on a saturated blue', () => {
    expect(deriveColors('light', { ...colors.light, accent: '#84CC16' }).accentFg).toBe('#0B0B0B');
    expect(deriveColors('light', { ...colors.light, accent: '#1D4ED8' }).accentFg).toBe('#FFFFFF');
  });

  it('auto-fixes a failing text color to at least 4.5:1', () => {
    const fixed = autoFixContrast('#977508', '#F6F4EF');
    expect(contrastRatio(fixed, '#F6F4EF')).toBeGreaterThanOrEqual(4.5);
  });
});

describe('buildThemeCss', () => {
  it('emits both schemes and the radius scale', () => {
    const css = buildThemeCss({
      light: { bg: '#F7F7F6', surface: '#FFFFFF', accent: '#2563EB' },
      dark: { bg: '#0E0F0F', surface: '#151617', accent: '#60A5FA' },
      radius: 'lg',
      density: 'compact',
    });
    expect(css).toContain('html:root{--bg:#F7F7F6;');
    expect(css).toContain('--accent:#2563EB;');
    expect(css).toContain('html[data-theme="dark"],html [data-theme="dark"]{');
    expect(css).toContain('--radius-scale:1.25');
  });
});
