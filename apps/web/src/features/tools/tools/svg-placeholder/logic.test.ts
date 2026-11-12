// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/svg-placeholder/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { generateSvg, svgToDataUri } from './logic';

describe('svg-placeholder', () => {
  it('builds an SVG with the given size and colors', () => {
    const svg = generateSvg({ width: 300, height: 150, bg: '#333', fg: '#fff' });
    expect(svg).toContain('width="300"');
    expect(svg).toContain('height="150"');
    expect(svg).toContain('fill="#333"');
    expect(svg).toContain('300×150');
  });

  it('uses custom text and escapes it', () => {
    const svg = generateSvg({
      width: 100,
      height: 100,
      bg: '#000',
      fg: '#fff',
      text: '<a>',
    });
    expect(svg).toContain('&lt;a&gt;');
  });

  it('produces a usable data URI', () => {
    const uri = svgToDataUri(generateSvg({ width: 10, height: 10, bg: '#000', fg: '#fff' }));
    expect(uri.startsWith('data:image/svg+xml')).toBe(true);
  });

  it('round-trips the SVG through the data URI encoding', () => {
    const svg = generateSvg({ width: 42, height: 24, bg: '#123456', fg: '#abcdef' });
    const uri = svgToDataUri(svg);
    const decoded = decodeURIComponent(uri.replace('data:image/svg+xml;charset=utf-8,', ''));
    expect(decoded).toBe(svg);
  });

  it('derives a default font size from the smaller dimension', () => {
    const wide = generateSvg({ width: 300, height: 50, bg: '#000', fg: '#fff' });
    expect(wide).toContain('font-size="10"'); // min(300,50)/5 = 10, floor of the 10 minimum
    const square = generateSvg({ width: 100, height: 100, bg: '#000', fg: '#fff' });
    expect(square).toContain('font-size="20"'); // min(100,100)/5 = 20
  });

  it('honors an explicit font size override', () => {
    const svg = generateSvg({
      width: 100,
      height: 100,
      bg: '#000',
      fg: '#fff',
      fontSize: 42,
    });
    expect(svg).toContain('font-size="42"');
  });

  it('keeps an explicit empty string as the text (not the default label)', () => {
    const svg = generateSvg({ width: 10, height: 10, bg: '#000', fg: '#fff', text: '' });
    expect(svg).not.toContain('10×10');
    expect(svg).toContain('></text>'); // text node is empty, not the default label
  });

  it('passes unicode text through untouched', () => {
    const svg = generateSvg({
      width: 20,
      height: 20,
      bg: '#000',
      fg: '#fff',
      text: '日本語 🎉',
    });
    expect(svg).toContain('日本語 🎉');
  });

  it('escapes special characters in the fill colors too', () => {
    const svg = generateSvg({ width: 10, height: 10, bg: '<bg>', fg: '&fg' });
    expect(svg).toContain('fill="&lt;bg&gt;"');
    expect(svg).toContain('fill="&amp;fg"');
  });
});
