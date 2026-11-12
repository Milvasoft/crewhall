// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/lib/image/imageUtils.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { formatBytes, parseImageInput } from './imageUtils';

describe('formatBytes', () => {
  it('formats sizes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.00 MB');
  });
});

describe('parseImageInput', () => {
  it('parses a full data URI', () => {
    const r = parseImageInput('data:image/png;base64,AAAA');
    expect(r.mime).toBe('image/png');
    expect(r.base64).toBe('AAAA');
  });

  it('accepts bare base64 as PNG', () => {
    const r = parseImageInput('iVBORw0KGgo=');
    expect(r.mime).toBe('image/png');
    expect(r.dataUri).toBe('data:image/png;base64,iVBORw0KGgo=');
  });

  it('rejects non-image data URIs', () => {
    expect(() => parseImageInput('data:text/plain;base64,AAAA')).toThrow();
  });

  it('rejects garbage', () => {
    expect(() => parseImageInput('not base64 !!!')).toThrow();
  });
});
