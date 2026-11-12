// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/wifi-qr/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { escapeWifi, wifiPayload } from './logic';

describe('wifi-qr', () => {
  it('builds a WPA payload', () => {
    expect(
      wifiPayload({
        ssid: 'MyWiFi',
        password: 'secret',
        encryption: 'WPA',
        hidden: false,
      }),
    ).toBe('WIFI:T:WPA;S:MyWiFi;P:secret;;');
  });

  it('omits the password for open networks', () => {
    expect(wifiPayload({ ssid: 'Cafe', password: '', encryption: 'nopass', hidden: false })).toBe(
      'WIFI:T:nopass;S:Cafe;;',
    );
  });

  it('marks hidden networks', () => {
    const p = wifiPayload({ ssid: 'H', password: 'p', encryption: 'WPA', hidden: true });
    expect(p).toContain('H:true');
  });

  it('escapes special characters', () => {
    expect(escapeWifi('a;b,c:d"e\\f')).toBe('a\\;b\\,c\\:d\\"e\\\\f');
  });

  it('leaves an empty string unescaped', () => {
    expect(escapeWifi('')).toBe('');
  });

  it('passes through unicode/emoji without escaping', () => {
    expect(escapeWifi('Café 😀')).toBe('Café 😀');
  });

  it('escapes special characters embedded in the SSID and password within the full payload', () => {
    const p = wifiPayload({
      ssid: 'My;Network,"Home"',
      password: 'p:a\\ss;word',
      encryption: 'WPA',
      hidden: false,
    });
    expect(p).toBe('WIFI:T:WPA;S:My\\;Network\\,\\"Home\\";P:p\\:a\\\\ss\\;word;;');
  });

  it('supports WEP encryption', () => {
    const p = wifiPayload({
      ssid: 'Net',
      password: 'abcde',
      encryption: 'WEP',
      hidden: false,
    });
    expect(p).toBe('WIFI:T:WEP;S:Net;P:abcde;;');
  });

  it('combines nopass with a hidden network (still omits the password)', () => {
    const p = wifiPayload({
      ssid: 'Hidden',
      password: '',
      encryption: 'nopass',
      hidden: true,
    });
    expect(p).toBe('WIFI:T:nopass;S:Hidden;H:true;;');
  });

  it('handles an empty SSID', () => {
    const p = wifiPayload({ ssid: '', password: 'pw', encryption: 'WPA', hidden: false });
    expect(p).toBe('WIFI:T:WPA;S:;P:pw;;');
  });
});
