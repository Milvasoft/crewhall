import { ConnectionState, Track, type Room } from 'livekit-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  initialLogState,
  logLines,
  mediaHistory,
  problemsOf,
  startMediaWatch,
  toSample,
  type MediaSample,
} from '@/lib/meet/mediaWatch';
import { type MediaPath, type TrackStats } from '@/lib/meet/stats';

const udp: MediaPath = {
  protocol: 'udp',
  local: 'host',
  remote: 'host',
  relayProtocol: null,
  networkType: null,
  rttMs: 30,
  outBitrate: 2_000_000,
};

const row = (p: Partial<TrackStats>): TrackStats => ({
  key: 'u_elif:TR_mic',
  direction: 'receive',
  participant: 'Elif',
  source: Track.Source.Microphone,
  kind: 'audio',
  codec: 'opus',
  width: null,
  height: null,
  fps: null,
  bitrate: 30_000,
  lossPercent: 0,
  rttMs: 30,
  jitterMs: 3,
  limit: null,
  jitterBufferMs: 60,
  jitterBufferTargetMs: 50,
  concealedPercent: 0,
  sendDelayMs: null,
  path: udp,
  ...p,
});

const page = { at: Date.UTC(2026, 10, 11, 9), visible: true, timerLagMs: 3, longTaskMs: 0 };

describe('media watch samples', () => {
  it('keeps the path, my microphone and each voice; camera rows stay out', () => {
    const s = toSample(
      [
        row({ direction: 'send', participant: '', sendDelayMs: 4, jitterMs: 5 }),
        row({}),
        row({ kind: 'video', source: Track.Source.Camera, participant: 'Can' }),
      ],
      page,
    );
    expect(s).toMatchObject({
      at: '2026-11-11T09:00:00.000Z',
      path: udp,
      mic: { sendDelayMs: 4, jitterMs: 5, rttMs: 30 },
      voices: [{ who: 'Elif', jitterBufferMs: 60, targetMs: 50 }],
    });
    expect(problemsOf(s)).toEqual([]);
  });

  it('names what is off: a late voice, a queued microphone, late timers, a blocked page', () => {
    const late = toSample([row({ jitterBufferMs: 4800 })], page);
    expect(problemsOf(late)).toEqual(['voice-late']);
    // Bufferbloat on my uplink: packets queue and the round trip grows.
    const queued = toSample(
      [row({ direction: 'send', sendDelayMs: 900, path: { ...udp, rttMs: 700 } })],
      page,
    );
    expect(problemsOf(queued)).toEqual(['send-queue', 'rtt']);
    const throttled = toSample([row({})], { ...page, timerLagMs: 4000, longTaskMs: 1500 });
    expect(problemsOf(throttled)).toEqual(['timers-late', 'main-thread-blocked']);
  });
});

describe('media watch log lines', () => {
  const sample = (p: Partial<MediaSample> = {}): MediaSample => ({
    ...toSample([row({})], page),
    ...p,
  });

  it('says the path once, then only when it changes, and marks a detour', () => {
    let r = logLines(initialLogState, sample(), 0);
    expect(r.lines).toEqual(['[media] path udp host rtt 30 ms']);
    r = logLines(r.state, sample(), 5000);
    expect(r.lines).toEqual([]);
    r = logLines(r.state, sample({ path: { ...udp, protocol: 'tcp' } }), 10_000);
    expect(r.lines).toEqual([
      '[media] path changed udp host -> tcp host (detour: audio may queue)',
    ]);
  });

  it('logs a problem when it starts, at most every 15 s while it lasts, and when it ends', () => {
    const late = sample({ voices: [{ ...sample().voices[0]!, jitterBufferMs: 4800 }] });
    let r = logLines({ ...initialLogState, path: 'udp host' }, late, 0);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatch(/^\[media\] voice-late \{.*"jitterBufferMs":4800/);
    // The log file gets the opaque identity, not the name.
    expect(r.lines[0]).not.toContain('Elif');
    expect(r.lines[0]).toContain('"id":"u_elif"');
    r = logLines(r.state, late, 5000);
    expect(r.lines).toEqual([]);
    r = logLines(r.state, late, 15_000);
    expect(r.lines).toHaveLength(1);
    r = logLines(r.state, sample(), 20_000);
    expect(r.lines).toEqual(['[media] ok again after 20 s (was voice-late)']);
    r = logLines(r.state, sample(), 25_000);
    expect(r.lines).toEqual([]);
  });
});

describe('startMediaWatch', () => {
  afterEach(() => vi.useRealTimers());

  it('samples a connected room on a timer, keeps the history and stops cleanly', async () => {
    vi.useFakeTimers();
    let delay = 2880;
    let emitted = 48_000;
    const report = () =>
      new Map<string, Record<string, unknown>>([
        [
          'i',
          {
            id: 'i',
            type: 'inbound-rtp',
            kind: 'audio',
            bytesReceived: emitted,
            packetsReceived: 100,
            packetsLost: 0,
            jitterBufferDelay: delay,
            jitterBufferEmittedCount: emitted,
          },
        ],
      ]);
    const voice = {
      track: { getRTCStatsReport: async () => report() },
      isSubscribed: true,
      isMuted: false,
      trackSid: 'TR_mic',
      source: Track.Source.Microphone,
      kind: Track.Kind.Audio,
    };
    const room = {
      state: ConnectionState.Connected,
      localParticipant: { trackPublications: new Map() },
      remoteParticipants: new Map([
        [
          'elif',
          { identity: 'elif', name: 'Elif', trackPublications: new Map([['TR_mic', voice]]) },
        ],
      ]),
    } as unknown as Room;
    const lines: string[] = [];
    const stop = startMediaWatch(room, { every: 1000, log: (l) => lines.push(l) });

    await vi.advanceTimersByTimeAsync(1000);
    expect(mediaHistory(room)).toHaveLength(1);
    expect(mediaHistory(room)[0]?.voices[0]?.jitterBufferMs).toBe(60);

    delay += 1_152_000;
    emitted += 240_000;
    await vi.advanceTimersByTimeAsync(1000);
    expect(mediaHistory(room)[1]?.voices[0]?.jitterBufferMs).toBe(4800);
    expect(lines.some((l) => l.startsWith('[media] voice-late'))).toBe(true);

    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(mediaHistory(room)).toHaveLength(2);
  });
});
