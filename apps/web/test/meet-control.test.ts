import { MeetControlMessage } from '@crewhall/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buttonOf,
  keyInput,
  MOVE_INTERVAL_MS,
  normalizePoint,
  pictureBox,
  throttleMoves,
  wheelPixels,
} from '@/lib/meet/control';

const box = { left: 100, top: 50, width: 800, height: 600 };

describe('remote control input (controlling side)', () => {
  it('measures points on the picture, not on the black bars', () => {
    // 1920×1080 in 800×600: full width, 450 px high, 75 px bars above and below.
    expect(pictureBox(box, 1920, 1080)).toEqual({ left: 100, top: 125, width: 800, height: 450 });
    expect(normalizePoint(100, 125, box, 1920, 1080)).toEqual({ x: 0, y: 0 });
    expect(normalizePoint(900, 575, box, 1920, 1080)).toEqual({ x: 1, y: 1 });
    expect(normalizePoint(500, 350, box, 1920, 1080)).toEqual({ x: 0.5, y: 0.5 });
    // On the bars or outside: nothing is sent.
    expect(normalizePoint(500, 100, box, 1920, 1080)).toBeNull();
    expect(normalizePoint(50, 350, box, 1920, 1080)).toBeNull();
    // A tall picture (portrait monitor) gets bars left and right instead.
    const tall = pictureBox(box, 1080, 1920);
    expect(tall.top).toBe(50);
    expect(tall.width).toBeCloseTo(337.5);
    expect(normalizePoint(500, 650, box, 1080, 1920)).toEqual({ x: 0.5, y: 1 });
    // Before the video knows its size the whole box counts.
    expect(normalizePoint(500, 350, box, 0, 0)).toEqual({ x: 0.5, y: 0.5 });
  });

  it('produces input the protocol accepts', () => {
    const p = normalizePoint(321, 222, box, 1920, 1080)!;
    expect(MeetControlMessage.safeParse({ type: 'input', ev: { k: 'move', ...p } }).success).toBe(
      true,
    );
    const key = keyInput(
      { code: 'KeyS', key: 's', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false },
      true,
    );
    expect(key).toEqual({
      k: 'key',
      code: 'KeyS',
      key: 's',
      down: true,
      mods: { ctrl: true, alt: false, shift: false, meta: false },
    });
    expect(MeetControlMessage.safeParse({ type: 'input', ev: key }).success).toBe(true);
    expect(
      keyInput(
        { code: '', key: 'x', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false },
        false,
      ),
    ).toBeNull();
  });

  it('turns wheel lines and pages into pixels, and maps mouse buttons', () => {
    expect(wheelPixels({ deltaX: 0, deltaY: 120, deltaMode: 0 }, 600)).toEqual({ dx: 0, dy: 120 });
    expect(wheelPixels({ deltaX: 1, deltaY: 3, deltaMode: 1 }, 600)).toEqual({ dx: 16, dy: 48 });
    expect(wheelPixels({ deltaX: 0, deltaY: -1, deltaMode: 2 }, 600)).toEqual({ dx: 0, dy: -600 });
    expect([0, 1, 2, 3, 4].map(buttonOf)).toEqual([0, 1, 2, null, null]);
  });

  describe('pointer moves', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('go out about 30 times a second and the last one always arrives', () => {
      vi.useFakeTimers();
      const sent: number[] = [];
      const moves = throttleMoves<number>((v) => sent.push(v));
      moves.push(1);
      for (let i = 2; i <= 10; i++) moves.push(i);
      expect(sent).toEqual([1]);
      vi.advanceTimersByTime(MOVE_INTERVAL_MS);
      expect(sent).toEqual([1, 10]);
      moves.push(11);
      moves.cancel();
      vi.advanceTimersByTime(MOVE_INTERVAL_MS * 2);
      expect(sent).toEqual([1, 10]);
    });
  });
});
