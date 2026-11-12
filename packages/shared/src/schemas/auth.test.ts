import { describe, expect, it } from 'vitest';
import {
  buildConnectUrl,
  httpOrigin,
  formatBackupCode,
  browserExtensionOf,
  isAllowedHandoffRedirect,
  isAllowedMobileRedirect,
  normalizeBackupCode,
  parseConnectUrl,
} from './auth';

describe('backup codes', () => {
  it('ignore case, spaces and dashes', () => {
    expect(normalizeBackupCode(' 4f7k-92qd ')).toBe('4F7K92QD');
    expect(formatBackupCode('4f7k92qd')).toBe('4F7K-92QD');
  });
});

describe('connect QR', () => {
  it('round-trips server and token', () => {
    const url = buildConnectUrl('https://hub.example.com/login', 'abc_123');
    expect(url).toBe('crewhall://connect?server=https%3A%2F%2Fhub.example.com&token=abc_123');
    expect(parseConnectUrl(url)).toEqual({ server: 'https://hub.example.com', token: 'abc_123' });
  });

  it('accepts a bare server address and rejects other payloads', () => {
    expect(parseConnectUrl('https://hub.example.com/')).toEqual({
      server: 'https://hub.example.com',
      token: null,
    });
    expect(parseConnectUrl('WIFI:S:x;;')).toBeNull();
    expect(parseConnectUrl('crewhall://connect?server=javascript:alert(1)')).toBeNull();
  });
});

describe('mobile redirect', () => {
  it('allows only the app schemes', () => {
    expect(isAllowedMobileRedirect('crewhall://auth')).toBe(true);
    expect(isAllowedMobileRedirect('exp://192.168.1.5:8081/--/auth')).toBe(true);
    expect(isAllowedMobileRedirect('https://evil.example/cb')).toBe(false);
    expect(isAllowedMobileRedirect('not a url')).toBe(false);
  });

  it('keeps Expo Go out of production, however it is written', () => {
    const production = { production: true };
    expect(isAllowedMobileRedirect('crewhall://auth', production)).toBe(true);
    expect(isAllowedMobileRedirect('exp://evil.host/--/x', production)).toBe(false);
    expect(isAllowedMobileRedirect('EXP://evil.host/--/x', production)).toBe(false);
    expect(isAllowedMobileRedirect('  exp://evil.host/--/x', production)).toBe(false);
    expect(isAllowedMobileRedirect('exp://192.168.1.5:8081/--/auth', { production: false })).toBe(
      true,
    );
  });
});

describe('browser extension handoff', () => {
  const own = 'https://giohfeehjcadcpdlojgobdhhklkmnkci.chromiumapp.org/auth';

  it('accepts only the listed extension', () => {
    const prod = { production: true };
    expect(browserExtensionOf(own)).toBe('giohfeehjcadcpdlojgobdhhklkmnkci');
    expect(isAllowedHandoffRedirect(own, prod)).toBe(true);
    expect(isAllowedHandoffRedirect('https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.chromiumapp.org/auth', prod)).toBe(false);
    expect(isAllowedHandoffRedirect('https://evil.example/giohfeehjcadcpdlojgobdhhklkmnkci.chromiumapp.org/', prod)).toBe(false);
    expect(isAllowedHandoffRedirect('http://giohfeehjcadcpdlojgobdhhklkmnkci.chromiumapp.org/auth', prod)).toBe(false);
    expect(isAllowedHandoffRedirect('crewhall://auth', prod)).toBe(true);
    expect(isAllowedHandoffRedirect('exp://evil.host/--/x', prod)).toBe(false);
    expect(isAllowedHandoffRedirect('exp://192.168.1.5:8081/--/auth', { production: false })).toBe(true);
    expect(browserExtensionOf('https://bcnejndkjdeadlbmjmmgpdnpfdmngnaj.chromiumapp.org/auth')).toBe(
      'bcnejndkjdeadlbmjmmgpdnpfdmngnaj',
    );
  });

  it('stays out of the other handoffs', () => {
    expect(isAllowedMobileRedirect(own)).toBe(false);
  });
});

describe('httpOrigin', () => {
  it('keeps scheme, host and port only', () => {
    expect(httpOrigin('HTTPS://Hub.Example.com:8443/login?x=1')).toBe(
      'https://hub.example.com:8443',
    );
    expect(httpOrigin('https://user@evil.example')).toBeNull();
    expect(httpOrigin('ftp://x')).toBeNull();
  });
});
