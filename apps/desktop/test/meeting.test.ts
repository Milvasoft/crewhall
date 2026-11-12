import { describe, expect, it } from 'vitest';
import {
  MEETING_WEB_PREFERENCES,
  closedItself,
  fitBounds,
  leftMeeting,
  mayThrottle,
  mediaLogLine,
  meetingKey,
} from '../src/common/meeting';

const origin = 'https://calisma.kurum.com';

describe('meetingKey', () => {
  it('is the meeting path on this server, in its current form', () => {
    expect(meetingKey('https://calisma.kurum.com/meetings/room/abc?join=1#x', origin)).toBe(
      '/meetings/room/abc',
    );
    expect(meetingKey('/meetings/room/abc/', origin)).toBe('/meetings/room/abc');
  });

  it('is the same meeting by its old Turkish address (one window, not two)', () => {
    expect(meetingKey('https://calisma.kurum.com/toplantilar/oda/abc?pencere=1', origin)).toBe(
      '/meetings/room/abc',
    );
    expect(meetingKey('/m/xyz', origin)).toBe('/m/xyz');
  });

  it('refuses other servers and nonsense', () => {
    expect(meetingKey('https://evil.example/toplantilar/oda/abc', origin)).toBeNull();
    expect(meetingKey('//evil.example/x', origin)).toBeNull();
    expect(meetingKey('https://calisma.kurum.com/', origin)).toBeNull();
    expect(meetingKey('http://[bad', origin)).toBeNull();
  });
});

describe('leftMeeting', () => {
  const key = '/toplantilar/oda/abc';
  it('stays while the page shows the meeting, another meeting page or a sign-in step', () => {
    expect(leftMeeting(`${origin}/toplantilar/oda/abc?panel=chat`, key, origin)).toBe(false);
    expect(leftMeeting(`${origin}/toplantilar/oda/abc/lobi`, key, origin)).toBe(false);
    expect(leftMeeting(`${origin}/m/xyz`, key, origin)).toBe(false);
    expect(leftMeeting(`${origin}/login?redirect=%2Ftoplantilar%2Foda%2Fabc`, key, origin)).toBe(
      false,
    );
    expect(leftMeeting(`${origin}/login/2fa`, key, origin)).toBe(false);
    expect(leftMeeting('https://idp.example/login', key, origin)).toBe(false);
  });

  it('knows the meeting and sign-in pages in both forms', () => {
    const now = '/meetings/room/abc';
    expect(leftMeeting(`${origin}/toplantilar/oda/abc`, now, origin)).toBe(false);
    expect(leftMeeting(`${origin}/meetings/room/abc/lobby`, key, origin)).toBe(false);
    expect(leftMeeting(`${origin}/forgot-password`, now, origin)).toBe(false);
    expect(leftMeeting(`${origin}/sifremi-unuttum`, now, origin)).toBe(false);
    expect(leftMeeting(`${origin}/security/2fa-setup`, now, origin)).toBe(false);
    expect(leftMeeting(`${origin}/guvenlik/2fa-kur`, now, origin)).toBe(false);
    expect(leftMeeting(`${origin}/meetings`, now, origin)).toBe(true);
    expect(leftMeeting(`${origin}/toplantilar`, now, origin)).toBe(true);
  });

  it('closes when the page goes elsewhere on the server', () => {
    expect(leftMeeting(`${origin}/toplantilar`, key, origin)).toBe(true);
    expect(leftMeeting(`${origin}/`, key, origin)).toBe(true);
    expect(leftMeeting(`${origin}/loginx`, key, origin)).toBe(true);
  });
});

describe('fitBounds', () => {
  const primary = { x: 0, y: 0, width: 1920, height: 1040 };
  const left = { x: -1920, y: 0, width: 1920, height: 1040 };

  it('keeps saved bounds that are on a screen, the left monitor included', () => {
    const saved = { x: -1500, y: 100, width: 1000, height: 700 };
    expect(fitBounds(saved, [primary, left])).toEqual(saved);
  });

  it('centres on the primary screen when the monitor is gone', () => {
    expect(fitBounds({ x: -1500, y: 100, width: 1000, height: 700 }, [primary])).toEqual({
      x: 360,
      y: 140,
      width: 1200,
      height: 760,
    });
    expect(fitBounds(null, [{ x: 0, y: 0, width: 1024, height: 700 }])).toEqual({
      x: 0,
      y: 0,
      width: 1024,
      height: 700,
    });
  });
});

describe('meeting window', () => {
  it('is not throttled in the background (presenting from another app)', () => {
    expect(MEETING_WEB_PREFERENCES.backgroundThrottling).toBe(false);
  });

  it('keeps a meeting at full speed in the main window too, other pages may slow down', () => {
    expect(mayThrottle(`${origin}/meetings/room/abc`, origin)).toBe(false);
    expect(mayThrottle(`${origin}/toplantilar/oda/abc?pencere=1`, origin)).toBe(false);
    expect(mayThrottle(`${origin}/m/xyz`, origin)).toBe(false);
    expect(mayThrottle(`${origin}/meetings`, origin)).toBe(true);
    expect(mayThrottle(`${origin}/chat`, origin)).toBe(true);
    // Another site with a meeting-looking path is not ours.
    expect(mayThrottle('https://evil.example/meetings/room/abc', origin)).toBe(true);
    expect(mayThrottle('not a url', origin)).toBe(true);
  });

  it("keeps the page's [media] lines for the log file, nothing else", () => {
    expect(mediaLogLine('[media] path udp host rtt 31 ms')).toBe('path udp host rtt 31 ms');
    expect(mediaLogLine('[meeting] page called window.close at /x')).toBeNull();
    expect(mediaLogLine('media without brackets')).toBeNull();
    expect(mediaLogLine(`[media] ${'x'.repeat(10_000)}`)).toHaveLength(4000);
  });

  it('tells the page closing its own window from its other notes', () => {
    expect(closedItself('[meeting] page called window.close at /meetings/room/a')).toBe(true);
    expect(closedItself('[meeting] something else')).toBe(false);
  });
});
