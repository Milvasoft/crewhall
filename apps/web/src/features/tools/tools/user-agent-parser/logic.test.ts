// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/user-agent-parser/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { parseUserAgent } from './logic';

const CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const FIREFOX_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:109.0) Gecko/20100101 Firefox/118.0';

const SAFARI_IOS =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const ANDROID_CHROME =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Mobile Safari/537.36';

const GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

function fieldsOf(ua: string) {
  const fields = parseUserAgent(ua);
  const get = (label: string) => fields.find((f) => f.label === label)?.value ?? '';
  return get;
}

describe('user-agent-parser', () => {
  it('extracts browser and OS', () => {
    const get = fieldsOf(CHROME);
    expect(get('Browser')).toContain('Chrome');
    expect(get('Operating system')).toContain('Windows');
    expect(get('Engine')).toContain('Blink');
  });

  it('extracts CPU architecture when present', () => {
    expect(fieldsOf(CHROME)('CPU architecture')).toBe('amd64');
  });

  it('always returns the full field set', () => {
    expect(parseUserAgent('').map((f) => f.label)).toEqual([
      'Browser',
      'Engine',
      'Operating system',
      'Device',
      'Device type',
      'CPU architecture',
    ]);
  });

  it('handles whitespace-only and garbage input like empty input', () => {
    for (const ua of ['   ', 'not-a-real-user-agent']) {
      const get = fieldsOf(ua);
      expect(get('Browser')).toBe('Unknown');
      expect(get('Device type')).toBe('desktop');
    }
  });

  it('parses a desktop Firefox / macOS user agent', () => {
    const get = fieldsOf(FIREFOX_MAC);
    expect(get('Browser')).toContain('Firefox');
    expect(get('Engine')).toContain('Gecko');
    expect(get('Operating system')).toContain('macOS');
    expect(get('Device type')).toBe('desktop');
  });

  it('parses a mobile Safari / iOS user agent', () => {
    const get = fieldsOf(SAFARI_IOS);
    expect(get('Browser')).toContain('Safari');
    expect(get('Operating system')).toContain('iOS');
    expect(get('Device')).toBe('Apple iPhone');
    expect(get('Device type')).toBe('mobile');
  });

  it('parses a mobile Chrome / Android user agent', () => {
    const get = fieldsOf(ANDROID_CHROME);
    expect(get('Browser')).toContain('Chrome');
    expect(get('Operating system')).toContain('Android');
    expect(get('Device')).toContain('Pixel 7');
    expect(get('Device type')).toBe('mobile');
  });

  it('falls back to defaults for a bot user agent with no browser/device signals', () => {
    const get = fieldsOf(GOOGLEBOT);
    expect(get('Browser')).toBe('Unknown');
    expect(get('Device')).toBe('Desktop / unknown');
    expect(get('Device type')).toBe('desktop');
  });
});
