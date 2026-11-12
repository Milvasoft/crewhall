// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/color-converter/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { convertColor, hslToRgb, parseColor, rgbToHex, rgbToHsl } from './logic';

describe('color-converter', () => {
  it('parses hex shorthand and full', () => {
    expect(parseColor('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor('#1f6feb')).toEqual({ r: 31, g: 111, b: 235, a: 1 });
  });

  it('converts red to every form', () => {
    const c = convertColor('#ff0000');
    expect(c.rgb).toBe('rgb(255, 0, 0)');
    expect(c.hsl).toBe('hsl(0, 100%, 50%)');
  });

  it('round-trips rgb → hsl → rgb-ish', () => {
    const hsl = rgbToHsl({ r: 31, g: 111, b: 235, a: 1 });
    expect(hsl.h).toBeGreaterThan(210);
    expect(hsl.h).toBeLessThan(220);
  });

  it('handles alpha', () => {
    const c = convertColor('rgba(0, 0, 0, 0.5)');
    expect(c.hex).toBe('#00000080');
    expect(c.rgb).toBe('rgba(0, 0, 0, 0.5)');
  });

  it('parses hsl input', () => {
    const c = convertColor('hsl(120, 100%, 50%)');
    expect(c.hex).toBe('#00ff00');
  });

  it('rejects garbage', () => {
    expect(() => parseColor('not a color')).toThrow();
  });

  it('rejects empty and whitespace-only input', () => {
    expect(() => parseColor('')).toThrow(/enter a color/i);
    expect(() => parseColor('   ')).toThrow(/enter a color/i);
  });

  it('is case-insensitive for hex input', () => {
    expect(parseColor('#FFFFFF')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
  });

  it('parses 4-digit hex shorthand with alpha', () => {
    // #f00a -> ff0000aa: opaque red at alpha 170/255
    expect(parseColor('#f00a')).toEqual({ r: 255, g: 0, b: 0, a: 0.67 });
  });

  it('parses 8-digit hex with alpha', () => {
    expect(parseColor('#ff0000aa')).toEqual({ r: 255, g: 0, b: 0, a: 0.67 });
  });

  it('parses rgb() with percentage channels', () => {
    expect(parseColor('rgb(100%, 0%, 0%)')).toEqual({ r: 255, g: 0, b: 0, a: 1 });
  });

  it('parses rgb() with slash-separated percentage alpha', () => {
    expect(parseColor('rgb(0 0 0 / 50%)')).toEqual({ r: 0, g: 0, b: 0, a: 0.5 });
  });

  it('parses hsl() with percentage alpha', () => {
    expect(parseColor('hsl(120, 100%, 50%, 50%)')).toEqual({
      r: 0,
      g: 255,
      b: 0,
      a: 0.5,
    });
  });

  it('clamps out-of-range rgb channels', () => {
    expect(parseColor('rgb(300, -10, 999)')).toEqual({ r: 255, g: 0, b: 255, a: 1 });
  });

  it('wraps hue at boundaries (0 and 360 are the same color)', () => {
    expect(hslToRgb(0, 1, 0.5)).toEqual(hslToRgb(360, 1, 0.5));
  });

  it('forces an alpha channel in hex output even at full opacity when requested', () => {
    expect(rgbToHex({ r: 255, g: 0, b: 0, a: 1 }, true)).toBe('#ff0000ff');
    expect(rgbToHex({ r: 255, g: 0, b: 0, a: 1 })).toBe('#ff0000');
  });

  it('renders fully transparent black with a 00 alpha suffix', () => {
    expect(convertColor('rgba(0,0,0,0)').hex).toBe('#00000000');
  });

  it('round-trips hex through parseColor and rgbToHex', () => {
    expect(rgbToHex(parseColor('#1f6feb'))).toBe('#1f6feb');
  });
});
