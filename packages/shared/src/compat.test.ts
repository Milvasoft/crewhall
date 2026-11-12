import { describe, expect, it } from 'vitest';
import { capabilitiesFor, CAPABILITIES, compareSemver, parseClientHeader } from './compat';

describe('compat helpers', () => {
  it('reads the client header and ignores malformed ones', () => {
    expect(parseClientHeader('android/1.4.2')).toEqual({ platform: 'android', version: '1.4.2' });
    expect(parseClientHeader('iOS/2.0.0-beta.1')).toEqual({
      platform: 'ios',
      version: '2.0.0-beta.1',
    });
    for (const bad of [undefined, '', 'android', 'android/1.4', 'tv/1.0.0']) {
      expect(parseClientHeader(bad)).toBeNull();
    }
  });

  it('compares versions numerically', () => {
    expect(compareSemver('1.10.0', '1.9.9')).toBeGreaterThan(0);
    expect(compareSemver('0.2.0', '0.2.0-rc.1')).toBe(0);
    expect(compareSemver('0.1.9', '0.2.0')).toBeLessThan(0);
  });

  it('lists a module capability only while the module is on', () => {
    const none = capabilitiesFor([]);
    expect(none).toContain('ui.prefs');
    expect(none).not.toContain('mail.bulk');
    expect(capabilitiesFor(['mail'])).toContain('mail.bulk');
    expect(new Set(CAPABILITIES.map((c) => c.key)).size).toBe(CAPABILITIES.length);
  });
});
