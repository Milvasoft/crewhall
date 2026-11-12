import { describe, expect, it } from 'vitest';
import { signPreview, verifyPreview } from '../src/services/portal/preview';
import { signPayload } from '../src/services/portal/revalidate';
import {
  compareVersions,
  docPath,
  homePath,
  postPath,
  slugSegment,
  tagSlug,
} from '../src/services/portal/urls';

describe('portal URLs (Docusaurus compatible)', () => {
  it('prefixes only non-default locales', () => {
    expect(homePath('en', 'en')).toBe('/');
    expect(homePath('tr', 'en')).toBe('/tr');
    expect(docPath('en', 'en', '1.0.1', 'open-source-libs/milvaion/quick-start')).toBe(
      '/docs/1.0.1/open-source-libs/milvaion/quick-start',
    );
    expect(docPath('tr', 'en', '1.0.1', 'category/milvaion-scheduler')).toBe(
      '/tr/docs/1.0.1/category/milvaion-scheduler',
    );
    expect(postPath('tr', 'en', 'apache-ignite')).toBe('/tr/blog/apache-ignite');
  });

  it('builds slugs and tag paths', () => {
    expect(slugSegment('Hızlı Başlangıç & Kurulum')).toBe('hizli-baslangic-kurulum');
    expect(slugSegment('İçerik Çevirisi')).toBe('icerik-cevirisi');
    expect(slugSegment('***')).toBe('page');
    expect(tagSlug('Job Scheduler')).toBe('job-scheduler');
  });

  it('orders versions numerically with next first', () => {
    const sorted = ['1.0.0', 'next', '1.10.0', '1.9.2', '1.0.1'].sort((a, b) =>
      compareVersions(b, a),
    );
    expect(sorted).toEqual(['next', '1.10.0', '1.9.2', '1.0.1', '1.0.0']);
  });
});

describe('portal signatures', () => {
  it('signs the revalidate body with HMAC-SHA256', () => {
    expect(signPayload('secret', '{"a":1}')).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(signPayload('secret', '{"a":1}')).not.toBe(signPayload('other', '{"a":1}'));
  });

  it('accepts its own preview token until it expires', () => {
    const env = { AUTH_SECRET: 'x'.repeat(40) };
    const ok = signPreview(env, { s: 'site-1', u: 'user', e: Date.now() + 60_000 });
    expect(verifyPreview(env, ok)).toBe('site-1');
    expect(verifyPreview({ AUTH_SECRET: 'y'.repeat(40) }, ok)).toBeNull();
    expect(
      verifyPreview(env, signPreview(env, { s: 'site-1', u: 'user', e: Date.now() - 1 })),
    ).toBeNull();
    expect(verifyPreview(env, 'garbage')).toBeNull();
  });
});
