// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/ascii-text-drawer/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { FONTS, renderAscii } from './logic';

describe('ascii-text-drawer', () => {
  it('renders multi-line ASCII art', () => {
    const art = renderAscii('Hi', 'Standard', 80);
    expect(art.split('\n').length).toBeGreaterThan(1);
    expect(art.trim().length).toBeGreaterThan(0);
  });

  it('supports every bundled font', () => {
    for (const font of FONTS) {
      expect(renderAscii('A', font, 80).length).toBeGreaterThan(0);
    }
  });

  it('rejects an unknown font', () => {
    expect(() => renderAscii('A', 'Nope', 80)).toThrow();
  });

  it('defaults to the Standard font and width 80 when omitted', () => {
    expect(renderAscii('Hi')).toBe(renderAscii('Hi', 'Standard', 80));
  });

  it('handles empty string input without throwing', () => {
    const art = renderAscii('', 'Standard', 80);
    expect(typeof art).toBe('string');
    expect(art.split('\n').every((line) => line.trim() === '')).toBe(true);
  });

  it("does not throw on unicode input outside the font's glyph set", () => {
    expect(() => renderAscii('héllo λ', 'Standard', 80)).not.toThrow();
    expect(typeof renderAscii('héllo λ', 'Standard', 80)).toBe('string');
  });

  it('wraps long text into more lines at a narrower width', () => {
    const text = 'Hello World Hello World';
    const narrow = renderAscii(text, 'Standard', 10);
    const wide = renderAscii(text, 'Standard', 200);
    expect(narrow.split('\n').length).toBeGreaterThan(wide.split('\n').length);
  });

  it('exposes exactly the ten bundled fonts', () => {
    expect(FONTS).toEqual([
      'Standard',
      'Big',
      'Small',
      'Slant',
      'Banner',
      'Shadow',
      'Mini',
      'Doom',
      'Ghost',
      'Block',
    ]);
  });
});
