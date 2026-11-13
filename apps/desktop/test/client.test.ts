import { describe, expect, it } from 'vitest';
import {
  CLIENT_HEADER,
  DESKTOP_FEATURES,
  desktopFeatures,
  isOutdatedAnswer,
  withClientHeader,
} from '../src/common/client';

const origin = 'https://go.crewhall.app';

describe('bridge features', () => {
  it('lists what the bridge offers; the web asks for these, never for a version', () => {
    expect(DESKTOP_FEATURES).toEqual([
      'openMeeting',
      'meetingClosed',
      'windowKind',
      'remoteControl',
      'titleBar',
      'systemLock',
      'openFile',
      'openWindow',
      'notifySound',
    ]);
  });

  it('adds platform passkeys and the Hello vault unlock on Windows and signed mac builds', () => {
    expect(desktopFeatures('win32', '')).toEqual(
      expect.arrayContaining(['webauthn', 'vaultDevice']),
    );
    expect(desktopFeatures('darwin', '')).not.toContain('vaultDevice');
    expect(desktopFeatures('darwin', '')).not.toContain('webauthn');
    expect(desktopFeatures('darwin', 'ABCDE12345.com.crewhall.desktop.webauthn')).toContain(
      'webauthn',
    );
    expect(desktopFeatures('linux', '')).not.toContain('webauthn');
    expect(desktopFeatures('linux', '')).toEqual([...DESKTOP_FEATURES]);
  });
});

describe('client header', () => {
  const headers = { Accept: 'application/json' };

  it('names the app and its version on requests to the organization server', () => {
    expect(withClientHeader(`${origin}/api/v1/bootstrap`, origin, headers, '0.2.5')).toEqual({
      Accept: 'application/json',
      [CLIENT_HEADER]: 'desktop/0.2.5',
    });
    expect(withClientHeader(`${origin}/`, origin, {}, '0.2.5')[CLIENT_HEADER]).toBe(
      'desktop/0.2.5',
    );
  });

  it('tells nobody else: other sites, look-alike hosts, other ports or schemes', () => {
    for (const url of [
      'https://idp.example.com/authorize',
      'https://go.crewhall.app.evil.io/x',
      'https://go.crewhall.app:8443/x',
      'http://go.crewhall.app/x',
      'not a url',
    ]) {
      expect(withClientHeader(url, origin, headers, '0.2.5'), url).toBe(headers);
    }
    expect(withClientHeader(`${origin}/`, null, headers, '0.2.5')).toBe(headers);
  });
});

describe('426 from the server', () => {
  it('means this app is too old, only when the organization server says it', () => {
    expect(isOutdatedAnswer(`${origin}/api/v1/bootstrap`, origin, 426)).toBe(true);
    expect(isOutdatedAnswer(`${origin}/api/v1/bootstrap`, origin, 401)).toBe(false);
    expect(isOutdatedAnswer('https://idp.example.com/x', origin, 426)).toBe(false);
    expect(isOutdatedAnswer(`${origin}/`, null, 426)).toBe(false);
  });
});
