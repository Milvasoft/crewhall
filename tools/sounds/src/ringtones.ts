/**
 * Call, meeting and chat sounds (H6, H7), defined as notes instead of recordings: nothing to
 * license, and web, desktop, mobile and the generator all play the same thing. `renderRingtone`
 * turns a definition into stereo samples; `src/generate.ts` writes them as WAV files
 * (apps/web/public/sounds, copied by the mobile app), and the web renders them live with Web Audio
 * when a file cannot be played.
 *
 * The voice is a struck wooden bar (a marimba kind of tone), modelled from its modes instead of
 * plain oscillators: the bar's inharmonic partials (1 : 3.99 : 10.65) each ring with their own
 * decay, upper ones dying first, a short filtered noise burst is the mallet, and a small stereo
 * room (a generated impulse response) gives it air. The level is matched by loudness, not peak,
 * and a soft limiter keeps every sound under -1 dBFS.
 */

export interface RingNote {
  /** Start, seconds. */
  at: number;
  /** Frequency in Hz. */
  freq: number;
  /** Strike strength 0..1: louder and brighter. */
  vel: number;
}

export interface Ringtone {
  /** Loop length in seconds for a sound that repeats (the file is exactly this long and loops
   * without a seam); a one-shot leaves it out and ends when it has faded. */
  loop?: number;
  /** Loudness in dBFS: the mean power of the loudest 30% of 50 ms frames. */
  level: number;
  /** Low-pass for a darker sound, Hz. */
  dark?: number;
  notes: RingNote[];
}

/** Note frequencies (A4 = 440 Hz). */
const A3 = 220;
const D4 = 293.66;
const FS4 = 369.99;
const A4 = 440;
const D5 = 587.33;
const E5 = 659.26;
const FS5 = 739.99;
const A5 = 880;
const D6 = 1174.66;

/**
 * Incoming call: a four-note phrase over a low D that answers itself (the second time it lands
 * higher), then rests. 3.2 s, loops. The loudest of the set.
 */
export const INCOMING: Ringtone = {
  loop: 3.2,
  level: -17,
  notes: [
    { at: 0, freq: D5, vel: 0.85 },
    { at: 0.13, freq: A4, vel: 0.6 },
    { at: 0.26, freq: E5, vel: 0.7 },
    { at: 0.39, freq: FS5, vel: 0.9 },
    { at: 0, freq: D4, vel: 0.3 },
    { at: 1, freq: D5, vel: 0.78 },
    { at: 1.13, freq: A4, vel: 0.55 },
    { at: 1.26, freq: E5, vel: 0.66 },
    { at: 1.39, freq: A5, vel: 0.95 },
    { at: 1, freq: D4, vel: 0.28 },
  ],
};

/** Ringback for the caller (while it rings at the other end): a low rolled chord, twice, every four seconds. */
export const RINGBACK: Ringtone = {
  loop: 4,
  level: -27,
  notes: [
    { at: 0, freq: A3, vel: 0.55 },
    { at: 0, freq: D4, vel: 0.6 },
    { at: 0.018, freq: FS4, vel: 0.5 },
    { at: 0.6, freq: A3, vel: 0.4 },
    { at: 0.6, freq: D4, vel: 0.45 },
    { at: 0.618, freq: FS4, vel: 0.38 },
  ],
};

/** Someone joined the meeting: a quick rising fifth with a soft octave on top. Plays once. */
export const JOINED: Ringtone = {
  level: -23,
  notes: [
    { at: 0, freq: A4, vel: 0.7 },
    { at: 0.085, freq: E5, vel: 0.85 },
    { at: 0.085, freq: A5, vel: 0.22 },
  ],
};

/** Someone left: the fifth falling, darker and quieter than the join. */
export const LEFT: Ringtone = {
  level: -25,
  dark: 3200,
  notes: [
    { at: 0, freq: E5, vel: 0.7 },
    { at: 0.1, freq: A4, vel: 0.75 },
  ],
};

/** A new chat message: two quick high notes. */
export const MESSAGE: Ringtone = {
  level: -21,
  notes: [
    { at: 0, freq: FS5, vel: 0.5 },
    { at: 0.06, freq: A5, vel: 0.82 },
  ],
};

/** A mention or a direct message: a brighter rising triad, a little louder than a message. */
export const MENTION: Ringtone = {
  level: -19,
  notes: [
    { at: 0, freq: D5, vel: 0.6 },
    { at: 0.065, freq: FS5, vel: 0.7 },
    { at: 0.13, freq: A5, vel: 0.9 },
    { at: 0.13, freq: D6, vel: 0.22 },
  ],
};

export const RINGTONES = {
  incoming: INCOMING,
  ringback: RINGBACK,
  joined: JOINED,
  left: LEFT,
  message: MESSAGE,
  mention: MENTION,
} as const;
export type RingtoneName = keyof typeof RINGTONES;

/** File names under apps/web/public/sounds (the mobile app copies them with "_" for "-"). */
export const RINGTONE_FILES: Record<RingtoneName, string> = {
  incoming: 'call-incoming.wav',
  ringback: 'call-ringback.wav',
  joined: 'meet-joined.wav',
  left: 'meet-left.wav',
  message: 'chat-message.wav',
  mention: 'chat-mention.wav',
};

// ---------------------------------------------------------------- voice

/** The bar's modes: [frequency ratio, level, decay relative to the fundamental's]. */
const MODES: readonly (readonly [number, number, number])[] = [
  [1, 1, 1],
  [3.99, 0.26, 0.2],
  [10.65, 0.06, 0.07],
];
/** Fundamental decay time constant at REF_HZ; lower notes ring longer (by DECAY_EXP). */
const BASE_DECAY = 0.42;
const REF_HZ = 523;
const DECAY_EXP = 0.6;
/** The mallet: band-limited noise, its level and decay. */
const MALLET = { lo: 500, hi: 2600, level: 0.22, decay: 0.005 };
const ATTACK = 0.0015;

/** The room: reverb time, impulse length, brightness, pre-delay and how much of it is heard. */
const ROOM = { rt60: 0.65, length: 1.04, bright: 5500, preDelay: 0.011, mix: 0.16, seed: 3 };
/** Rumble below this is cut (small speakers cannot play it anyway). */
const HIGH_PASS = 110;
/** A one-shot ends at -50 dB below its peak, at most this long, with this fade. */
const ONE_SHOT_MAX = 2.6;
const ONE_SHOT_FADE = 0.25;
/** Peak ceiling, -1 dBFS; the limiter starts bending at KNEE of it. */
const CEILING = 10 ** (-1 / 20);
const KNEE = 0.7;

/** Deterministic noise (mulberry32 + Box-Muller): the committed files are checked against it. */
function gaussian(seed: number): () => number {
  let a = seed >>> 0;
  const uniform = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return () => Math.sqrt(-2 * Math.log(1 - uniform())) * Math.cos(2 * Math.PI * uniform());
}

/** Raised-cosine fade-in over `seconds`. */
function attack(i: number, seconds: number, sr: number): number {
  const k = Math.max(1, Math.round(seconds * sr));
  return i >= k ? 1 : 0.5 - 0.5 * Math.cos((Math.PI * i) / k);
}

type Biquad = readonly [number, number, number, number, number];

/** Second-order Butterworth low- or high-pass (bilinear transform), cutoff clamped below Nyquist. */
function butter2(kind: 'low' | 'high', freq: number, sr: number): Biquad {
  const w = (2 * Math.PI * Math.min(freq, sr * 0.45)) / sr;
  const alpha = Math.sin(w) / Math.SQRT2;
  const cos = Math.cos(w);
  const a0 = 1 + alpha;
  const b1 = kind === 'low' ? 1 - cos : -(1 + cos);
  const b0 = kind === 'low' ? b1 / 2 : -b1 / 2;
  return [b0 / a0, b1 / a0, b0 / a0, (-2 * cos) / a0, (1 - alpha) / a0];
}

/** First-order Butterworth low-pass (bilinear transform). */
function butter1(freq: number, sr: number): Biquad {
  const k = Math.tan((Math.PI * Math.min(freq, sr * 0.45)) / sr);
  return [k / (1 + k), k / (1 + k), 0, (k - 1) / (1 + k), 0];
}

function filter(x: Float64Array, [b0, b1, b2, a1, a2]: Biquad): void {
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const x0 = x[i]!;
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
    x[i] = y0;
  }
}

/** One struck note, mono. */
function strike(freq: number, vel: number, seed: number, sr: number): Float64Array {
  const decay = BASE_DECAY * (REF_HZ / freq) ** DECAY_EXP;
  const n = Math.round(Math.min(7 * decay, 4) * sr);
  const out = new Float64Array(n);
  const bright = 0.55 + 0.45 * vel;
  MODES.forEach(([ratio, level, rel], m) => {
    const f = freq * ratio;
    if (f > sr * 0.42) return;
    const amp = level * (m ? bright : 1);
    const w = (2 * Math.PI * f) / sr;
    const tau = decay * rel * sr;
    for (let i = 0; i < n; i++) out[i]! += amp * Math.exp(-i / tau) * Math.sin(w * i);
  });
  for (let i = 0; i < n; i++) out[i]! *= attack(i, ATTACK, sr);

  const noise = new Float64Array(Math.min(n, Math.round(MALLET.decay * 10 * sr)));
  const g = gaussian(seed);
  for (let i = 0; i < noise.length; i++) noise[i] = g();
  filter(noise, butter2('high', MALLET.lo, sr));
  filter(noise, butter2('low', MALLET.hi, sr));
  let peak = 0;
  for (const v of noise) peak = Math.max(peak, Math.abs(v));
  const scale = (MALLET.level * vel) / (peak || 1);
  for (let i = 0; i < noise.length; i++) {
    out[i]! += scale * noise[i]! * Math.exp(-i / (MALLET.decay * sr)) * attack(i, 0.0007, sr);
  }
  for (let i = 0; i < n; i++) out[i]! *= vel;
  return out;
}

// ---------------------------------------------------------------- room

/** In-place radix-2 FFT (`invert` runs the inverse, unscaled). */
function fft(re: Float64Array, im: Float64Array, invert: boolean): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((invert ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b]! * cr - im[b]! * ci;
        const ti = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - tr;
        im[b] = im[a]! - ti;
        re[a]! += tr;
        im[a]! += ti;
        const next = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = next;
      }
    }
  }
}

/** `signal` convolved with `ir`, the first `length` samples. */
function convolve(signal: Float64Array, ir: Float64Array, length: number): Float64Array {
  let n = 1;
  while (n < signal.length + ir.length) n <<= 1;
  const ar = new Float64Array(n);
  const ai = new Float64Array(n);
  const br = new Float64Array(n);
  const bi = new Float64Array(n);
  ar.set(signal);
  br.set(ir);
  fft(ar, ai, false);
  fft(br, bi, false);
  for (let i = 0; i < n; i++) {
    const r = ar[i]! * br[i]! - ai[i]! * bi[i]!;
    ai[i] = ar[i]! * bi[i]! + ai[i]! * br[i]!;
    ar[i] = r;
  }
  fft(ar, ai, true);
  const out = new Float64Array(length);
  for (let i = 0; i < length && i < n; i++) out[i] = ar[i]! / n;
  return out;
}

const rooms = new Map<number, [Float64Array, Float64Array]>();

/**
 * The room's stereo impulse response: decaying noise (the highs die about twice as fast as the
 * lows), a few early reflections, unit energy. Each channel has its own noise, which makes the width.
 */
function room(sr: number): [Float64Array, Float64Array] {
  const cached = rooms.get(sr);
  if (cached) return cached;
  const g = gaussian(ROOM.seed);
  const n = Math.round(ROOM.length * sr);
  const pre = Math.round(ROOM.preDelay * sr);
  const make = () => {
    const low = new Float64Array(n);
    for (let i = 0; i < n; i++) low[i] = g();
    const high = Float64Array.from(low);
    filter(low, butter2('low', 2200, sr));
    const tail = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const lo = low[i]!;
      tail[i] =
        lo * Math.exp((-6.9 * t) / ROOM.rt60) +
        0.8 * (high[i]! - lo) * Math.exp((-6.9 * t) / (ROOM.rt60 * 0.45));
    }
    filter(tail, butter1(ROOM.bright, sr));
    const ir = new Float64Array(n + pre);
    for (let i = 0; i < n; i++) ir[pre + i] = tail[i]! * attack(i, 0.02, sr);
    for (let k = 0; k < 6; k++) {
      const at = Math.round((0.003 + 0.032 * Math.abs(Math.sin(g() * 7))) * sr);
      ir[at]! += 6 * (0.3 + 0.4 * Math.abs(Math.cos(g() * 5))) * (g() > 0 ? 1 : -1);
    }
    return ir;
  };
  const left = make();
  const right = make();
  let energy = 0;
  for (const ch of [left, right]) for (const v of ch) energy += v * v;
  const scale = 1 / Math.sqrt(energy / 2);
  for (const ch of [left, right]) for (let i = 0; i < ch.length; i++) ch[i]! *= scale;
  const ir: [Float64Array, Float64Array] = [left, right];
  rooms.set(sr, ir);
  return ir;
}

// ---------------------------------------------------------------- render

/** Loudness as `Ringtone.level` measures it, dBFS. */
export function loudness(channels: readonly ArrayLike<number>[], sr: number): number {
  const w = Math.max(1, Math.round(0.05 * sr));
  const len = channels[0]!.length;
  const frames: number[] = [];
  for (let f = 0; f + w <= len; f += w) {
    let e = 0;
    for (let i = f; i < f + w; i++) {
      let m = 0;
      for (const ch of channels) m += ch[i]!;
      m /= channels.length;
      e += m * m;
    }
    frames.push(e / w);
  }
  frames.sort((a, b) => b - a);
  const top = frames.slice(0, Math.max(1, Math.floor((frames.length * 3) / 10)));
  return 10 * Math.log10(top.reduce((s, v) => s + v, 0) / top.length + 1e-12);
}

/**
 * `tone` as stereo samples in -1..1, [left, right]. Deterministic: the same definition and rate
 * give the same samples (the committed files are checked against it).
 */
export function renderRingtone(tone: Ringtone, sr: number): [Float32Array, Float32Array] {
  const total = Math.round(((tone.loop ?? 0) + 3.5) * sr);
  const dry = [new Float64Array(total), new Float64Array(total)] as const;
  tone.notes.forEach((note, i) => {
    const s = strike(note.freq, note.vel, i + 11, sr);
    const pan = 0.5 + 0.18 * Math.sin(i * 2.1);
    const gains = [Math.cos((pan * Math.PI) / 2), Math.sin((pan * Math.PI) / 2)];
    const at = Math.round(note.at * sr);
    dry.forEach((ch, c) => {
      const gain = gains[c]! * Math.SQRT2;
      for (let k = 0; k < s.length && at + k < total; k++) ch[at + k]! += gain * s[k]!;
    });
  });
  if (tone.dark) for (const ch of dry) filter(ch, butter2('low', tone.dark, sr));
  const ir = room(sr);
  let mixed = dry.map((ch, c) => {
    const wet = convolve(ch, ir[c]!, total);
    for (let i = 0; i < total; i++) wet[i] = ch[i]! + ROOM.mix * wet[i]!;
    filter(wet, butter2('high', HIGH_PASS, sr));
    return wet;
  });

  if (tone.loop) {
    // The tail past the loop point sounds over the next cycle's start: fold it back.
    const len = Math.round(tone.loop * sr);
    mixed = mixed.map((ch) => {
      const folded = new Float64Array(len);
      for (let i = 0; i < ch.length; i++) folded[i % len]! += ch[i]!;
      return folded;
    });
  } else {
    let peak = 0;
    let last = 0;
    for (let i = 0; i < total; i++)
      peak = Math.max(peak, Math.abs(mixed[0]![i]!), Math.abs(mixed[1]![i]!));
    const floor = peak * 10 ** (-50 / 20);
    for (let i = 0; i < total; i++) {
      if (Math.abs(mixed[0]![i]!) > floor || Math.abs(mixed[1]![i]!) > floor) last = i;
    }
    const len = Math.min(last + 1, Math.round(ONE_SHOT_MAX * sr));
    const fade = Math.min(Math.round(ONE_SHOT_FADE * sr), len);
    mixed = mixed.map((ch) => {
      const cut = ch.slice(0, len);
      for (let k = 0; k < fade; k++) cut[len - fade + k]! *= 1 - k / Math.max(1, fade - 1);
      return cut;
    });
  }

  const gain = 10 ** ((tone.level - loudness(mixed, sr)) / 20);
  const knee = CEILING * KNEE;
  const span = CEILING - knee;
  return mixed.map((ch) =>
    Float32Array.from(ch, (v) => {
      const x = v * gain;
      const a = Math.abs(x);
      return a <= knee ? x : Math.sign(x) * (knee + span * Math.tanh((a - knee) / span));
    }),
  ) as [Float32Array, Float32Array];
}
