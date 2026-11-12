import { ConnectionState, Track, type Room } from 'livekit-client';
import {
  AUDIO_LATE_MS,
  SEND_QUEUE_MS,
  collectStats,
  isDetour,
  pathFrom,
  pathLabel,
  type MediaPath,
  type StatsMemory,
  type TrackStats,
} from './stats';

/**
 * Audio heard seconds late comes and goes; by the time someone opens "Bağlantı ayrıntıları" it is
 * over. So during the whole meeting the room samples its audio every few seconds (getStats of the
 * microphone and of the voices it receives, cheap) and keeps the last ten minutes, and writes a
 * `[media]` line to the console when something is off. The desktop app copies those lines into its
 * log file; "Ayrıntıları kopyala" carries the history.
 *
 * What a sample tells apart:
 * - the network path: UDP or a TCP / TURN detour, its RTT and bandwidth estimate (bufferbloat
 *   shows as RTT going from tens of ms to hundreds);
 * - my sending: packets queued before the network, the SFU's jitter and loss of my microphone;
 * - what I receive: each voice's jitter buffer delay (the ~5 s symptom on the listener's side),
 *   its target and concealment;
 * - this page: hidden, timers firing late (background throttling) or a long main-thread task.
 */

export const SAMPLE_EVERY_MS = 5_000;
/** Ten minutes of samples. */
export const KEEP_SAMPLES = 120;
/** While a problem lasts, at most one line this often (and one when it changes or ends). */
const REPEAT_MS = 15_000;

const RTT_HIGH_MS = 400;
const SFU_JITTER_HIGH_MS = 80;
const CONCEALED_HIGH = 10;
const TIMER_LATE_MS = 2_000;
const LONG_TASK_MS = 1_000;

export interface VoiceSample {
  /** Display name: in the copied history only, never in a log line. */
  who: string;
  /** The participant's identity (an opaque id), for log lines. */
  id: string;
  jitterBufferMs: number | null;
  targetMs: number | null;
  jitterMs: number | null;
  lossPercent: number | null;
  concealedPercent: number | null;
}

export interface MediaSample {
  at: string;
  /** document.visibilityState === 'visible'. */
  visible: boolean;
  /** How late this sample's timer fired (background throttling, a busy main thread). */
  timerLagMs: number;
  /** Longest main-thread task since the previous sample (0 when the browser does not tell). */
  longTaskMs: number;
  path: MediaPath | null;
  /** My microphone as sent (null when it is off or muted). */
  mic: {
    rttMs: number | null;
    jitterMs: number | null;
    lossPercent: number | null;
    sendDelayMs: number | null;
    bitrate: number | null;
  } | null;
  voices: VoiceSample[];
}

const isVoice = (s: TrackStats) =>
  s.kind === 'audio' &&
  (s.source === Track.Source.Microphone || s.source === Track.Source.ScreenShareAudio);

/** A sample from one round of stats plus what the page knows about itself. */
export function toSample(
  stats: TrackStats[],
  page: { at: number; visible: boolean; timerLagMs: number; longTaskMs: number },
): MediaSample {
  const mic = stats.find((s) => s.direction === 'send' && s.source === Track.Source.Microphone);
  return {
    at: new Date(page.at).toISOString(),
    visible: page.visible,
    timerLagMs: Math.max(0, Math.round(page.timerLagMs)),
    longTaskMs: Math.round(page.longTaskMs),
    path: pathFrom(stats),
    mic: mic
      ? {
          rttMs: mic.rttMs,
          jitterMs: mic.jitterMs,
          lossPercent: mic.lossPercent,
          sendDelayMs: mic.sendDelayMs,
          bitrate: mic.bitrate,
        }
      : null,
    voices: stats
      .filter((s) => s.direction === 'receive' && isVoice(s))
      .map((s) => ({
        who: s.participant,
        // Keys are `<identity>:<trackSid>`.
        id: s.key.includes(':') ? s.key.slice(0, s.key.lastIndexOf(':')) : s.key,
        jitterBufferMs: s.jitterBufferMs,
        targetMs: s.jitterBufferTargetMs,
        jitterMs: s.jitterMs,
        lossPercent: s.lossPercent,
        concealedPercent: s.concealedPercent,
      })),
  };
}

export type Problem =
  | 'rtt'
  | 'send-queue'
  | 'sfu-jitter'
  | 'voice-late'
  | 'voice-concealed'
  | 'timers-late'
  | 'main-thread-blocked';

/** What is off in a sample, most telling first. */
export function problemsOf(s: MediaSample): Problem[] {
  const out: Problem[] = [];
  if (s.voices.some((v) => (v.jitterBufferMs ?? 0) >= AUDIO_LATE_MS)) out.push('voice-late');
  if ((s.mic?.sendDelayMs ?? 0) >= SEND_QUEUE_MS) out.push('send-queue');
  if ((s.path?.rttMs ?? s.mic?.rttMs ?? 0) >= RTT_HIGH_MS) out.push('rtt');
  if ((s.mic?.jitterMs ?? 0) >= SFU_JITTER_HIGH_MS) out.push('sfu-jitter');
  if (s.voices.some((v) => (v.concealedPercent ?? 0) >= CONCEALED_HIGH)) {
    out.push('voice-concealed');
  }
  if (s.timerLagMs >= TIMER_LATE_MS) out.push('timers-late');
  if (s.longTaskMs >= LONG_TASK_MS) out.push('main-thread-blocked');
  return out;
}

export interface WatchLogState {
  path: string | null;
  problems: string;
  since: number | null;
  lastAt: number;
}

export const initialLogState: WatchLogState = { path: null, problems: '', since: null, lastAt: 0 };

/**
 * Which `[media]` lines a new sample is worth: the path when it is first known or changes, a
 * problem when it starts, changes or still lasts after REPEAT_MS, and when it is over.
 */
export function logLines(
  state: WatchLogState,
  sample: MediaSample,
  now: number,
): { state: WatchLogState; lines: string[] } {
  const lines: string[] = [];
  const next = { ...state };
  const path = sample.path ? pathLabel(sample.path) : null;
  if (path && path !== state.path) {
    // TCP or a relay is said on the line: audio can queue behind lost packets there.
    const detour = isDetour(sample.path) ? ' (detour: audio may queue)' : '';
    lines.push(
      state.path
        ? `[media] path changed ${state.path} -> ${path}${detour}`
        : `[media] path ${path} rtt ${sample.path?.rttMs ?? '?'} ms${detour}`,
    );
    next.path = path;
  }
  const problems = problemsOf(sample).join(',');
  if (problems) {
    if (problems !== state.problems || now - state.lastAt >= REPEAT_MS) {
      // Names stay out: the desktop app writes these lines to its log file.
      const data = JSON.stringify(sample, (k, v: unknown) => (k === 'who' ? undefined : v));
      lines.push(`[media] ${problems} ${data}`);
      next.lastAt = now;
    }
    next.since = state.since ?? now;
  } else if (state.problems) {
    const lasted = state.since === null ? 0 : Math.round((now - state.since) / 1000);
    lines.push(`[media] ok again after ${lasted} s (was ${state.problems})`);
    next.since = null;
  }
  next.problems = problems;
  return { state: next, lines };
}

const histories = new WeakMap<Room, MediaSample[]>();

/** The room's samples, oldest first (for "Ayrıntıları kopyala"). */
export function mediaHistory(room: Room): MediaSample[] {
  return [...(histories.get(room) ?? [])];
}

/** The longest main-thread task seen since the last call, where the browser reports them. */
function watchLongTasks(): { take: () => number; stop: () => void } {
  let longest = 0;
  let observer: PerformanceObserver | null = null;
  try {
    if (
      typeof PerformanceObserver !== 'undefined' &&
      PerformanceObserver.supportedEntryTypes?.includes('longtask')
    ) {
      observer = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) longest = Math.max(longest, e.duration);
      });
      observer.observe({ type: 'longtask' });
    }
  } catch {
    observer = null;
  }
  return {
    take: () => {
      const v = longest;
      longest = 0;
      return v;
    },
    stop: () => observer?.disconnect(),
  };
}

/** Samples the room's audio until the returned function is called. */
export function startMediaWatch(
  room: Room,
  {
    every = SAMPLE_EVERY_MS,
    log = (line: string) => console.warn(line),
  }: { every?: number; log?: (line: string) => void } = {},
): () => void {
  const history: MediaSample[] = [];
  histories.set(room, history);
  const memory: StatsMemory = new Map();
  const tasks = watchLongTasks();
  let state = initialLogState;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let due = Date.now() + every;

  const tick = async () => {
    const now = Date.now();
    const timerLagMs = now - due;
    try {
      if (room.state === ConnectionState.Connected) {
        const stats = await collectStats(room, memory, { kinds: ['audio'] });
        if (stopped) return;
        const sample = toSample(stats, {
          at: now,
          visible: typeof document === 'undefined' || document.visibilityState === 'visible',
          timerLagMs,
          longTaskMs: tasks.take(),
        });
        history.push(sample);
        if (history.length > KEEP_SAMPLES) history.splice(0, history.length - KEEP_SAMPLES);
        const r = logLines(state, sample, now);
        state = r.state;
        r.lines.forEach((line) => log(line));
      }
    } catch {
      // Diagnostics never break the meeting.
    }
    if (stopped) return;
    due = Date.now() + every;
    timer = setTimeout(() => void tick(), every);
  };
  timer = setTimeout(() => void tick(), every);

  return () => {
    stopped = true;
    clearTimeout(timer);
    tasks.stop();
  };
}
