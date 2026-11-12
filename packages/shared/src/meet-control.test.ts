import { describe, expect, it } from 'vitest';
import {
  controlReliable,
  MEET_CONTROL_TOPIC,
  MEET_IDENTITY,
  MEET_REMOTE_CONTROL_ATTRIBUTE,
  MeetControlMessage,
  mayControl,
} from './index';

describe('remote control protocol', () => {
  const mods = { ctrl: false, alt: false, shift: true, meta: false };

  it('accepts every message the protocol defines', () => {
    const ok = [
      { type: 'request' },
      { type: 'grant', to: 'u:01a158c2-7d07-7d3d-9fd3-60c6c15dd7d4' },
      { type: 'deny', to: 'u:01a158c2-7d07-7d3d-9fd3-60c6c15dd7d4' },
      { type: 'revoke' },
      { type: 'release' },
      { type: 'input', ev: { k: 'move', x: 0.25, y: 1 } },
      { type: 'input', ev: { k: 'down', b: 0, x: 0, y: 0.5 } },
      { type: 'input', ev: { k: 'up', b: 2, x: 0.5, y: 0.5 } },
      { type: 'input', ev: { k: 'wheel', dx: 0, dy: -120 } },
      { type: 'input', ev: { k: 'key', code: 'KeyA', key: 'A', down: true, mods } },
      { type: 'input', ev: { k: 'text', text: 'Merhaba' } },
    ];
    for (const m of ok)
      expect(MeetControlMessage.safeParse(m).success, JSON.stringify(m)).toBe(true);
    expect(MEET_CONTROL_TOPIC).toBe('meet.control');
    expect(MEET_REMOTE_CONTROL_ATTRIBUTE).toBe('crewhall.remoteControl');
  });

  it('rejects points off the frame, unknown buttons and malformed keys', () => {
    const bad = [
      { type: 'input', ev: { k: 'move', x: 1.2, y: 0.5 } },
      { type: 'input', ev: { k: 'move', x: -0.1, y: 0.5 } },
      { type: 'input', ev: { k: 'down', b: 3, x: 0.5, y: 0.5 } },
      { type: 'input', ev: { k: 'key', code: '', key: 'a', down: true, mods } },
      { type: 'input', ev: { k: 'key', code: 'KeyA', key: 'a', down: true } },
      { type: 'input', ev: { k: 'text', text: '' } },
      { type: 'grant' },
      { type: 'steal' },
    ];
    for (const m of bad)
      expect(MeetControlMessage.safeParse(m).success, JSON.stringify(m)).toBe(false);
  });

  it('sends moves and wheel lossy, everything else reliable', () => {
    const msg = (ev: unknown) => MeetControlMessage.parse({ type: 'input', ev });
    expect(controlReliable(msg({ k: 'move', x: 0, y: 0 }))).toBe(false);
    expect(controlReliable(msg({ k: 'wheel', dx: 0, dy: 10 }))).toBe(false);
    expect(controlReliable(msg({ k: 'down', b: 0, x: 0, y: 0 }))).toBe(true);
    expect(controlReliable(msg({ k: 'key', code: 'Enter', key: 'Enter', down: true, mods }))).toBe(
      true,
    );
    expect(controlReliable(MeetControlMessage.parse({ type: 'grant', to: 'u:x' }))).toBe(true);
  });

  it('never lets guests control', () => {
    expect(mayControl(MEET_IDENTITY.user('01a158c2-7d07-7d3d-9fd3-60c6c15dd7d4'))).toBe(true);
    expect(mayControl(MEET_IDENTITY.guest('01a158c2-7d07-7d3d-9fd3-60c6c15dd7d4'))).toBe(false);
    expect(mayControl('EG_recorder')).toBe(false);
  });
});
