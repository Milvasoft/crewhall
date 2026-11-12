import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OUT_DIR, soundFiles } from '../src/generate';
import { encodeWav, loudness, RINGTONES, renderRingtone, SOUND_SAMPLE_RATE } from '../src/index';

const SR = SOUND_SAMPLE_RATE;
const rendered = Object.fromEntries(
  Object.entries(RINGTONES).map(([name, tone]) => [name, renderRingtone(tone, SR)]),
) as Record<keyof typeof RINGTONES, [Float32Array, Float32Array]>;

const peakOf = (chs: Float32Array[]) =>
  chs.reduce((p, c) => c.reduce((q, v) => Math.max(q, Math.abs(v)), p), 0);

describe('call, meeting and chat sounds (H6, H7)', () => {
  it.each(Object.keys(RINGTONES) as (keyof typeof RINGTONES)[])(
    '%s is stereo, at its loudness and under -1 dBFS',
    (name) => {
      const [l, r] = rendered[name];
      expect(l.length).toBe(r.length);
      expect(loudness([l, r], SR)).toBeCloseTo(RINGTONES[name].level, 0);
      expect(peakOf([l, r])).toBeLessThanOrEqual(10 ** (-1 / 20) + 1e-6);
      // The room makes the two sides differ.
      expect(l.some((v, i) => Math.abs(v - r[i]!) > 1e-3)).toBe(true);
    },
  );

  it.each(['incoming', 'ringback'] as const)('%s loops without a step at the seam', (name) => {
    const tone = RINGTONES[name];
    for (const ch of rendered[name]) {
      expect(ch.length).toBe(Math.round(tone.loop! * SR));
      // The jump from the last sample to the first is no bigger than an ordinary step.
      expect(Math.abs(ch[0]! - ch[ch.length - 1]!)).toBeLessThan(0.01);
    }
  });

  it.each(['joined', 'left', 'message', 'mention'] as const)(
    '%s plays once, briefly, and fades to silence',
    (name) => {
      for (const ch of rendered[name]) {
        expect(ch.length).toBeLessThanOrEqual(Math.round(2.6 * SR));
        expect(Math.abs(ch[ch.length - 1]!)).toBeLessThan(1e-3);
        expect(Math.abs(ch[0]!)).toBeLessThan(1e-3);
      }
    },
  );

  it('keeps the ring loudest, the ringback and the cues quieter, and mentions above messages', () => {
    const level = (n: keyof typeof RINGTONES) => RINGTONES[n].level;
    for (const n of ['ringback', 'joined', 'left', 'message', 'mention'] as const) {
      expect(level(n)).toBeLessThan(level('incoming'));
    }
    expect(level('left')).toBeLessThan(level('joined'));
    expect(level('mention')).toBeGreaterThan(level('message'));
    expect(RINGTONES.ringback.loop!).toBeGreaterThan(RINGTONES.incoming.loop!);
    // Leaving falls: it ends lower than it starts; joining rises.
    const notes = (n: 'joined' | 'left') => RINGTONES[n].notes.map((x) => x.freq);
    expect(notes('left').at(-1)!).toBeLessThan(notes('left')[0]!);
    expect(notes('joined')[1]!).toBeGreaterThan(notes('joined')[0]!);
  });

  it('renders the same samples every time', () => {
    const again = renderRingtone(RINGTONES.message, SR);
    expect(Buffer.from(again[0].buffer).equals(Buffer.from(rendered.message[0].buffer))).toBe(true);
  });

  it('renders at other rates too (the web plays it live at the device rate)', () => {
    const [l] = renderRingtone(RINGTONES.mention, 8000);
    expect(l.every(Number.isFinite)).toBe(true);
    // Mono at a low rate measures a little differently; within a decibel.
    expect(Math.abs(loudness([l], 8000) - RINGTONES.mention.level)).toBeLessThan(1);
  });

  it('writes a valid 16-bit stereo WAV', () => {
    const wav = encodeWav([new Float32Array([0, 1]), new Float32Array([0.5, -0.5])], 8000);
    const v = new DataView(wav.buffer);
    expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe('RIFF');
    expect(new TextDecoder().decode(wav.subarray(8, 12))).toBe('WAVE');
    expect(v.getUint16(22, true)).toBe(2);
    expect(v.getUint32(24, true)).toBe(8000);
    expect(v.getUint32(28, true)).toBe(32000);
    expect(v.getUint16(32, true)).toBe(4);
    expect(v.getUint16(34, true)).toBe(16);
    expect(v.getUint32(40, true)).toBe(8);
    // Interleaved: L0 R0 L1 R1.
    expect(v.getInt16(46, true)).toBe(Math.round(0.5 * 0x7fff));
    expect(v.getInt16(48, true)).toBe(0x7fff);
    expect(v.getInt16(50, true)).toBe(-0x4000);
  });

  it('matches the committed files (run sounds:generate after changing the notes)', () => {
    for (const f of soundFiles()) {
      const committed = readFileSync(join(OUT_DIR, f.name));
      expect(Buffer.compare(committed, Buffer.from(f.bytes)), f.name).toBe(0);
    }
  });
});
