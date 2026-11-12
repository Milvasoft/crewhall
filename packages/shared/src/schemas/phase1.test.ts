import { describe, expect, it } from 'vitest';
import { endpoints } from '../endpoints';
import { CreateShare, isInlineSafe, NodeName } from './drive';
import { CreateCard } from './quick';

describe('phase 1 contract', () => {
  it('rejects names with slashes and trims them', () => {
    expect(NodeName.parse('  Sunumlar ')).toBe('Sunumlar');
    expect(NodeName.safeParse('a/b').success).toBe(false);
    expect(NodeName.safeParse('').success).toBe(false);
  });

  it('defaults link shares to viewer with downloads allowed', () => {
    expect(CreateShare.parse({ kind: 'link' })).toEqual({
      kind: 'link',
      role: 'viewer',
      allowDownload: true,
    });
    expect(CreateShare.safeParse({ kind: 'link', role: 'editor' }).success).toBe(false);
  });

  it('creates link cards from a URL with health checks on by default', () => {
    const card = CreateCard.parse({ type: 'link', link: { url: 'https://seq.example.com/' } });
    expect(card).toMatchObject({ type: 'link', link: { checkEnabled: true, intervalSeconds: 60 } });
    expect(CreateCard.safeParse({ type: 'link', link: { url: 'nope' } }).success).toBe(false);
  });

  it('serves only safe types inline', () => {
    for (const m of [
      'application/pdf',
      'image/png',
      'video/mp4',
      'audio/mpeg',
      'text/plain; charset=utf-8',
    ]) {
      expect(isInlineSafe(m), m).toBe(true);
    }
    for (const m of [
      'text/html',
      'image/svg+xml',
      'application/javascript',
      'application/zip',
      null,
    ]) {
      expect(isInlineSafe(m), String(m)).toBe(false);
    }
  });

  it('reads list queries from strings', () => {
    expect(endpoints.listNodes.query.parse({ limit: '10' })).toMatchObject({
      limit: 10,
      sort: 'name',
      order: 'asc',
    });
  });
});
