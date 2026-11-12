import { afterEach, describe, expect, it } from 'vitest';
import { desktopHas } from '@/lib/desktop';

afterEach(() => {
  delete window.crewhallDesktop;
});

describe('desktopHas', () => {
  it('is false in a browser', () => {
    expect(desktopHas('openMeeting')).toBe(false);
  });

  it('reads the feature list, never the version', () => {
    window.crewhallDesktop = {
      isDesktop: true,
      platform: 'win32',
      version: '9.9.9',
      features: ['openMeeting', 'titleBar'],
      // A member without its feature name does not count.
      remoteControl: undefined,
    };
    expect(desktopHas('openMeeting')).toBe(true);
    expect(desktopHas('titleBar')).toBe(true);
    expect(desktopHas('remoteControl')).toBe(false);
    expect(desktopHas('webauthn')).toBe(false);
  });

  it('knows what older apps without a feature list could do', () => {
    window.crewhallDesktop = {
      isDesktop: true,
      platform: 'win32',
      openMeeting: async () => true,
      windowKind: async () => 'main',
    };
    expect(desktopHas('openMeeting')).toBe(true);
    expect(desktopHas('windowKind')).toBe(true);
    expect(desktopHas('remoteControl')).toBe(false);
    expect(desktopHas('titleBar')).toBe(false);
  });
});
