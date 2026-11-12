import { describe, expect, it } from 'vitest';
import {
  allowPermissionCheck,
  allowPermissionRequest,
  macMediaAccess,
} from '../src/common/permissions';

const server = 'https://go.crewhall.app';

describe('allowPermissionCheck', () => {
  it('grants camera and microphone checks to the server, as Electron reports its origin', () => {
    // Electron passes the origin with a trailing slash; this was the empty device list.
    expect(allowPermissionCheck('media', 'https://go.crewhall.app/', server)).toBe(true);
    expect(allowPermissionCheck('media', 'https://go.crewhall.app', server)).toBe(true);
    expect(allowPermissionCheck('speaker-selection', 'https://go.crewhall.app/', server)).toBe(
      true,
    );
  });

  it('refuses other sites, unknown permissions and HTML notifications', () => {
    expect(allowPermissionCheck('media', 'https://go.crewhall.app.evil.io/', server)).toBe(false);
    expect(allowPermissionCheck('media', 'http://go.crewhall.app/', server)).toBe(false);
    expect(allowPermissionCheck('geolocation', 'https://go.crewhall.app/', server)).toBe(false);
    expect(allowPermissionCheck('notifications', 'https://go.crewhall.app/', server)).toBe(false);
    expect(allowPermissionCheck('media', undefined, server)).toBe(false);
    expect(allowPermissionCheck('media', 'file:///', server)).toBe(false);
  });
});

describe('allowPermissionRequest', () => {
  it('lets the meeting page (main or meeting window) use camera, microphone and screen', () => {
    const page = 'https://go.crewhall.app/toplantilar/oda/abc?x=1';
    expect(allowPermissionRequest('media', page, server)).toBe(true);
    expect(allowPermissionRequest('display-capture', page, server)).toBe(true);
    expect(allowPermissionRequest('media', 'https://idp.example/login', server)).toBe(false);
    expect(allowPermissionRequest('notifications', page, server)).toBe(false);
  });
});

describe('macMediaAccess', () => {
  it('asks macOS only for the device types requested', () => {
    expect(macMediaAccess(['video'])).toEqual(['camera']);
    expect(macMediaAccess(['audio'])).toEqual(['microphone']);
    expect(macMediaAccess(['audio', 'video'])).toEqual(['camera', 'microphone']);
    expect(macMediaAccess(undefined)).toEqual(['camera', 'microphone']);
  });
});

describe('plugin frames (eklentiler.md › Tarayıcı yetenekleri)', () => {
  const plugin = 'https://wa-bridge.example.com/app';
  const inServerPage = { topUrl: `${server}/apps/whatsapp`, isMainFrame: false };

  it('lets a plugin iframe in the server page use the microphone, location and clipboard writes', () => {
    for (const p of ['media', 'geolocation', 'clipboard-sanitized-write']) {
      expect(allowPermissionRequest(p, plugin, server, inServerPage), p).toBe(true);
      expect(
        allowPermissionCheck(p, 'https://wa-bridge.example.com/', server, {
          topUrl: `${server}/`,
          isMainFrame: false,
        }),
        p,
      ).toBe(true);
    }
  });

  it('refuses other permissions for plugin frames', () => {
    for (const p of ['display-capture', 'clipboard-read', 'notifications', 'midi', 'pointerLock']) {
      expect(allowPermissionRequest(p, plugin, server, inServerPage), p).toBe(false);
    }
  });

  it('refuses the same request from a top page of another site or a frame in one', () => {
    // The other site as the window's own page.
    expect(
      allowPermissionRequest('media', plugin, server, { topUrl: plugin, isMainFrame: true }),
    ).toBe(false);
    // A frame, but the window shows another site.
    expect(
      allowPermissionRequest('geolocation', plugin, server, {
        topUrl: 'https://evil.example/',
        isMainFrame: false,
      }),
    ).toBe(false);
    // A look-alike host is not the server.
    expect(
      allowPermissionRequest('media', plugin, server, {
        topUrl: 'https://go.crewhall.app.evil.io/',
        isMainFrame: false,
      }),
    ).toBe(false);
    // No frame information: the old rules only.
    expect(allowPermissionRequest('media', plugin, server)).toBe(false);
  });

  it('keeps the rules for the server page itself (no location there)', () => {
    expect(allowPermissionRequest('media', `${server}/meetings`, server)).toBe(true);
    expect(allowPermissionRequest('geolocation', `${server}/`, server)).toBe(false);
  });
});
