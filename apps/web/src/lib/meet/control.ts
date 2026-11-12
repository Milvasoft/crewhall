import { type MeetControlInput, type MeetControlMods } from '@crewhall/shared';

/**
 * Remote control, the controlling side (web): turns pointer, wheel and key events on the shared
 * screen's video into protocol input (packages/shared MeetControlMessage). The video is shown
 * with `object-fit: contain`, so the picture may sit inside black bars; points are measured on
 * the picture itself, 0..1, and clicks on the bars are not sent.
 */

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Where the picture is drawn inside an element of `box` (object-fit: contain). */
export function pictureBox(box: Box, videoWidth: number, videoHeight: number): Box {
  if (!videoWidth || !videoHeight || !box.width || !box.height) return box;
  const scale = Math.min(box.width / videoWidth, box.height / videoHeight);
  const width = videoWidth * scale;
  const height = videoHeight * scale;
  return {
    left: box.left + (box.width - width) / 2,
    top: box.top + (box.height - height) / 2,
    width,
    height,
  };
}

/** A client point as 0..1 on the picture; null on the black bars or outside. */
export function normalizePoint(
  clientX: number,
  clientY: number,
  box: Box,
  videoWidth: number,
  videoHeight: number,
): { x: number; y: number } | null {
  const p = pictureBox(box, videoWidth, videoHeight);
  const x = (clientX - p.left) / p.width;
  const y = (clientY - p.top) / p.height;
  if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) return null;
  return { x, y };
}

/** Wheel deltas in pixels whatever the DOM delta mode (lines ≈ 16 px, pages = the box). */
export function wheelPixels(
  e: Pick<WheelEvent, 'deltaX' | 'deltaY' | 'deltaMode'>,
  pageHeight: number,
): { dx: number; dy: number } {
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? pageHeight : 1;
  return { dx: Math.round(e.deltaX * unit), dy: Math.round(e.deltaY * unit) };
}

export function modsOf(
  e: Pick<KeyboardEvent, 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>,
): MeetControlMods {
  return { ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey };
}

/** A key press or release; null for keys the protocol cannot carry (no code). */
export function keyInput(
  e: Pick<KeyboardEvent, 'code' | 'key' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>,
  down: boolean,
): MeetControlInput | null {
  if (!e.code || !e.key) return null;
  return {
    k: 'key',
    code: e.code.slice(0, 64),
    key: e.key.slice(0, 64),
    down,
    mods: modsOf(e),
  };
}

/** DOM mouse button → protocol button (0 left, 1 middle, 2 right); others are not sent. */
export function buttonOf(button: number): 0 | 1 | 2 | null {
  return button === 0 || button === 1 || button === 2 ? button : null;
}

/** About 30 pointer moves a second: the latest move wins, the last one is never lost. */
export const MOVE_INTERVAL_MS = 33;

export function throttleMoves<T>(send: (v: T) => void, interval = MOVE_INTERVAL_MS) {
  let last = 0;
  let pending: T | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    timer = null;
    if (pending === null) return;
    last = Date.now();
    const v = pending;
    pending = null;
    send(v);
  };
  return {
    push(v: T) {
      pending = v;
      const wait = interval - (Date.now() - last);
      if (wait <= 0) flush();
      else timer ??= setTimeout(flush, wait);
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
      pending = null;
    },
  };
}
