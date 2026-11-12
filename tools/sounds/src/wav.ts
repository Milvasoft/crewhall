/** 16-bit PCM WAV, one or more channels: plays everywhere (browsers, Android, iOS) without an encoder. */
export function encodeWav(channels: readonly Float32Array[], sampleRate: number): Uint8Array {
  const count = channels.length;
  const frames = channels[0]?.length ?? 0;
  const bytes = frames * count * 2;
  const buf = new ArrayBuffer(44 + bytes);
  const v = new DataView(buf);
  const text = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i));
  };
  text(0, 'RIFF');
  v.setUint32(4, 36 + bytes, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, count, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * count * 2, true);
  v.setUint16(32, count * 2, true);
  v.setUint16(34, 16, true);
  text(36, 'data');
  v.setUint32(40, bytes, true);
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < count; c++) {
      const s = Math.max(-1, Math.min(1, channels[c]![i]!));
      v.setInt16(44 + (i * count + c) * 2, Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), true);
    }
  }
  return new Uint8Array(buf);
}
