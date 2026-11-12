import { Track, type Room } from 'livekit-client';

/**
 * "Bağlantı ayrıntıları": per track what WebRTC reports (getStats), so "bozuldu" can be told
 * apart: the network (loss, RTT, jitter, bandwidth limit), this computer (CPU limit, low fps) or
 * the server. Audio also says how long it waits: the receiver's jitter buffer (a voice heard
 * seconds late) and the sender's queue before the network.
 */

export type LimitReason = 'none' | 'cpu' | 'bandwidth' | 'other';

/**
 * The ICE candidate pair media goes over. UDP straight to the server is the normal case; TCP
 * (ICE/TCP) or a TURN relay over TCP/TLS can hold audio back behind lost or queued packets.
 * No addresses: only kinds and protocols.
 */
export interface MediaPath {
  /** The local candidate's transport: udp or tcp. */
  protocol: string | null;
  /** Local candidate type: host, srflx, prflx or relay. */
  local: string | null;
  /** Remote (server) candidate type. */
  remote: string | null;
  /** The leg to the TURN server when relayed: udp, tcp or tls. */
  relayProtocol: string | null;
  /** wifi, ethernet, cellular… when the browser says. */
  networkType: string | null;
  /** STUN round trip on this pair (consent checks, not the SFU's reports). */
  rttMs: number | null;
  /** The sender's bandwidth estimate for this connection. */
  outBitrate: number | null;
}

export interface TrackStats {
  key: string;
  direction: 'send' | 'receive';
  /** Who: "" for me. */
  participant: string;
  source: Track.Source;
  kind: 'audio' | 'video';
  codec: string | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  /** Bits per second since the previous sample (null on the first). */
  bitrate: number | null;
  /** Lost packets in percent of all since the start. */
  lossPercent: number | null;
  rttMs: number | null;
  jitterMs: number | null;
  /** Sending only: why the encoder holds back. */
  limit: LimitReason | null;
  /**
   * Receiving audio: how long sound waits in the jitter buffer before it is played, since the
   * previous sample (the average so far on the first). Normally 20-150 ms.
   */
  jitterBufferMs: number | null;
  /** Receiving audio: the delay the jitter buffer aims for. */
  jitterBufferTargetMs: number | null;
  /** Receiving audio: share of played samples that were made up (lost or late packets). */
  concealedPercent: number | null;
  /** Sending: how long packets waited in the sender's queue (pacer) since the previous sample. */
  sendDelayMs: number | null;
  path: MediaPath | null;
}

/** Counters of the previous sample per track, for rates. */
export type StatsMemory = Map<
  string,
  {
    bytes: number;
    at: number;
    jbDelay?: number;
    jbEmitted?: number;
    jbTarget?: number;
    concealed?: number;
    samples?: number;
    sendDelay?: number;
    packets?: number;
  }
>;

type Stat = Record<string, unknown> & { id: string; type: string; timestamp?: number };

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const ms = (seconds: number | null) => (seconds === null ? null : Math.round(seconds * 1000));

function codecOf(all: Map<string, Stat>, codecId: unknown): string | null {
  const c = typeof codecId === 'string' ? all.get(codecId) : undefined;
  const mime = typeof c?.mimeType === 'string' ? c.mimeType : null;
  return mime ? (mime.split('/')[1] ?? mime) : null;
}

/** Change of a counter per change of another since the previous sample; null without both. */
function perDelta(
  now: number | null,
  before: number | undefined,
  count: number | null,
  countBefore: number | undefined,
): number | null {
  if (now === null || count === null || before === undefined || countBefore === undefined) {
    return null;
  }
  const d = count - countBefore;
  return d > 0 && now >= before ? (now - before) / d : null;
}

function limitOf(v: unknown): LimitReason {
  return v === 'cpu' || v === 'bandwidth' || v === 'none' ? v : 'other';
}

/**
 * The candidate pair in use: the transport's selectedCandidatePairId (Chromium, Firefox), else a
 * pair flagged selected (old Firefox), else a nominated one that works.
 */
export function selectedPair(entries: Stat[]): Stat | undefined {
  const all = new Map(entries.map((e) => [e.id, e]));
  for (const t of entries) {
    if (t.type !== 'transport') continue;
    const id = str(t.selectedCandidatePairId);
    const pair = id ? all.get(id) : undefined;
    if (pair) return pair;
  }
  const pairs = entries.filter((e) => e.type === 'candidate-pair');
  return (
    pairs.find((e) => e.selected === true) ??
    pairs.find((e) => e.nominated === true && e.state === 'succeeded') ??
    pairs.find((e) => e.nominated === true)
  );
}

export function pathOf(entries: Stat[]): MediaPath | null {
  const pair = selectedPair(entries);
  if (!pair) return null;
  const all = new Map(entries.map((e) => [e.id, e]));
  const local = typeof pair.localCandidateId === 'string' ? all.get(pair.localCandidateId) : null;
  const remote =
    typeof pair.remoteCandidateId === 'string' ? all.get(pair.remoteCandidateId) : null;
  const out = num(pair.availableOutgoingBitrate);
  return {
    protocol: str(local?.protocol) ?? str(remote?.protocol),
    local: str(local?.candidateType),
    remote: str(remote?.candidateType),
    relayProtocol: str(local?.relayProtocol),
    networkType: str(local?.networkType),
    rttMs: ms(num(pair.currentRoundTripTime)),
    outBitrate: out === null ? null : Math.round(out),
  };
}

/** "udp host" / "tcp relay/tls": short, for logs. */
export function pathLabel(p: MediaPath | null): string {
  if (!p) return 'unknown';
  const relay = p.local === 'relay' && p.relayProtocol ? `/${p.relayProtocol}` : '';
  return `${p.protocol ?? '?'} ${p.local ?? '?'}${relay}`;
}

/** UDP straight or through NAT; anything over TCP or a relay can queue audio. */
export function isDetour(p: MediaPath | null): boolean {
  return Boolean(p && (p.protocol === 'tcp' || p.local === 'relay' || p.remote === 'relay'));
}

/**
 * One track's stats from its RTCStatsReport entries. Simulcast sends several outbound streams:
 * resolution and fps come from the largest, bitrate is their sum, the limit is the worst one.
 */
export function summarize(
  entries: Stat[],
  base: Pick<TrackStats, 'key' | 'direction' | 'participant' | 'source' | 'kind'>,
  memory: StatsMemory,
  now: number,
): TrackStats {
  const all = new Map(entries.map((e) => [e.id, e]));
  const prev = memory.get(base.key);
  const fresh = prev !== undefined && now > prev.at;
  const out: TrackStats = {
    ...base,
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
    path: pathOf(entries),
  };
  const pairRtt = out.path?.rttMs ?? null;
  const rate = (bytes: number) =>
    fresh && bytes >= prev.bytes
      ? Math.round(((bytes - prev.bytes) * 8 * 1000) / (now - prev.at))
      : null;

  if (base.direction === 'send') {
    const streams = entries.filter((e) => e.type === 'outbound-rtp');
    const top = [...streams].sort((a, b) => (num(b.frameWidth) ?? 0) - (num(a.frameWidth) ?? 0))[0];
    const bytes = streams.reduce((s, e) => s + (num(e.bytesSent) ?? 0), 0);
    const remote = entries.filter((e) => e.type === 'remote-inbound-rtp');
    const reasons = streams.map((e) => limitOf(e.qualityLimitationReason));
    const lost = remote.reduce((s, e) => s + (num(e.packetsLost) ?? 0), 0);
    const sent = streams.reduce((s, e) => s + (num(e.packetsSent) ?? 0), 0);
    const sendDelay = streams.some((e) => num(e.totalPacketSendDelay) !== null)
      ? streams.reduce((s, e) => s + (num(e.totalPacketSendDelay) ?? 0), 0)
      : null;
    // The transport's RTT (ICE candidate pair) first: the SFU's receiver reports carry RTT values
    // that can be seconds off.
    const rtt =
      pairRtt ?? ms(remote.map((e) => num(e.roundTripTime)).find((v) => v !== null) ?? null);
    const jitter = remote.map((e) => num(e.jitter)).find((v) => v !== null) ?? null;
    Object.assign(out, {
      codec: codecOf(all, top?.codecId),
      width: num(top?.frameWidth),
      height: num(top?.frameHeight),
      fps: num(top?.framesPerSecond),
      bitrate: streams.length ? rate(bytes) : null,
      lossPercent: sent > 0 && remote.length ? round1((lost / (sent + lost)) * 100) : null,
      rttMs: rtt,
      jitterMs: ms(jitter),
      limit: base.kind === 'video' && streams.length ? worst(reasons) : null,
      sendDelayMs: ms(fresh ? perDelta(sendDelay, prev.sendDelay, sent, prev.packets) : null),
    });
    memory.set(base.key, {
      bytes,
      at: now,
      ...(sendDelay !== null ? { sendDelay, packets: sent } : {}),
    });
  } else {
    const inbound = entries.find((e) => e.type === 'inbound-rtp');
    const lost = num(inbound?.packetsLost) ?? 0;
    const received = num(inbound?.packetsReceived) ?? 0;
    const jitter = num(inbound?.jitter);
    const bytes = num(inbound?.bytesReceived) ?? 0;
    const jbDelay = num(inbound?.jitterBufferDelay);
    const jbEmitted = num(inbound?.jitterBufferEmittedCount);
    const concealed = num(inbound?.concealedSamples);
    const samples = num(inbound?.totalSamplesReceived);
    const audio = base.kind === 'audio';
    // Since the previous sample when there is one, else the average so far.
    const buffered = fresh
      ? perDelta(jbDelay, prev.jbDelay, jbEmitted, prev.jbEmitted)
      : jbDelay !== null && jbEmitted
        ? jbDelay / jbEmitted
        : null;
    const target = num(inbound?.jitterBufferTargetDelay);
    const aimed = fresh
      ? perDelta(target, prev.jbTarget, jbEmitted, prev.jbEmitted)
      : target !== null && jbEmitted
        ? target / jbEmitted
        : null;
    const concealedShare = fresh
      ? perDelta(concealed, prev.concealed, samples, prev.samples)
      : null;
    Object.assign(out, {
      codec: codecOf(all, inbound?.codecId),
      width: num(inbound?.frameWidth),
      height: num(inbound?.frameHeight),
      fps: num(inbound?.framesPerSecond),
      bitrate: inbound ? rate(bytes) : null,
      lossPercent: received + lost > 0 ? round1((lost / (received + lost)) * 100) : null,
      rttMs: pairRtt,
      jitterMs: ms(jitter),
      jitterBufferMs: audio ? ms(buffered) : null,
      jitterBufferTargetMs: audio ? ms(aimed) : null,
      concealedPercent:
        audio && concealedShare !== null ? round1(Math.min(1, concealedShare) * 100) : null,
    });
    memory.set(base.key, {
      bytes,
      at: now,
      ...(jbDelay !== null && jbEmitted !== null ? { jbDelay, jbEmitted } : {}),
      ...(target !== null ? { jbTarget: target } : {}),
      ...(concealed !== null && samples !== null ? { concealed, samples } : {}),
    });
  }
  return out;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

function worst(reasons: LimitReason[]): LimitReason {
  for (const r of ['cpu', 'bandwidth', 'other'] as const) if (reasons.includes(r)) return r;
  return 'none';
}

interface StatsTrack {
  getRTCStatsReport?: () => Promise<RTCStatsReport | undefined>;
}

export interface CollectFilter {
  /** Only these kinds (both by default). */
  kinds?: readonly ('audio' | 'video')[];
}

/** Everything I send and receive right now. */
export async function collectStats(
  room: Room,
  memory: StatsMemory,
  { kinds }: CollectFilter = {},
): Promise<TrackStats[]> {
  const jobs: Promise<TrackStats | null>[] = [];
  const now = Date.now();
  const read = (
    track: StatsTrack | undefined,
    base: Pick<TrackStats, 'key' | 'direction' | 'participant' | 'source' | 'kind'>,
  ) => {
    if (!track?.getRTCStatsReport) return;
    if (kinds && !kinds.includes(base.kind)) return;
    jobs.push(
      track
        .getRTCStatsReport()
        .then((report) =>
          report ? summarize([...report.values()] as Stat[], base, memory, now) : null,
        )
        .catch(() => null),
    );
  };
  for (const pub of room.localParticipant.trackPublications.values()) {
    if (!pub.track || pub.isMuted) continue;
    read(pub.track as StatsTrack, {
      key: `me:${pub.trackSid}`,
      direction: 'send',
      participant: '',
      source: pub.source,
      kind: pub.kind === Track.Kind.Video ? 'video' : 'audio',
    });
  }
  for (const p of room.remoteParticipants.values()) {
    for (const pub of p.trackPublications.values()) {
      if (!pub.track || !pub.isSubscribed || pub.isMuted) continue;
      read(pub.track as StatsTrack, {
        key: `${p.identity}:${pub.trackSid}`,
        direction: 'receive',
        participant: p.name || p.identity,
        source: pub.source,
        kind: pub.kind === Track.Kind.Video ? 'video' : 'audio',
      });
    }
  }
  return (await Promise.all(jobs)).filter((s): s is TrackStats => s !== null);
}

/** The connection's path as any track reports it (one peer connection carries all of them). */
export function pathFrom(stats: TrackStats[]): MediaPath | null {
  return stats.find((s) => s.path)?.path ?? null;
}

/** One line for "bozuldu": what most likely holds things back. */
export function diagnose(stats: TrackStats[]): 'cpu' | 'network' | 'ok' | 'unknown' {
  if (!stats.length) return 'unknown';
  if (stats.some((s) => s.limit === 'cpu')) return 'cpu';
  const badNet = stats.some(
    (s) =>
      s.limit === 'bandwidth' ||
      (s.lossPercent ?? 0) >= 5 ||
      (s.rttMs ?? 0) >= 400 ||
      (s.jitterMs ?? 0) >= 50 ||
      (s.jitterBufferMs ?? 0) >= AUDIO_LATE_MS ||
      (s.sendDelayMs ?? 0) >= SEND_QUEUE_MS,
  );
  return badNet ? 'network' : 'ok';
}

/** Received audio waiting this long in the jitter buffer is heard noticeably late. */
export const AUDIO_LATE_MS = 400;
/** Packets waiting this long in the sender's queue: the uplink is too slow for what is sent. */
export const SEND_QUEUE_MS = 200;
