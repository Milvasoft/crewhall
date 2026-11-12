// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/http-mime/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import {
  HTTP_STATUSES,
  MIME_TYPES,
  filterMimes,
  filterStatuses,
  lookupMime,
  lookupStatus,
} from './logic';

describe('http-mime', () => {
  it('looks up a status code', () => {
    expect(lookupStatus(404)?.message).toBe('Not Found');
    expect(lookupStatus(200)?.category).toContain('2xx');
  });

  it('looks up a MIME type by extension', () => {
    expect(lookupMime('json')?.type).toBe('application/json');
    expect(lookupMime('.png')?.type).toBe('image/png');
  });

  it('filters statuses by text or code', () => {
    expect(filterStatuses('teapot').some((s) => s.code === 418)).toBe(true);
    expect(filterStatuses('50').every((s) => String(s.code).includes('50'))).toBe(true);
  });

  it('filters mime types', () => {
    expect(filterMimes('image').every((m) => m.type.includes('image'))).toBe(true);
  });

  it('returns undefined for an unknown status or extension', () => {
    expect(lookupStatus(999)).toBeUndefined();
    expect(lookupMime('notareal-ext')).toBeUndefined();
  });

  it('looks up MIME types case-insensitively', () => {
    expect(lookupMime('JSON')?.type).toBe('application/json');
    expect(lookupMime('.YML')?.type).toBe('application/yaml');
  });

  it('returns the full lists for an empty query', () => {
    expect(filterStatuses('')).toHaveLength(HTTP_STATUSES.length);
    expect(filterMimes('')).toHaveLength(MIME_TYPES.length);
  });

  it('returns an empty array when nothing matches', () => {
    expect(filterStatuses('no-such-status')).toEqual([]);
    expect(filterMimes('no-such-mime')).toEqual([]);
  });

  it('matches extension query as a substring, not just an exact extension', () => {
    // "js" is a substring of "json" and "mjs" too, not just the "js" extension.
    const exts = filterMimes('js').map((m) => m.ext);
    expect(exts).toContain('js');
    expect(exts).toContain('json');
    expect(exts).toContain('mjs');
  });
});
