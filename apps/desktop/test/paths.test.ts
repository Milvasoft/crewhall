import { LEGACY_PATH_RULES, toCurrentPath } from '@crewhall/shared';
import { describe, expect, it } from 'vitest';
import { notificationPath } from '../src/common/notify';
import { parseDeepLink } from '../src/common/deeplink';
import {
  isAuthPath,
  isMeetingPath,
  pathForServer,
  servesEnglishPaths,
  toLegacyPath,
} from '../src/common/paths';

describe('server capability', () => {
  it('is English only when the server says paths.english', () => {
    expect(servesEnglishPaths(['ui.prefs', 'paths.english'])).toBe(true);
    expect(servesEnglishPaths(['ui.prefs'])).toBe(false);
    expect(servesEnglishPaths(undefined)).toBe(false);
    expect(servesEnglishPaths(null)).toBe(false);
  });
});

describe('pathForServer', () => {
  it('opens old links on a new server in English', () => {
    expect(pathForServer('/toplantilar/oda/abc?pencere=1', true)).toBe(
      '/meetings/room/abc?window=1',
    );
    expect(pathForServer('/chat/c/c1/dosyalar', true)).toBe('/chat/c/c1/files');
    expect(pathForServer('/takvim?etkinlik=e1&gorunum=hafta', true)).toBe(
      '/calendar?event=e1&view=week',
    );
    expect(pathForServer('/meetings/room/abc', true)).toBe('/meetings/room/abc');
  });

  it('opens new links on an old server in Turkish', () => {
    expect(pathForServer('/meetings/room/abc?window=1', false)).toBe(
      '/toplantilar/oda/abc?pencere=1',
    );
    expect(pathForServer('/notifications', false)).toBe('/bildirimler');
    expect(pathForServer('/account/security', false)).toBe('/hesap/guvenlik');
    expect(pathForServer('/drive/s1/folder/f1#x', false)).toBe('/drive/s1/k/f1#x');
    expect(pathForServer('/calendar?event=e1&view=week', false)).toBe(
      '/takvim?etkinlik=e1&gorunum=hafta',
    );
    expect(pathForServer('/toplantilar/oda/abc', false)).toBe('/toplantilar/oda/abc');
  });

  it('leaves paths that never changed alone', () => {
    for (const p of ['/', '/chat', '/chat/c/c1', '/m/xyz', '/b/b1', '/d/d1', '/api/v1/files/x']) {
      expect(pathForServer(p, true), p).toBe(p);
      expect(pathForServer(p, false), p).toBe(p);
    }
  });

  it('turns every current path of the table back into an old one the server knows', () => {
    for (const [from, to] of LEGACY_PATH_RULES) {
      const sample = (p: string) => p.replace(/:[a-z]+/g, 'x1');
      const back = toLegacyPath(sample(to));
      // Back to an old form that leads to the same current path.
      expect(toCurrentPath(back), `${from} → ${to}`).toBe(sample(to));
    }
  });
});

describe('recognising pages in either form', () => {
  it('meeting pages', () => {
    for (const p of ['/meetings/room/a', '/toplantilar/oda/a', '/m/a', '/meetings/room/a/lobby'])
      expect(isMeetingPath(p), p).toBe(true);
    for (const p of ['/meetings', '/toplantilar', '/meetings/summary/s', '/chat'])
      expect(isMeetingPath(p), p).toBe(false);
  });

  it('sign-in pages', () => {
    for (const p of [
      '/login',
      '/login/2fa/backup',
      '/login/2fa/yedek',
      '/reset-password',
      '/sifre-yenile',
      '/sso/consent',
      '/api/auth/callback/x',
    ])
      expect(isAuthPath(p), p).toBe(true);
    expect(isAuthPath('/loginx')).toBe(false);
    expect(isAuthPath('/account/security')).toBe(false);
  });

  it('notification urls and crewhall:// links keep their old paths for the server to adapt', () => {
    const origin = 'https://go.crewhall.app';
    expect(notificationPath(`${origin}/toplantilar/oda/abc`, origin)).toBe('/toplantilar/oda/abc');
    expect(parseDeepLink('crewhall://open/hesap/guvenlik')).toEqual({
      kind: 'open',
      path: '/hesap/guvenlik',
    });
    expect(pathForServer('/hesap/guvenlik', true)).toBe('/account/security');
  });
});
