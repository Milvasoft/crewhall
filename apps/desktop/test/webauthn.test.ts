import { describe, expect, it } from 'vitest';
import { macWebAuthnOptions } from '../src/common/webauthn';

describe('macWebAuthnOptions', () => {
  it('switches Touch ID on only for a signed mac build that names its keychain group', () => {
    expect(macWebAuthnOptions('darwin', 'ABCDE12345.com.crewhall.desktop.webauthn')).toEqual({
      touchID: { keychainAccessGroup: 'ABCDE12345.com.crewhall.desktop.webauthn' },
    });
    expect(macWebAuthnOptions('darwin', '')).toBeNull();
    expect(macWebAuthnOptions('darwin', 'com.crewhall.desktop')).toBeNull();
    // Windows needs nothing: Chromium uses Windows Hello and security keys directly.
    expect(macWebAuthnOptions('win32', 'ABCDE12345.com.crewhall.desktop.webauthn')).toBeNull();
  });
});
