import { Track } from 'livekit-client';
import { describe, expect, it } from 'vitest';
import {
  diagnose,
  isDetour,
  pathLabel,
  pathOf,
  summarize,
  type StatsMemory,
  type TrackStats,
} from '@/lib/meet/stats';

const send = {
  key: 'me:TR_cam',
  direction: 'send' as const,
  participant: '',
  source: Track.Source.Camera,
  kind: 'video' as const,
};

/** A simulcast camera: two outbound layers, the receiver's report and the codec. */
const sending = (bytes: [number, number], limit = 'none') => [
  { id: 'c1', type: 'codec', mimeType: 'video/VP8' },
  {
    id: 'o1',
    type: 'outbound-rtp',
    codecId: 'c1',
    frameWidth: 1280,
    frameHeight: 720,
    framesPerSecond: 24,
    bytesSent: bytes[0],
    packetsSent: 900,
    qualityLimitationReason: limit,
  },
  {
    id: 'o2',
    type: 'outbound-rtp',
    codecId: 'c1',
    frameWidth: 320,
    frameHeight: 180,
    framesPerSecond: 24,
    bytesSent: bytes[1],
    packetsSent: 100,
    qualityLimitationReason: 'none',
  },
  { id: 'r1', type: 'remote-inbound-rtp', packetsLost: 10, roundTripTime: 0.042, jitter: 0.004 },
];

describe('connection details', () => {
  it('reads a simulcast camera: top layer size, summed bitrate, loss, RTT, jitter', () => {
    const memory: StatsMemory = new Map();
    expect(summarize(sending([0, 0]), send, memory, 1000).bitrate).toBeNull();
    const s = summarize(sending([150_000, 25_000]), send, memory, 2000);
    expect(s).toMatchObject({
      codec: 'VP8',
      width: 1280,
      height: 720,
      fps: 24,
      // (150000 + 25000) bytes in one second.
      bitrate: 1_400_000,
      lossPercent: 1,
      rttMs: 42,
      jitterMs: 4,
      limit: 'none',
    });
    expect(summarize(sending([300_000, 50_000], 'cpu'), send, memory, 3000).limit).toBe('cpu');
    // The transport RTT wins over the receiver report's.
    const withPair = [
      ...sending([450_000, 75_000]),
      { id: 'p', type: 'candidate-pair', nominated: true, currentRoundTripTime: 0.015 },
    ];
    expect(summarize(withPair, send, memory, 4000).rttMs).toBe(15);
  });

  it('reads a received screen share with its loss and the connection RTT', () => {
    const memory: StatsMemory = new Map([['elif:TR_scr', { bytes: 0, at: 0 }]]);
    const s = summarize(
      [
        { id: 'c', type: 'codec', mimeType: 'video/VP9' },
        {
          id: 'i',
          type: 'inbound-rtp',
          codecId: 'c',
          frameWidth: 1920,
          frameHeight: 1080,
          framesPerSecond: 15,
          bytesReceived: 375_000,
          packetsReceived: 950,
          packetsLost: 50,
          jitter: 0.012,
        },
        { id: 'p', type: 'candidate-pair', nominated: true, currentRoundTripTime: 0.08 },
      ],
      {
        key: 'elif:TR_scr',
        direction: 'receive',
        participant: 'Elif',
        source: Track.Source.ScreenShare,
        kind: 'video',
      },
      memory,
      1000,
    );
    expect(s).toMatchObject({
      codec: 'VP9',
      width: 1920,
      fps: 15,
      bitrate: 3_000_000,
      lossPercent: 5,
      rttMs: 80,
      jitterMs: 12,
    });
  });

  it('says whether the network or the computer holds things back', () => {
    const row = (p: Partial<TrackStats>) => ({
      ...send,
      codec: null,
      width: null,
      height: null,
      fps: null,
      bitrate: null,
      lossPercent: null,
      rttMs: null,
      jitterMs: null,
      limit: null,
      jitterBufferMs: null,
      jitterBufferTargetMs: null,
      concealedPercent: null,
      sendDelayMs: null,
      path: null,
      ...p,
    });
    expect(diagnose([])).toBe('unknown');
    expect(diagnose([row({ lossPercent: 0.2, rttMs: 30, limit: 'none' })])).toBe('ok');
    expect(diagnose([row({ limit: 'cpu' })])).toBe('cpu');
    expect(diagnose([row({ lossPercent: 8 })])).toBe('network');
    expect(diagnose([row({ limit: 'bandwidth' })])).toBe('network');
    // A voice heard seconds late, or my packets queued before the network.
    expect(diagnose([row({ jitterBufferMs: 4800 })])).toBe('network');
    expect(diagnose([row({ sendDelayMs: 900 })])).toBe('network');
  });
});

/** One peer connection's transport, its pairs and candidates (no addresses kept). */
const transport = (selected: 'p1' | 'p2') => [
  { id: 'T', type: 'transport', selectedCandidatePairId: selected },
  {
    id: 'p1',
    type: 'candidate-pair',
    nominated: true,
    state: 'succeeded',
    localCandidateId: 'l1',
    remoteCandidateId: 'r1',
    currentRoundTripTime: 0.031,
    availableOutgoingBitrate: 2_400_000,
  },
  {
    id: 'p2',
    type: 'candidate-pair',
    nominated: true,
    state: 'succeeded',
    localCandidateId: 'l2',
    remoteCandidateId: 'r2',
    currentRoundTripTime: 0.9,
  },
  {
    id: 'l1',
    type: 'local-candidate',
    candidateType: 'host',
    protocol: 'udp',
    networkType: 'wifi',
    address: '10.0.0.2',
  },
  { id: 'r1', type: 'remote-candidate', candidateType: 'host', protocol: 'udp' },
  {
    id: 'l2',
    type: 'local-candidate',
    candidateType: 'relay',
    protocol: 'udp',
    relayProtocol: 'tls',
  },
  { id: 'r2', type: 'remote-candidate', candidateType: 'host', protocol: 'udp' },
];

describe('media path and audio delay', () => {
  it('takes the pair the transport selected, not just any nominated one', () => {
    expect(pathOf(transport('p1'))).toEqual({
      protocol: 'udp',
      local: 'host',
      remote: 'host',
      relayProtocol: null,
      networkType: 'wifi',
      rttMs: 31,
      outBitrate: 2_400_000,
    });
    const relayed = pathOf(transport('p2'));
    expect(relayed).toMatchObject({ local: 'relay', relayProtocol: 'tls', rttMs: 900 });
    expect(pathLabel(relayed)).toBe('udp relay/tls');
    expect(isDetour(relayed)).toBe(true);
    expect(isDetour(pathOf(transport('p1')))).toBe(false);
    expect(isDetour({ ...pathOf(transport('p1'))!, protocol: 'tcp' })).toBe(true);
    // Never an address in what is kept.
    expect(JSON.stringify(pathOf(transport('p1')))).not.toContain('10.0.0.2');
  });

  it('reads how long a received voice waits in the jitter buffer, per sample', () => {
    const memory: StatsMemory = new Map();
    const voice = {
      key: 'elif:TR_mic',
      direction: 'receive' as const,
      participant: 'Elif',
      source: Track.Source.Microphone,
      kind: 'audio' as const,
    };
    const inbound = (
      delay: number,
      target: number,
      emitted: number,
      concealed: number,
      total: number,
    ) => [
      ...transport('p1'),
      {
        id: 'i',
        type: 'inbound-rtp',
        kind: 'audio',
        bytesReceived: emitted,
        packetsReceived: 100,
        packetsLost: 0,
        jitter: 0.004,
        jitterBufferDelay: delay,
        jitterBufferTargetDelay: target,
        jitterBufferEmittedCount: emitted,
        concealedSamples: concealed,
        totalSamplesReceived: total,
      },
    ];
    // First sample: the average so far (60 ms over 48 000 samples).
    const first = summarize(inbound(2880, 2400, 48_000, 0, 48_000), voice, memory, 1000);
    expect(first).toMatchObject({ jitterBufferMs: 60, jitterBufferTargetMs: 50, rttMs: 31 });
    // Five seconds later the buffer holds 4.8 s: 240 000 samples emitted with 1 152 000 s of delay.
    const later = summarize(
      inbound(2880 + 1_152_000, 2400 + 1_152_000, 288_000, 24_000, 288_000),
      voice,
      memory,
      6000,
    );
    expect(later).toMatchObject({
      jitterBufferMs: 4800,
      jitterBufferTargetMs: 4800,
      concealedPercent: 10,
    });
  });

  it('reads how long my microphone packets wait before going out', () => {
    const memory: StatsMemory = new Map();
    const mic = {
      ...send,
      key: 'me:TR_mic',
      source: Track.Source.Microphone,
      kind: 'audio' as const,
    };
    const outbound = (delay: number, packets: number) => [
      ...transport('p1'),
      {
        id: 'o',
        type: 'outbound-rtp',
        kind: 'audio',
        bytesSent: packets * 60,
        packetsSent: packets,
        totalPacketSendDelay: delay,
      },
    ];
    expect(summarize(outbound(0.5, 100), mic, memory, 1000).sendDelayMs).toBeNull();
    // 250 packets waited 75 s in all: 300 ms each.
    expect(summarize(outbound(75.5, 350), mic, memory, 6000)).toMatchObject({
      sendDelayMs: 300,
      rttMs: 31,
      limit: null,
    });
  });
});
