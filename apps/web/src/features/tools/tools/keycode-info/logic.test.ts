// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/keycode-info/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { describeKeyEvent } from './logic';

describe('keycode-info', () => {
  it('describes a letter key', () => {
    const info = describeKeyEvent({
      key: 'a',
      code: 'KeyA',
      keyCode: 65,
      which: 65,
      location: 0,
      altKey: false,
      ctrlKey: false,
      shiftKey: false,
      metaKey: false,
    });
    expect(info.code).toBe('KeyA');
    expect(info.keyCode).toBe(65);
    expect(info.locationName).toBe('Standard');
    expect(info.modifiers).toEqual([]);
  });

  it('labels space and collects modifiers', () => {
    const info = describeKeyEvent({
      key: ' ',
      code: 'Space',
      keyCode: 32,
      location: 0,
      altKey: true,
      ctrlKey: true,
      shiftKey: false,
      metaKey: false,
    });
    expect(info.key).toBe('Space');
    expect(info.modifiers).toEqual(['Ctrl', 'Alt']);
    expect(info.which).toBe(32);
  });

  it('names numpad location', () => {
    const info = describeKeyEvent({
      key: '1',
      code: 'Numpad1',
      keyCode: 97,
      location: 3,
      altKey: false,
      ctrlKey: false,
      shiftKey: false,
      metaKey: false,
    });
    expect(info.locationName).toBe('Numpad');
  });

  it('names left and right locations', () => {
    const left = describeKeyEvent({
      key: 'Shift',
      code: 'ShiftLeft',
      keyCode: 16,
      location: 1,
      altKey: false,
      ctrlKey: false,
      shiftKey: true,
      metaKey: false,
    });
    expect(left.locationName).toBe('Left');

    const right = describeKeyEvent({
      key: 'Shift',
      code: 'ShiftRight',
      keyCode: 16,
      location: 2,
      altKey: false,
      ctrlKey: false,
      shiftKey: true,
      metaKey: false,
    });
    expect(right.locationName).toBe('Right');
  });

  it('falls back to the numeric location for unknown location values', () => {
    const info = describeKeyEvent({
      key: 'x',
      code: 'KeyX',
      keyCode: 88,
      location: 7,
      altKey: false,
      ctrlKey: false,
      shiftKey: false,
      metaKey: false,
    });
    expect(info.locationName).toBe('7');
  });

  it('collects all four modifiers in a fixed order (Ctrl, Alt, Shift, Meta)', () => {
    const info = describeKeyEvent({
      key: 'z',
      code: 'KeyZ',
      keyCode: 90,
      location: 0,
      altKey: true,
      ctrlKey: true,
      shiftKey: true,
      metaKey: true,
    });
    expect(info.modifiers).toEqual(['Ctrl', 'Alt', 'Shift', 'Meta']);
  });

  it('uses `which` when provided instead of falling back to keyCode', () => {
    const info = describeKeyEvent({
      key: 'a',
      code: 'KeyA',
      keyCode: 65,
      which: 999,
      location: 0,
      altKey: false,
      ctrlKey: false,
      shiftKey: false,
      metaKey: false,
    });
    expect(info.which).toBe(999);
  });
});
