import type { MeetControlMessage } from '@crewhall/shared';
import { describe, expect, it } from 'vitest';
import {
  LocalPointerWatch,
  RemoteControlSession,
  framePointToScreen,
  isBlockedKey,
  parseControlMessage,
  robotKeyName,
  robotModifiers,
  scrollUnits,
  type ControlInput,
  type Controller,
  type InputDriver,
  type RevokeReason,
  type SessionDeps,
  type SharedDisplay,
} from '../src/common/remote-control';

const ayse: Controller = { identity: 'u-ayse', name: 'Ayşe' };
const mert: Controller = { identity: 'u-mert', name: 'Mert' };
/** Second monitor left of the primary (DIP bounds as Electron reports them). */
const left: SharedDisplay = { id: 2, bounds: { x: -1280, y: 0, width: 1280, height: 720 } };
const primary: SharedDisplay = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } };
const noMods = { ctrl: false, alt: false, shift: false, meta: false };

function setup(over: Partial<SessionDeps> = {}) {
  const calls: string[] = [];
  const revokes: RevokeReason[] = [];
  const driver: InputDriver = {
    move: (x, y) => calls.push(`move ${x},${y}`),
    button: (b, down) => calls.push(`${b} ${down ? 'down' : 'up'}`),
    scroll: (dx, dy) => calls.push(`scroll ${dx},${dy}`),
    key: (name, down, mods) => calls.push(`key ${name} ${down ? 'down' : 'up'} ${mods.join('+')}`),
    type: (text) => calls.push(`type ${text}`),
  };
  const banner: Array<string | null> = [];
  const session = new RemoteControlSession({
    os: 'win32',
    driver,
    canInject: () => true,
    onController: (c) => banner.push(c?.name ?? null),
    requestRevoke: (reason) => revokes.push(reason),
    ...over,
  });
  return { session, calls, banner, revokes };
}

const input = (ev: ControlInput): MeetControlMessage => ({ type: 'input', ev });

describe('framePointToScreen', () => {
  it('maps the shared frame onto the display, monitors left of the primary included', () => {
    expect(framePointToScreen(0, 0, primary.bounds)).toEqual({ x: 0, y: 0 });
    expect(framePointToScreen(1, 1, primary.bounds)).toEqual({ x: 1919, y: 1079 });
    expect(framePointToScreen(0.5, 0.5, left.bounds)).toEqual({ x: -640, y: 360 });
  });

  it('never leaves the shared display', () => {
    expect(framePointToScreen(-0.3, 1.4, left.bounds)).toEqual({ x: -1280, y: 719 });
  });
});

describe('RemoteControlSession', () => {
  it('applies only the input of the person the page granted', () => {
    const { session, calls, banner } = setup();
    session.setShare(primary);

    session.receive('u-ayse', input({ k: 'move', x: 0.5, y: 0.5 }));
    expect(calls).toEqual([]);

    session.setController(ayse);
    expect(banner).toEqual(['Ayşe']);
    session.receive('u-mert', input({ k: 'move', x: 0.1, y: 0.1 }));
    session.receive('u-ayse', input({ k: 'down', b: 0, x: 0.25, y: 0.5 }));
    session.receive('u-ayse', input({ k: 'up', b: 0, x: 0.25, y: 0.5 }));
    session.receive('u-ayse', { type: 'grant', to: 'u-mert' });
    expect(calls).toEqual(['move 480,540', 'left down', 'move 480,540', 'left up']);
  });

  it('hands a grant it cannot honour straight back to the page', () => {
    const nothingShared = setup();
    nothingShared.session.setController(ayse);
    expect(nothingShared.revokes).toEqual(['share_ended']);
    expect(nothingShared.session.current).toBeNull();

    const off = setup();
    off.session.setShare(primary);
    off.session.setAllowed(false);
    off.session.setController(ayse);
    expect(off.revokes).toEqual(['not_allowed']);

    const noPermission = setup({ canInject: () => false });
    noPermission.session.setShare(primary);
    noPermission.session.setController(ayse);
    expect(noPermission.revokes).toEqual(['permission']);
    expect(noPermission.banner).toEqual([]);
  });

  it('asks the page to revoke when the sharer takes control back, and stops at once', () => {
    for (const [take, reason] of [
      [(s: RemoteControlSession) => s.stop('stopped'), 'stopped'],
      [(s: RemoteControlSession) => s.stop('local_input'), 'local_input'],
      [(s: RemoteControlSession) => s.setShare(null), 'share_ended'],
      [(s: RemoteControlSession) => s.setAllowed(false), 'not_allowed'],
    ] as const) {
      const { session, calls, banner, revokes } = setup();
      session.setShare(primary);
      session.setController(ayse);
      session.receive(
        'u-ayse',
        input({ k: 'key', code: 'ShiftLeft', key: 'Shift', down: true, mods: noMods }),
      );
      session.receive('u-ayse', input({ k: 'down', b: 2, x: 0, y: 0 }));
      take(session);
      expect(revokes).toEqual([reason]);
      expect(session.current).toBeNull();
      expect(banner.at(-1)).toBeNull();
      // Nothing stays pressed.
      expect(calls.slice(-2)).toEqual(['key shift up ', 'right up']);
      session.receive('u-ayse', input({ k: 'move', x: 0.5, y: 0.5 }));
      expect(calls.at(-1)).toBe('right up');
    }
  });

  it('just stops when the page revokes or the controller releases (no second revoke)', () => {
    const { session, banner, revokes } = setup();
    session.setShare(primary);
    session.setController(ayse);
    session.setController(null);
    expect(banner).toEqual(['Ayşe', null]);
    expect(revokes).toEqual([]);
  });

  it('moves control to a new person the page granted', () => {
    const { session, calls, banner } = setup();
    session.setShare(primary);
    session.setController(ayse);
    session.setController(mert);
    session.receive('u-ayse', input({ k: 'move', x: 0.5, y: 0.5 }));
    session.receive('u-mert', input({ k: 'move', x: 0, y: 0 }));
    expect(banner).toEqual(['Ayşe', null, 'Mert']);
    expect(calls).toEqual(['move 0,0']);
  });

  it('applies keys, text and wheel, but never blocked system shortcuts', () => {
    const { session, calls } = setup();
    session.setShare(left);
    session.setController(ayse);
    const key = (code: string, mods: Partial<typeof noMods> = {}) =>
      session.receive(
        'u-ayse',
        input({ k: 'key', code, key: code, down: true, mods: { ...noMods, ...mods } }),
      );
    key('KeyC', { ctrl: true });
    key('Delete', { ctrl: true, alt: true });
    key('MetaLeft');
    key('KeyL', { meta: true });
    key('Escape', { ctrl: true, shift: true });
    key('KeyX', { ctrl: true, alt: true, shift: true });
    session.receive('u-ayse', input({ k: 'text', text: 'Merhaba ğüş' }));
    session.receive('u-ayse', input({ k: 'wheel', dx: 0, dy: 5000 }));
    expect(calls).toEqual(['key c down control', 'type Merhaba ğüş', 'scroll 0,1000']);
  });
});

describe('keyboard helpers', () => {
  it('names physical keys the way robotjs expects', () => {
    expect(robotKeyName('KeyQ')).toBe('q');
    expect(robotKeyName('Digit7')).toBe('7');
    expect(robotKeyName('Numpad3')).toBe('numpad_3');
    expect(robotKeyName('F12')).toBe('f12');
    expect(robotKeyName('ArrowLeft')).toBe('left');
    expect(robotKeyName('Enter')).toBe('enter');
    expect(robotKeyName('LaunchMail')).toBeNull();
    expect(robotModifiers({ ctrl: true, shift: true, meta: true })).toEqual([
      'control',
      'shift',
      'command',
    ]);
  });

  it('blocks per platform', () => {
    const ev = (code: string, mods: Partial<typeof noMods> = {}) =>
      ({ k: 'key', code, key: code, down: true, mods: { ...noMods, ...mods } }) as const;
    expect(isBlockedKey(ev('KeyC', { meta: true }), 'win32')).toBe(true);
    expect(isBlockedKey(ev('KeyC', { meta: true }), 'darwin')).toBe(false); // Cmd+C is copy
    expect(isBlockedKey(ev('Escape', { meta: true, alt: true }), 'darwin')).toBe(true);
    expect(isBlockedKey(ev('KeyQ', { meta: true, ctrl: true }), 'darwin')).toBe(true);
    expect(isBlockedKey(ev('F4', { alt: true }), 'win32')).toBe(false);
  });
});

describe('scrollUnits', () => {
  it('turns browser deltas into each OS direction and unit', () => {
    expect(scrollUnits('win32', 0, 100)).toEqual({ x: 0, y: -120 });
    expect(scrollUnits('win32', 50, 0)).toEqual({ x: 60, y: -0 });
    expect(scrollUnits('darwin', 10, -40)).toEqual({ x: -10, y: 40 });
    expect(scrollUnits('linux', 0, 250)).toEqual({ x: -0, y: -3 });
  });
});

describe('LocalPointerWatch', () => {
  it('tells the sharer moving the mouse from the injected moves', () => {
    const w = new LocalPointerWatch(4, 100);
    w.injected({ x: 100, y: 100 }, 1000);
    expect(w.movedLocally({ x: 300, y: 300 }, 1050)).toBe(false); // still settling
    expect(w.movedLocally({ x: 102, y: 99 }, 1200)).toBe(false); // jitter
    expect(w.movedLocally({ x: 300, y: 300 }, 1200)).toBe(true);
  });
});

describe('parseControlMessage', () => {
  it('reads the shared meet protocol and rejects anything else', () => {
    expect(parseControlMessage('{"type":"input","ev":{"k":"move","x":0.2,"y":0.3}}')).toEqual({
      type: 'input',
      ev: { k: 'move', x: 0.2, y: 0.3 },
    });
    expect(parseControlMessage('{"type":"input","ev":{"k":"exec","cmd":"rm"}}')).toBeNull();
    expect(parseControlMessage('{"type":"input","ev":{"k":"move","x":4,"y":0}}')).toBeNull();
    expect(parseControlMessage('not json')).toBeNull();
  });
});
