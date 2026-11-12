import { describe, expect, it } from 'vitest';
import { MAX_SKEW_MS, sign, verifyRevalidate } from '@/lib/signature';
import { safeRedirectPath } from '@/lib/redirect-path';

const SECRET = 'test-secret';
const NOW = 1_800_000_000_000;
const body = (ts: number) =>
  JSON.stringify({
    site: 'milva',
    publish: 129,
    paths: ['/docs/1.0.1/welcome'],
    tags: ['portal:site'],
    ts,
  });

describe('verifyRevalidate', () => {
  it('accepts a correctly signed, fresh call', () => {
    const raw = body(NOW - 1000);
    const r = verifyRevalidate(SECRET, raw, sign(SECRET, raw), NOW);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payload).toMatchObject({ publish: 129, tags: ['portal:site'] });
  });

  it('rejects a bad or missing signature', () => {
    const raw = body(NOW);
    expect(verifyRevalidate(SECRET, raw, sign('other-secret', raw), NOW)).toMatchObject({
      ok: false,
      status: 401,
    });
    expect(verifyRevalidate(SECRET, raw, 'sha256=abc', NOW)).toMatchObject({
      ok: false,
      status: 401,
    });
    expect(verifyRevalidate(SECRET, raw, null, NOW)).toMatchObject({ ok: false, status: 401 });
  });

  it('rejects a tampered body', () => {
    const raw = body(NOW);
    const sig = sign(SECRET, raw);
    expect(verifyRevalidate(SECRET, raw.replace('welcome', 'other'), sig, NOW)).toMatchObject({
      ok: false,
      status: 401,
    });
  });

  it('rejects stale and future timestamps', () => {
    for (const ts of [NOW - MAX_SKEW_MS - 1, NOW + MAX_SKEW_MS + 1]) {
      const raw = body(ts);
      expect(verifyRevalidate(SECRET, raw, sign(SECRET, raw), NOW)).toMatchObject({
        ok: false,
        status: 401,
        reason: 'stale timestamp',
      });
    }
  });

  it('rejects an invalid payload with a valid signature', () => {
    const raw = JSON.stringify({ paths: 'x' });
    expect(verifyRevalidate(SECRET, raw, sign(SECRET, raw), NOW)).toMatchObject({
      ok: false,
      status: 400,
    });
  });
});

describe('safeRedirectPath', () => {
  it('only allows site-relative paths', () => {
    expect(safeRedirectPath('/docs/next/x')).toBe('/docs/next/x');
    expect(safeRedirectPath('//evil.com')).toBe('/');
    expect(safeRedirectPath('https://evil.com')).toBe('/');
    expect(safeRedirectPath(`/${String.fromCharCode(92)}evil.com`)).toBe('/');
    expect(safeRedirectPath(null)).toBe('/');
  });
});
