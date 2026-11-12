import { describe, expect, it } from 'vitest';
import { MEET_CALL_PUSH } from '@crewhall/shared';
import { pushSound, versionAtLeast } from '../src/services/notifications/fcm';

describe('push channel and sound', () => {
  it('rings calls on the call channel with the call melody', () => {
    expect(pushSound('meet.call', true)).toEqual({
      channel: MEET_CALL_PUSH.androidChannel,
      sound: MEET_CALL_PUSH.sound,
    });
  });

  it('keeps alerts and default for everything else', () => {
    expect(pushSound('meet.call_missed', true)).toEqual({ channel: 'alerts', sound: 'default' });
    expect(pushSound('chat.mention', false)).toEqual({ channel: 'default', sound: 'default' });
  });
});

describe('app version gate for data-only calls', () => {
  it('compares semver parts as numbers', () => {
    expect(versionAtLeast('0.2.0', '0.2.0')).toBe(true);
    expect(versionAtLeast('0.10.0', '0.2.0')).toBe(true);
    expect(versionAtLeast('1.0.0-beta', '0.2.0')).toBe(true);
    expect(versionAtLeast('0.1.9', '0.2.0')).toBe(false);
    expect(versionAtLeast(null, '0.2.0')).toBe(false);
  });
});
