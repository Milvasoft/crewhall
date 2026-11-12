/**
 * Unread badge: chat conversations with unread messages plus unread notifications from the
 * other modules (a DM counts once, not as a conversation and a notification).
 */
export function badgeCount(
  unreadConversations: number,
  notificationsBySource: Partial<Record<string, number>>,
): number {
  let other = 0;
  for (const [source, n] of Object.entries(notificationsBySource)) {
    if (source !== 'chat') other += n ?? 0;
  }
  return Math.max(0, unreadConversations) + Math.max(0, other);
}

export function badgeLabel(count: number): string {
  if (count <= 0) return '';
  return count > 99 ? '99+' : String(count);
}

// 3×5 pixel glyphs for the Windows taskbar overlay, which has no text badge of its own.
const FONT: Record<string, string[]> = {
  '0': ['111', '101', '101', '101', '111'],
  '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'],
  '7': ['111', '001', '010', '010', '010'],
  '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111'],
  '+': ['000', '010', '111', '010', '000'],
};

/** Colours as BGR, the byte order of the bitmaps. */
const RED = [0x4d, 0x48, 0xe5] as const; // #E5484D
export const LIVE_GREEN = [0x78, 0x84, 0x11] as const; // #118478, brand green

type Bgr = readonly [number, number, number];

/** Paints a filled, anti-aliased circle into a premultiplied BGRA bitmap. */
function circle(
  buf: Buffer,
  width: number,
  cx: number,
  cy: number,
  r: number,
  color: Bgr = RED,
): void {
  const height = buf.length / 4 / width;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const a = Math.max(0, Math.min(1, r - d + 0.5));
      if (a <= 0) continue;
      const i = (y * width + x) * 4;
      const keep = 1 - a;
      buf[i] = Math.round(color[0] * a + buf[i]! * keep);
      buf[i + 1] = Math.round(color[1] * a + buf[i + 1]! * keep);
      buf[i + 2] = Math.round(color[2] * a + buf[i + 2]! * keep);
      buf[i + 3] = Math.round(255 * a + buf[i + 3]! * keep);
    }
  }
}

/** A red disc with the count in white: raw BGRA for nativeImage.createFromBitmap. */
export function badgeBitmap(label: string, size = 32): Buffer {
  const buf = Buffer.alloc(size * size * 4);
  circle(buf, size, size / 2, size / 2, size / 2);
  const glyphs = [...label].filter((c) => FONT[c]);
  if (glyphs.length === 0) return buf;
  const cols = glyphs.length * 4 - 1;
  const scale = Math.max(1, Math.floor(Math.min((size * 0.62) / cols, (size * 0.5) / 5)));
  const w = cols * scale;
  const h = 5 * scale;
  const left = Math.floor((size - w) / 2);
  const top = Math.floor((size - h) / 2);
  glyphs.forEach((c, g) => {
    FONT[c]!.forEach((row, ry) => {
      [...row].forEach((bit, rx) => {
        if (bit !== '1') return;
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) {
            const x = left + (g * 4 + rx) * scale + dx;
            const y = top + ry * scale + dy;
            buf.fill(255, (y * size + x) * 4, (y * size + x) * 4 + 4);
          }
        }
      });
    });
  });
  return buf;
}

/** Copy of a BGRA icon with a red dot in the top-right corner (tray icon with unread). */
export function withDot(bitmap: Buffer, width: number): Buffer {
  const out = Buffer.from(bitmap);
  const r = width * 0.22;
  circle(out, width, width - r - 0.5, r + 0.5, r);
  return out;
}

/** A plain disc (the meeting window's "live" taskbar mark). */
export function discBitmap(size: number, color: Bgr): Buffer {
  const buf = Buffer.alloc(size * size * 4);
  circle(buf, size, size / 2, size / 2, size / 2 - 2, color);
  return buf;
}
