import { describe, expect, it } from 'vitest';
import { buildWebManifest } from '../src/services/web-manifest';

const DEFAULT_BRANDING = {
  orgName: 'Crewhall',
  appName: 'Crewhall',
  markUrl: null,
  defaultLocale: 'tr',
} as const;

describe('web app manifest', () => {
  it('uses the build icons and the product name without an org brand', () => {
    const m = buildWebManifest({ ...DEFAULT_BRANDING, orgName: DEFAULT_BRANDING.appName });
    expect(m.name).toBe(DEFAULT_BRANDING.appName);
    expect(m.display).toBe('standalone');
    expect(m.start_url).toBe('/');
    expect(m.icons.map((i) => i.src)).toContain('/icons/maskable-512.png');
  });

  it('carries the org name, mark and theme so a white-label install shows no other brand', () => {
    const m = buildWebManifest(
      {
        ...DEFAULT_BRANDING,
        orgName: 'Acme',
        markUrl: 'https://hub.example.com/api/assets/mark',
      },
      { light: { bg: '#102030', surface: '#FFFFFF', accent: '#FBC419' } },
    );
    expect(m.name).toBe(`Acme · ${DEFAULT_BRANDING.appName}`);
    expect(m.short_name).toBe('Acme');
    expect(m.theme_color).toBe('#102030');
    expect(m.icons.map((i) => i.src)).toEqual([
      'https://hub.example.com/api/assets/mark',
      'https://hub.example.com/api/assets/mark',
    ]);
  });

  it('falls back to the product name when the org name would be cut on a home screen', () => {
    const m = buildWebManifest({ ...DEFAULT_BRANDING, orgName: 'A very long company name' });
    expect(m.short_name).toBe(DEFAULT_BRANDING.appName);
  });
});
