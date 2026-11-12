// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/url-encode/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { decodeUrl, encodeUrl } from './logic';

describe('url-encode', () => {
  it('component-encodes reserved characters', () => {
    expect(encodeUrl('a b&c=d', 'component')).toBe('a%20b%26c%3Dd');
  });

  it('full-encoding preserves URL structure', () => {
    expect(encodeUrl('https://x.com/a b?q=1', 'full')).toBe('https://x.com/a%20b?q=1');
  });

  it('round-trips component encoding for Unicode', () => {
    const s = 'héllo/世界?x=1';
    expect(decodeUrl(encodeUrl(s, 'component'), 'component')).toBe(s);
  });

  it('round-trips full encoding for a URL with Unicode segments', () => {
    const s = 'https://x.com/héllo/世界?q=a b';
    expect(decodeUrl(encodeUrl(s, 'full'), 'full')).toBe(s);
  });

  it('handles empty input for both scopes', () => {
    expect(encodeUrl('', 'component')).toBe('');
    expect(encodeUrl('', 'full')).toBe('');
    expect(decodeUrl('', 'component')).toBe('');
    expect(decodeUrl('', 'full')).toBe('');
  });

  it('percent-encodes a multi-byte emoji as its individual UTF-8 bytes', () => {
    expect(encodeUrl('😀', 'component')).toBe('%F0%9F%98%80');
  });

  it('component-encoding escapes URL-structural characters that full-encoding preserves', () => {
    for (const ch of ['/', '?', '#', '&', '=', '+']) {
      expect(encodeUrl(ch, 'full')).toBe(ch);
      expect(encodeUrl(ch, 'component')).not.toBe(ch);
    }
  });

  it('throws on malformed percent-encoded input for both scopes', () => {
    expect(() => decodeUrl('%', 'component')).toThrow();
    expect(() => decodeUrl('%E0%A4%A', 'component')).toThrow();
    expect(() => decodeUrl('%zz', 'full')).toThrow();
  });
});
